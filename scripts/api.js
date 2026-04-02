// api.js - Ollama API interaction

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

  // Build messages array with system prompt — only send role+content to API
  const messages = [
    { role: 'system', content: currentSystemPrompt },
    ...conversationHistory.map(m => ({ role: m.role, content: m.content }))
  ];

  try {
    const response = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: messages,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error('Ollama API request failed');
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
            // Render markdown in real-time
            contentDiv.innerHTML = marked.parse(fullResponse);

            // Auto-scroll
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

    // Update placeholder timestamp in DOM to match stored timestamp
    const tsElem = messageDiv.querySelector('.message-timestamp');
    if (tsElem) tsElem.innerText = assistantTsFmt;

    // Speak the response if auto-TTS is enabled
    if (document.getElementById('autoTTS').checked) {
      speakText(fullResponse);
    }

  } catch (error) {
    contentDiv.innerHTML = `<p style="color: #e53e3e;">Error: ${error.message}. Make sure Ollama is running with: <code>ollama serve</code></p>`;
  }
}