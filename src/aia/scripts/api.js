// api.js - Ollama API interaction

let streamAbortController = null;

function stopStreaming() {
  if (streamAbortController) streamAbortController.abort();
}

function setStreamingUI(isStreaming) {
  const sendBtn = document.getElementById('sendBtn');
  if (isStreaming) {
    sendBtn.disabled = true;
  } else {
    sendBtn.disabled = document.getElementById('userInput').value.trim().length === 0;
  }
  document.getElementById('stopBtn').style.display = isStreaming ? 'flex' : 'none';
}

async function streamOllamaResponse(userMessage, messageDiv) {
  const contentDiv = messageDiv.querySelector('.message-content');

  // fullResponse  — accumulates message.content tokens (the answer in both modes)
  // thinkingBuffer — accumulates message.thinking tokens (native Ollama thinking mode)
  //                  OR the pre-<|/think|> portion of message.content (inline token mode)
  let fullResponse = '';
  let thinkingBuffer = '';

  // inAnswerPhase / answerDiv — used during streaming to keep the <details> element
  // stable so user open/close actions survive repeated innerHTML writes to answerDiv.
  let inAnswerPhase = false;
  let answerDiv = null;

  // Add user message to conversation history (include timestamps)
  const userTsISO = new Date().toISOString();
  const userTsFmt = formatTimestamp(new Date());
  conversationHistory.push({
    role: 'user',
    content: userMessage,
    timestamp: userTsISO,
    formattedTimestamp: userTsFmt
  });

  // Update system prompt state after adding to history
  updateSystemPromptState();

  // Trim oldest pairs when history exceeds the context limit
  if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_MESSAGES);
    // Ensure history starts with a user message (no orphaned assistant reply)
    if (conversationHistory[0].role !== 'user') conversationHistory.splice(0, 1);
    addContextTrimNotice();
  }

  // CRITICAL: The <|think|> token triggers the reasoning process
  const thinkingToken = "<|think|>  ";

  // Build messages array with system prompt — only send role+content to API
  // The assistant prefill primes Gemma 4 to enter reasoning mode before answering.
  const messages = [
    { role: 'system', content: currentSystemPrompt },
    ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
    { role: 'assistant', content: thinkingToken }
  ];

  streamAbortController = new AbortController();
  setStreamingUI(true);

  try {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages,
        stream: true,
        options: { temperature: 1.0, top_p: 0.95, top_k: 64 }
      }),
      signal: streamAbortController.signal,
      redirect: 'manual'
    });

    // An opaque redirect means nginx intercepted the request and redirected
    // to /auth/login because the session has expired or the cookie is missing.
    if (response.type === 'opaqueredirect') {
      throw new Error('session-expired');
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Model "${MODEL_NAME}" not found — run: ollama pull ${MODEL_NAME}`);
      }
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

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

          // Native Ollama thinking mode: reasoning arrives in message.thinking,
          // the answer arrives separately in message.content.
          // Inline token mode: both arrive in message.content with <|/think|> boundary.
          const gotThinking = json.message.thinking;
          const gotContent = json.message.content;
          if (!gotThinking && !gotContent) continue;

          if (gotThinking) thinkingBuffer += json.message.thinking;
          if (gotContent) fullResponse += json.message.content;

          const { thinking: currentThinking, answer: currentAnswer } =
            splitThinkingContent(thinkingBuffer, fullResponse);
          const isAnswering = currentAnswer.length > 0;

          if (!isAnswering) {
            // Thinking phase — live-update rendered reasoning content.
            contentDiv.innerHTML =
              '<details class="thinking-block" open>' +
              '<summary aria-label="Toggle AI reasoning">Thinking…</summary>' +
              '<div class="thinking-content">' + DOMPurify.sanitize(marked.parse(currentThinking)) + '</div>' +
              '</details>';
          } else {
            if (!inAnswerPhase) {
              // Transition: build the stable two-part structure once so the <details>
              // element survives repeated innerHTML writes during answer streaming.
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

    // Derive final thinking text and answer from whichever mode was active.
    const { thinking: finalThinking, answer: savedContent } =
      splitThinkingContent(thinkingBuffer, fullResponse);

    // Rebuild final DOM: collapsed thinking block (if any) + rendered answer.
    // This is the authoritative render — overwrites whatever partial state the
    // streaming loop left behind.
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

    // Add assistant response to conversation history (include timestamps)
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
    if (error.name === 'AbortError' && (fullResponse || thinkingBuffer)) {
      // Derive partial answer and any completed thinking from whichever mode was active.
      const { thinking: abortThinking, answer: savedContent } =
        splitThinkingContent(thinkingBuffer, fullResponse);

      if (savedContent) {
        // Partial answer received before stop — save it so the conversation remains coherent.
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
        // Stopped during thinking phase — nothing useful to keep.
        conversationHistory.pop();
        contentDiv.innerHTML = '<p class="status-muted">Response stopped.</p>';
      }
    } else {
      // Nothing useful generated — roll back the user message entirely.
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
