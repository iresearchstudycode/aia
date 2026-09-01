// api.js - Ollama API interaction

let streamAbortController = null;

// Pure function: builds the Ollama /api/chat request body for a given turn.
// Extracted so it can be unit-tested in Node.js without a DOM or global state.
// Returns { requestBody, isVision, hasCurrentImage } — the flags are needed by
// the caller to choose stream vs non-stream paths and the abort handler.
// numCtx defaults to 16384, mirroring the OLLAMA_NUM_CTX fallback in config.js —
// callers should always pass a value explicitly; the default only exists so
// tests that don't care about num_ctx can omit it. The real call site passes
// `currentNumCtx` (config.js) = the active model's full advertised context
// window when known, else the OLLAMA_NUM_CTX fallback — see recomputeNumCtx() /
// resolveNumCtx(). This can be well above 16384; the Ollama server's own
// OLLAMA_CONTEXT_LENGTH is the effective cap.
function _buildRequestBody(imageBase64, history, systemPrompt, modelName, visionModelName, thinkingMode = 'off', numCtx = 16384) {
  // isVision: true when this message or any history entry contains an image.
  // hasCurrentImage: true only when a new image is attached to this specific message.
  // They differ on follow-ups: user asks a text question after an image turn —
  // isVision stays true (routes to gemma3), hasCurrentImage is false (stream:true).
  const isVision = detectVisionContext(imageBase64, history);
  const hasCurrentImage = !!imageBase64;

  // Thinking is only available for non-vision text requests and only when
  // enabled. The vision model (gemma3:4b) has no thinking capability.
  const thinkingEnabled = !isVision && thinkingMode !== 'off';

  // No assistant prefill. Ollama's `think` parameter (set below) makes every
  // thinking-capable model — gemma4:e4b, qwen3.x, deepseek-r1, … — return its
  // reasoning in a separate `message.thinking` field, cleanly split from the
  // answer in `message.content`. The old `<|think|>  ` prefill was a gemma-only
  // nudge from before Ollama supported this; on qwen3 it *breaks* the native
  // split (the assistant turn is "continued", so nothing separates) and the
  // whole reply lands in the thinking box. See splitThinkingContent (utils.js).
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => {
      const msg = { role: m.role, content: m.content };
      if (m.imageBase64) msg.images = [m.imageBase64];
      return msg;
    }),
  ];

  // Initial vision requests (hasCurrentImage) use stream:false — Ollama's streaming
  // path silently drops image tokens for GGUF models without vision encoders.
  // Follow-up text in an image conversation (isVision && !hasCurrentImage) streams
  // normally so the user sees tokens as they arrive.
  // Text-only requests always stream; sampling options applied regardless of thinking.
  const requestBody = {
    model: isVision ? visionModelName : modelName,
    messages,
    stream: !hasCurrentImage,
  };

  if (!isVision) {
    // think: false explicitly suppresses native reasoning in gemma4:e4b — omitting
    // the field is not enough because the model reasons by default.
    requestBody.think = thinkingEnabled;
    const options = { num_ctx: numCtx };

    // These sampling values are tuned for the Gemma models and are what Gemma's
    // own guidance recommends. Other thinking models (qwen3.x, deepseek-r1)
    // ship their own recommended sampling in their Modelfile — notably qwen3
    // wants top_k 20, not 64, and runs hot/repetitive at these values — so we
    // only override for Gemma and let every other model keep its own defaults.
    if (/^gemma/i.test(modelName)) {
      options.temperature = 1.0;
      options.top_p = 0.95;
      options.top_k = 64;
    }

    if (thinkingEnabled) {
      // Ollama exposes no real "thinking budget": the old options.thinking_budget
      // was a Gemini/Anthropic concept that Ollama silently drops, and the
      // think:"low"|"high" string levels are ignored by the qwen3.x / deepseek
      // parsers (verified: byte-identical output at a fixed seed). num_predict is
      // the only lever that actually bites — it caps TOTAL generated tokens
      // (reasoning + answer). We use it as a generous safety ceiling, not a tight
      // budget: a normal-length reply never reaches it, but a runaway reasoner
      // (or an outright loop) is force-stopped in minutes instead of grinding to
      // the full context window. High is deliberately uncapped.
      const predictMap = { low: 4096, medium: 8192 };
      if (predictMap[thinkingMode] !== undefined) {
        options.num_predict = predictMap[thinkingMode];
      }
    }
    requestBody.options = options;
  } else if (!hasCurrentImage) {
    // num_ctx hint prevents Ollama from silently truncating a multi-turn vision
    // conversation to its own (possibly smaller) default context length.
    requestBody.options = { num_ctx: numCtx };
  }

  return { requestBody, isVision, hasCurrentImage };
}

// Node.js compat export — lets Jest import _buildRequestBody for unit tests.
if (typeof module !== 'undefined') module.exports = { _buildRequestBody };

function stopStreaming() {
  if (streamAbortController) streamAbortController.abort();
}

// True when a completed reply on this turn should be rendered as an English
// Editor exchange (polished text + Original/Changes/Clean view switch): the
// English Editor persona is active, the output mode is 'clean' or 'changes'
// (never 'explain' — that reply is prose + revision, not pure revised text),
// and the turn carries no document attachment. Image turns are excluded by the
// caller (they take the non-streaming vision path).
function _isEditorExchangeTurn(userMessage) {
  // The active persona is the English Editor when the resolved system prompt is
  // its silent variant. `explain` mode resolves to `englishEditorExplained`
  // instead, and is additionally excluded by the editor-mode check below.
  if (currentSystemPrompt !== systemPrompts.englishEditor) return false;
  if (currentEditorMode !== 'clean' && currentEditorMode !== 'changes') return false;
  if (parseDocumentMessageContent(userMessage).hasDocument) return false;
  return true;
}

function setStreamingUI(isStreaming) {
  const sendBtn = document.getElementById('sendBtn');
  if (isStreaming) {
    sendBtn.disabled = true;
  } else {
    sendBtn.disabled = document.getElementById('userInput').value.trim().length === 0 && !pendingImageBase64;
  }
  document.getElementById('stopBtn').style.display = isStreaming ? 'flex' : 'none';
}

async function streamOllamaResponse(
  userMessage, messageDiv, imageBase64 = null, imageDataUrl = null, consultTemplate = null
) {
  const contentDiv = messageDiv.querySelector('.message-content');

  // fullResponse  — accumulates message.content tokens (streaming text path only)
  // thinkingBuffer — accumulates message.thinking tokens (streaming text path only)
  let fullResponse = '';
  let thinkingBuffer = '';

  // inAnswerPhase / answerDiv — keeps the <details> element stable during streaming
  let inAnswerPhase = false;
  let answerDiv = null;

  // Progress tracking for the "Thinking…" indicator. A large model can spend
  // 30–60s loading + tens of seconds reasoning before the first answer token —
  // without a visible elapsed time / token count that reads as a frozen UI.
  const requestStartMs = Date.now();
  let firstChunkSeen = false;
  let thinkingTokenApprox = 0; // ~1 streamed thinking chunk per token
  let doneReason = null;       // 'stop' | 'length' | … from the final stream chunk
  let loadingTimer = null;

  // "Thinking… 12s · ~340 tokens" — trailing meta is our own static markup
  // (integers only), never model content, so it is safe to inline as HTML.
  const thinkingLabel = (settled) => {
    const secs = Math.round((Date.now() - requestStartMs) / 1000);
    const meta = secs + 's' + (thinkingTokenApprox ? ' · ~' + thinkingTokenApprox + ' tokens' : '');
    return (settled ? 'Thinking' : 'Thinking…') + ' <span class="thinking-meta">' + meta + '</span>';
  };

  // Add user message to conversation history
  const userTsISO = new Date().toISOString();
  const userTsFmt = formatTimestamp(new Date());
  const userHistoryEntry = {
    role: 'user',
    content: userMessage,
    timestamp: userTsISO,
    formattedTimestamp: userTsFmt
  };
  if (imageBase64) {
    userHistoryEntry.imageBase64 = imageBase64;
    userHistoryEntry.imageDataUrl = imageDataUrl;
    userHistoryEntry.hasImage = true;
  }
  conversationHistory.push(userHistoryEntry);

  updateSystemPromptState();

  // Trim oldest pairs when history exceeds the context limit
  if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_MESSAGES);
    if (conversationHistory[0].role !== 'user') conversationHistory.splice(0, 1);
    addContextTrimNotice();
  }

  const _numCtx = typeof currentNumCtx === 'number' && currentNumCtx > 0 ? currentNumCtx : OLLAMA_NUM_CTX;
  const { requestBody, isVision, hasCurrentImage } = _buildRequestBody(
    imageBase64, conversationHistory, currentSystemPrompt, currentModel, currentVisionModel, currentThinkingMode, _numCtx
  );
  // Captured once so all three render sites (live loop, final, abort) agree on whether
  // thinking is active for this request. When false, splitThinkingContent is bypassed
  // entirely and message.content renders directly as the answer.
  const thinkingActive = !isVision && currentThinkingMode !== 'off';

  // Editor-exchange rendering is mutually exclusive with the thinking-block UI
  // (an editor reply is meant to be just the polished text) — gate on
  // !thinkingActive so a <details> block and the diff view never mix.
  const isEditorExchange = !isVision && !thinkingActive && _isEditorExchangeTurn(userMessage);

  // A Consultant analysis turn (template picked from the composer menu) — the
  // completed reply is rendered as a SWOT / pros-cons grid when it parses.
  // Mutually exclusive with the thinking-block UI and the editor path, same as
  // isEditorExchange. `consultSections` non-null (parsed after streaming) gates
  // the tag + custom render.
  const consultTurn =
    !isVision &&
    !thinkingActive &&
    !isEditorExchange &&
    !!consultTemplate &&
    typeof _currentPersonaKey === 'function' &&
    _currentPersonaKey() === 'professional';
  let consultSections = null;

  streamAbortController = new AbortController();
  setStreamingUI(true);

  // If nothing has come back after a few seconds, say so — the usual cause is a
  // cold model being loaded into memory, which the stream gives no signal for.
  loadingTimer = setTimeout(() => {
    if (!firstChunkSeen) {
      contentDiv.innerHTML =
        '<p class="status-muted">Loading model… '
        + '<span class="status-hint">the first reply from a large model can take 30–60s</span></p>';
    }
  }, 4000);

  try {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: streamAbortController.signal,
      redirect: 'manual'
    });

    if (response.type === 'opaqueredirect') {
      throw new Error('session-expired');
    }

    if (!response.ok) {
      if (response.status === 404) {
        const m = requestBody.model;
        throw new Error(`Model "${m}" not found — run: ollama pull ${m}`);
      }
      let detail = '';
      try {
        const body = await response.json();
        if (body && body.error) detail = `: ${body.error}`;
      } catch { /* ignore parse failures */ }
      throw new Error(`Ollama returned HTTP ${response.status}${detail}`);
    }

    let savedContent = '';

    if (hasCurrentImage) {
      // ---------------------------------------------------------------
      // Non-streaming vision path: single JSON response object.
      // ---------------------------------------------------------------
      const data = await response.json();
      savedContent = (data.message && data.message.content) || '';
      const answerHtml = renderMarkdownToHtml(savedContent);
      contentDiv.innerHTML = answerHtml || '<p class="status-muted">No response received.</p>';
      if (answerHtml) {
        enrichRenderedContent(contentDiv);
        _addMarkdownCopyBtn(contentDiv, savedContent);
      }

    } else {
      // ---------------------------------------------------------------
      // Streaming text path: newline-delimited JSON chunks.
      // ---------------------------------------------------------------
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            if (json.done && json.done_reason) doneReason = json.done_reason;
            if (!json.message) continue;

            const gotThinking = json.message.thinking;
            const gotContent = json.message.content;
            if (!gotThinking && !gotContent) continue;

            firstChunkSeen = true;
            if (gotThinking) {
              thinkingBuffer += json.message.thinking;
              thinkingTokenApprox += 1;
            }
            if (gotContent) fullResponse += json.message.content;

            if (!thinkingActive) {
              contentDiv.innerHTML = renderMarkdownToHtml(fullResponse);
            } else {
              const { thinking: currentThinking, answer: currentAnswer } =
                splitThinkingContent(thinkingBuffer, fullResponse);
              const isAnswering = currentAnswer.length > 0;

              if (!isAnswering) {
                contentDiv.innerHTML =
                  '<details class="thinking-block" open>' +
                  '<summary aria-label="Toggle AI reasoning">' + thinkingLabel(false) + '</summary>' +
                  '<div class="thinking-content">' + renderMarkdownToHtml(currentThinking) + '</div>' +
                  '</details>';
              } else {
                if (!inAnswerPhase) {
                  inAnswerPhase = true;
                  contentDiv.innerHTML = (currentThinking
                    ? '<details class="thinking-block" open>' +
                      '<summary aria-label="Toggle AI reasoning">' + thinkingLabel(true) + '</summary>' +
                      '<div class="thinking-content">' + renderMarkdownToHtml(currentThinking) + '</div>' +
                      '</details>'
                    : '') + '<div class="answer-content"></div>';
                  answerDiv = contentDiv.querySelector('.answer-content');
                }
                if (answerDiv) answerDiv.innerHTML = renderMarkdownToHtml(currentAnswer);
              }
            }

            document.getElementById('chatMessages').scrollTop =
              document.getElementById('chatMessages').scrollHeight;
          } catch (e) {
            console.error('Error parsing JSON:', e);
          }
        }
      }

      let finalThinking = '';
      if (thinkingActive) {
        const split = splitThinkingContent(thinkingBuffer, fullResponse);
        finalThinking = split.thinking;
        savedContent = split.answer;
      } else {
        savedContent = fullResponse;
      }

      // The reasoning-effort ceiling (options.num_predict) was hit before the
      // model produced an answer — say so rather than showing an empty bubble.
      const hitReasoningCap = doneReason === 'length';
      const capNote = hitReasoningCap
        ? '<p class="status-stopped">Reasoning-effort limit reached'
          + (savedContent ? ' — answer may be cut off.' : ' before an answer was produced. Try a lower reasoning effort, a simpler question, or a smaller model.')
          + '</p>'
        : '';

      if (consultTurn) consultSections = parseConsultReply(savedContent, consultTemplate);

      if (isEditorExchange) {
        // Polished text + Original/Changes/Clean switch, diffed against the
        // user's just-sent text. The raw model output is still stored verbatim
        // in conversationHistory below; the diff is always derived, never stored.
        renderEditorReply(contentDiv, userMessage, savedContent, currentEditorMode);
      } else if (consultSections) {
        // SWOT / pros-cons grid + Structured/Text switch. Raw model output is
        // stored verbatim below; the section split is always re-derived.
        renderConsultReply(contentDiv, savedContent, consultTemplate, currentConsultView);
      } else if (finalThinking) {
        contentDiv.innerHTML =
          '<details class="thinking-block">' +
          '<summary aria-label="Toggle AI reasoning">' + thinkingLabel(true) + '</summary>' +
          '<div class="thinking-content">' + renderMarkdownToHtml(finalThinking) + '</div>' +
          '</details>' +
          '<div class="answer-content">' + renderMarkdownToHtml(savedContent) + capNote + '</div>';
        enrichRenderedContent(contentDiv);
        _addMarkdownCopyBtn(contentDiv, savedContent);
      } else {
        contentDiv.innerHTML = renderMarkdownToHtml(savedContent);
        enrichRenderedContent(contentDiv);
        _addMarkdownCopyBtn(contentDiv, savedContent);
      }
    }

    // -------------------------------------------------------------------
    // Common post-request processing (both vision and text paths)
    // -------------------------------------------------------------------
    const assistantTsISO = new Date().toISOString();
    const assistantTsFmt = formatTimestamp(new Date());
    const assistantEntry = {
      role: 'assistant',
      content: savedContent,
      timestamp: assistantTsISO,
      formattedTimestamp: assistantTsFmt
    };
    if (isEditorExchange) {
      assistantEntry.editorExchange = true;
      assistantEntry.editorView = currentEditorMode; // 'clean' | 'changes'
    }
    if (consultSections) {
      assistantEntry.consultArtifact = consultTemplate; // 'swot' | 'proscons'
      assistantEntry.consultView = currentConsultView; // 'structured' | 'text'
    }
    conversationHistory.push(assistantEntry);

    const tsElem = messageDiv.querySelector('.message-timestamp');
    if (tsElem) tsElem.textContent = assistantTsFmt;

    // Copy/speak act on the clean revised text (savedContent), never the diff
    // markup or the original — same as any other reply.
    const copyBtn = messageDiv.querySelector('.copy-btn');
    if (copyBtn) copyBtn.dataset.content = savedContent;
    const speakBtn = messageDiv.querySelector('.speak-btn');
    if (speakBtn) speakBtn.dataset.content = savedContent;
    const actionsDiv = messageDiv.querySelector('.message-actions');
    if (actionsDiv) actionsDiv.style.display = '';
    if (typeof _refreshTurnControls === 'function') _refreshTurnControls();
    if (typeof hcTouchCurrent === 'function') hcTouchCurrent();
    if (isEditorExchange && actionsDiv) {
      actionsDiv.appendChild(
        _buildEditorViewSwitch(assistantEntry, contentDiv, userMessage, savedContent)
      );
    }
    if (consultSections && actionsDiv) {
      actionsDiv.appendChild(
        _buildConsultViewSwitch(assistantEntry, contentDiv, savedContent)
      );
    }

    // Auto-speak the reply when enabled in Settings (global `auto_speak`).
    if (window.vpalSettings && window.vpalSettings.global && window.vpalSettings.global.auto_speak) {
      speakText(savedContent);
    }

  } catch (error) {
    if (error.name === 'AbortError' && !hasCurrentImage && (fullResponse || thinkingBuffer)) {
      // Streaming abort with partial content — preserve what was generated.
      let abortThinking = '';
      let savedContent;
      if (thinkingActive) {
        const split = splitThinkingContent(thinkingBuffer, fullResponse);
        abortThinking = split.thinking;
        savedContent = split.answer;
      } else {
        savedContent = fullResponse;
      }

      if (savedContent) {
        conversationHistory.push({
          role: 'assistant',
          content: savedContent,
          timestamp: new Date().toISOString(),
          formattedTimestamp: formatTimestamp(new Date())
        });
        const partialHtml = renderMarkdownToHtml(savedContent) +
          '<p class="status-stopped">[response stopped]</p>';
        if (abortThinking) {
          contentDiv.innerHTML =
            '<details class="thinking-block">' +
            '<summary aria-label="Toggle AI reasoning">' + thinkingLabel(true) + '</summary>' +
            '<div class="thinking-content">' + renderMarkdownToHtml(abortThinking) + '</div>' +
            '</details>' +
            '<div class="answer-content">' + partialHtml + '</div>';
        } else {
          contentDiv.innerHTML = partialHtml;
        }
        enrichRenderedContent(contentDiv);
        _addMarkdownCopyBtn(contentDiv, savedContent);
        const copyBtn = messageDiv.querySelector('.copy-btn');
        if (copyBtn) copyBtn.dataset.content = savedContent;
        const speakBtn = messageDiv.querySelector('.speak-btn');
        if (speakBtn) speakBtn.dataset.content = savedContent;
        if (typeof _refreshTurnControls === 'function') _refreshTurnControls();
        if (typeof hcTouchCurrent === 'function') hcTouchCurrent();
      } else {
        conversationHistory.pop();
        contentDiv.innerHTML = '<p class="status-muted">Response stopped.</p>';
      }
    } else {
      // For vision aborts the user entry is legitimate (they did send the message
      // with an image); keep it so history stays in sync with the DOM. For all
      // other no-content aborts pop the entry — nothing was generated.
      if (!(error.name === 'AbortError' && hasCurrentImage)) {
        conversationHistory.pop();
      }
      if (error.name === 'AbortError') {
        contentDiv.innerHTML = '<p class="status-muted">Response stopped.</p>';
      } else if (error.message === 'session-expired') {
        contentDiv.innerHTML = '<p class="status-error">Session expired — please <a href="/auth/login">sign in again</a>.</p>';
      } else if (error.message.includes('Failed to fetch')) {
        contentDiv.innerHTML = `<p class="status-error">Cannot reach Ollama — run: <code>ollama serve</code></p>`;
      } else {
        contentDiv.innerHTML = `<p class="status-error">${escapeHtml(error.message)}</p>`;
      }
      const actionsDiv = messageDiv.querySelector('.message-actions');
      if (actionsDiv) actionsDiv.style.display = 'none';
    }
    updateSystemPromptState();
  } finally {
    clearTimeout(loadingTimer);
    streamAbortController = null;
    setStreamingUI(false);
    // Now that the Stop button is hidden, (re)surface the rewind controls on
    // the final turn — this is the call that actually adds the Edit & resend
    // button, since the in-try hooks above run while the stream UI is still up.
    if (typeof _refreshTurnControls === 'function') _refreshTurnControls();
    if (typeof hcTouchCurrent === 'function') hcTouchCurrent();
  }
}
