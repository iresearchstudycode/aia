// api.js - Ollama API interaction

let streamAbortController = null;

function stopStreaming() {
  if (streamAbortController) streamAbortController.abort();
}

function setStreamingUI(isStreaming) {
  document.getElementById('sendBtn').disabled = isStreaming;
  document.getElementById('stopBtn').style.display = isStreaming ? 'inline-block' : 'none';
}

async function streamOllamaResponse(userMessage, messageDiv) {
  const contentDiv = messageDiv.querySelector('.message-content');
  let fullResponse = '';

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

  // Build messages array with system prompt — only send role+content to API
  const messages = [
    { role: 'system', content: currentSystemPrompt },
    ...conversationHistory.map(m => ({ role: m.role, content: m.content }))
  ];

  streamAbortController = new AbortController();
  setStreamingUI(true);

  try {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, messages, stream: true }),
      signal: streamAbortController.signal
    });

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
          if (json.message && json.message.content) {
            fullResponse += json.message.content;
            contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(fullResponse));
            const messagesDiv = document.getElementById('chatMessages');
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
          }
        } catch (e) {
          console.error('Error parsing JSON:', e);
        }
      }
    }

    // Add assistant response to conversation history (include timestamps)
    const assistantTsISO = new Date().toISOString();
    const assistantTsFmt = formatTimestamp(new Date());
    conversationHistory.push({
      role: 'assistant',
      content: fullResponse,
      timestamp: assistantTsISO,
      formattedTimestamp: assistantTsFmt
    });

    const tsElem = messageDiv.querySelector('.message-timestamp');
    if (tsElem) tsElem.textContent = assistantTsFmt;

    if (document.getElementById('autoTTS').checked) {
      speakText(fullResponse);
    }

  } catch (error) {
    if (error.name === 'AbortError' && fullResponse) {
      // Partial content received before stop — save it so the conversation remains coherent.
      // The user message is already in history; add the truncated assistant reply.
      conversationHistory.push({
        role: 'assistant',
        content: fullResponse,
        timestamp: new Date().toISOString(),
        formattedTimestamp: formatTimestamp(new Date())
      });
      contentDiv.innerHTML =
        DOMPurify.sanitize(marked.parse(fullResponse)) +
        '<p class="status-stopped">[response stopped]</p>';
    } else {
      // Nothing useful generated — roll back the user message entirely.
      conversationHistory.pop();
      if (error.name === 'AbortError') {
        contentDiv.innerHTML = '<p class="status-muted">Response stopped.</p>';
      } else if (error.message.includes('Failed to fetch')) {
        contentDiv.innerHTML = `<p class="status-error">Cannot reach Ollama — run: <code>ollama serve</code></p>`;
      } else {
        contentDiv.innerHTML = `<p class="status-error">${escapeHtml(error.message)}</p>`;
      }
    }
    updateSystemPromptState();
  } finally {
    streamAbortController = null;
    setStreamingUI(false);
  }
}