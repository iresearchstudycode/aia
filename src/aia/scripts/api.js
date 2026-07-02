// api.js - Ollama API interaction

let streamAbortController = null;

// Pure function: builds the Ollama /api/chat request body for a given turn.
// Extracted so it can be unit-tested in Node.js without a DOM or global state.
// Returns { requestBody, isVision, hasCurrentImage } — the flags are needed by
// the caller to choose stream vs non-stream paths and the abort handler.
function _buildRequestBody(imageBase64, history, systemPrompt, modelName, visionModelName, thinkingMode = 'off') {
  const thinkingToken = "<|think|>  ";

  // isVision: true when this message or any history entry contains an image.
  // hasCurrentImage: true only when a new image is attached to this specific message.
  // They differ on follow-ups: user asks a text question after an image turn —
  // isVision stays true (routes to gemma3), hasCurrentImage is false (stream:true).
  const isVision = detectVisionContext(imageBase64, history);
  const hasCurrentImage = !!imageBase64;

  // Thinking is only available for non-vision text requests and only when enabled.
  // Vision uses gemma3:4b which has no thinking capability, and Ollama rejects an
  // assistant prefill on any request that carries images.
  const thinkingEnabled = !isVision && thinkingMode !== 'off';

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => {
      const msg = { role: m.role, content: m.content };
      if (m.imageBase64) msg.images = [m.imageBase64];
      return msg;
    }),
  ];
  if (thinkingEnabled) {
    messages.push({ role: 'assistant', content: thinkingToken });
  }

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
    const options = { temperature: 1.0, top_p: 0.95, top_k: 64 };
    if (thinkingEnabled) {
      // Low/Medium cap the thinking budget; High lets the model reason without limit.
      const budgetMap = { low: 1024, medium: 4096 };
      if (budgetMap[thinkingMode] !== undefined) {
        options.thinking_budget = budgetMap[thinkingMode];
      }
    }
    requestBody.options = options;
  } else if (!hasCurrentImage) {
    requestBody.options = { num_ctx: 8192 };
  }

  return { requestBody, isVision, hasCurrentImage };
}

// Node.js compat export — lets Jest import _buildRequestBody for unit tests.
if (typeof module !== 'undefined') module.exports = { _buildRequestBody };

function stopStreaming() {
  if (streamAbortController) streamAbortController.abort();
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

async function streamOllamaResponse(userMessage, messageDiv, imageBase64 = null, imageDataUrl = null) {
  const contentDiv = messageDiv.querySelector('.message-content');

  // fullResponse  — accumulates message.content tokens (streaming text path only)
  // thinkingBuffer — accumulates message.thinking tokens (streaming text path only)
  let fullResponse = '';
  let thinkingBuffer = '';

  // inAnswerPhase / answerDiv — keeps the <details> element stable during streaming
  let inAnswerPhase = false;
  let answerDiv = null;

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

  const { requestBody, hasCurrentImage } = _buildRequestBody(
    imageBase64, conversationHistory, currentSystemPrompt, MODEL_NAME, VISION_MODEL_NAME, currentThinkingMode
  );

  streamAbortController = new AbortController();
  setStreamingUI(true);

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
      const answerHtml = DOMPurify.sanitize(marked.parse(savedContent));
      contentDiv.innerHTML = answerHtml || '<p class="status-muted">No response received.</p>';

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
            if (!json.message) continue;

            const gotThinking = json.message.thinking;
            const gotContent = json.message.content;
            if (!gotThinking && !gotContent) continue;

            if (gotThinking) thinkingBuffer += json.message.thinking;
            if (gotContent) fullResponse += json.message.content;

            const { thinking: currentThinking, answer: currentAnswer } =
              splitThinkingContent(thinkingBuffer, fullResponse);
            const isAnswering = currentAnswer.length > 0;

            if (!isAnswering) {
              contentDiv.innerHTML =
                '<details class="thinking-block" open>' +
                '<summary aria-label="Toggle AI reasoning">Thinking…</summary>' +
                '<div class="thinking-content">' + DOMPurify.sanitize(marked.parse(currentThinking)) + '</div>' +
                '</details>';
            } else {
              if (!inAnswerPhase) {
                inAnswerPhase = true;
                contentDiv.innerHTML =
                  '<details class="thinking-block" open>' +
                  '<summary aria-label="Toggle AI reasoning">Thinking…</summary>' +
                  '<div class="thinking-content">' + DOMPurify.sanitize(marked.parse(currentThinking)) + '</div>' +
                  '</details>' +
                  '<div class="answer-content"></div>';
                answerDiv = contentDiv.querySelector('.answer-content');
              }
              if (answerDiv) answerDiv.innerHTML = DOMPurify.sanitize(marked.parse(currentAnswer));
            }

            document.getElementById('chatMessages').scrollTop =
              document.getElementById('chatMessages').scrollHeight;
          } catch (e) {
            console.error('Error parsing JSON:', e);
          }
        }
      }

      const { thinking: finalThinking, answer: streamedContent } =
        splitThinkingContent(thinkingBuffer, fullResponse);
      savedContent = streamedContent;

      const answerHtml = DOMPurify.sanitize(marked.parse(savedContent));
      if (finalThinking) {
        contentDiv.innerHTML =
          '<details class="thinking-block">' +
          '<summary aria-label="Toggle AI reasoning">Thinking</summary>' +
          '<div class="thinking-content">' + DOMPurify.sanitize(marked.parse(finalThinking)) + '</div>' +
          '</details>' +
          '<div class="answer-content">' + answerHtml + '</div>';
      } else {
        contentDiv.innerHTML = answerHtml;
      }
    }

    // -------------------------------------------------------------------
    // Common post-request processing (both vision and text paths)
    // -------------------------------------------------------------------
    const assistantTsISO = new Date().toISOString();
    const assistantTsFmt = formatTimestamp(new Date());
    conversationHistory.push({
      role: 'assistant',
      content: savedContent,
      timestamp: assistantTsISO,
      formattedTimestamp: assistantTsFmt
    });

    const tsElem = messageDiv.querySelector('.message-timestamp');
    if (tsElem) tsElem.textContent = assistantTsFmt;

    const copyBtn = messageDiv.querySelector('.copy-btn');
    if (copyBtn) copyBtn.dataset.content = savedContent;
    const speakBtn = messageDiv.querySelector('.speak-btn');
    if (speakBtn) speakBtn.dataset.content = savedContent;
    const actionsDiv = messageDiv.querySelector('.message-actions');
    if (actionsDiv) actionsDiv.style.display = '';

    if (document.getElementById('autoTTSBtn').classList.contains('tts-on')) {
      speakText(savedContent);
    }

  } catch (error) {
    if (error.name === 'AbortError' && !hasCurrentImage && (fullResponse || thinkingBuffer)) {
      // Streaming abort with partial content — preserve what was generated.
      const { thinking: abortThinking, answer: savedContent } =
        splitThinkingContent(thinkingBuffer, fullResponse);

      if (savedContent) {
        conversationHistory.push({
          role: 'assistant',
          content: savedContent,
          timestamp: new Date().toISOString(),
          formattedTimestamp: formatTimestamp(new Date())
        });
        const partialHtml = DOMPurify.sanitize(marked.parse(savedContent)) +
          '<p class="status-stopped">[response stopped]</p>';
        if (abortThinking) {
          contentDiv.innerHTML =
            '<details class="thinking-block">' +
            '<summary aria-label="Toggle AI reasoning">Thinking</summary>' +
            '<div class="thinking-content">' + DOMPurify.sanitize(marked.parse(abortThinking)) + '</div>' +
            '</details>' +
            '<div class="answer-content">' + partialHtml + '</div>';
        } else {
          contentDiv.innerHTML = partialHtml;
        }
        const copyBtn = messageDiv.querySelector('.copy-btn');
        if (copyBtn) copyBtn.dataset.content = savedContent;
        const speakBtn = messageDiv.querySelector('.speak-btn');
        if (speakBtn) speakBtn.dataset.content = savedContent;
      } else {
        conversationHistory.pop();
        contentDiv.innerHTML = '<p class="status-muted">Response stopped.</p>';
      }
    } else {
      conversationHistory.pop();
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
    streamAbortController = null;
    setStreamingUI(false);
  }
}
