// chat.js - Chat message handling functions

function updateSystemPromptState() {
  const select = document.getElementById('systemPromptSelect');
  if (conversationHistory.length > 0) {
    select.disabled = true;
  } else {
    select.disabled = false;
  }
}

// Function to add messages
function addUserMessage(text) {
  const messagesDiv = document.getElementById('chatMessages');
  const timestamp = formatTimestamp(new Date());
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message user-message';
  messageDiv.innerHTML = `
      <div class="message-label">You</div>
      <div class="message-content">
        <p>${escapeHtml(text)}</p>
      </div>
      <div class="message-timestamp">${timestamp}</div>
    `;
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function addAIMessagePlaceholder() {
  const messagesDiv = document.getElementById('chatMessages');
  const timestamp = formatTimestamp(new Date());
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message ai-message';
  messageDiv.innerHTML = `
      <div class="message-label">AI Assistant</div>
      <div class="message-content">
        <p class="status-muted">Thinking...</p>
      </div>
      <div class="message-timestamp">${timestamp}</div>
    `;
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  return messageDiv;
}


function addContextTrimNotice() {
  const messagesDiv = document.getElementById('chatMessages');
  const notice = document.createElement('div');
  notice.className = 'context-trim-notice';
  notice.textContent = 'Earlier messages removed from context window';
  messagesDiv.appendChild(notice);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Clear chat function
function clearChat() {
  if (confirm('Are you sure you want to clear the chat history?')) {
    stopSpeaking(); // Stop any ongoing speech (this will resume recognition if needed)
    conversationHistory = [];
    document.getElementById('chatMessages').innerHTML = '';
    updateSystemPromptState(); // Re-enable system prompt selector
  }
}

// Close window function
function closeWindow() {
  if (confirm('Are you sure you want to close this window?')) {
    // Stop any ongoing speech and recognition
    stopSpeaking();
    if (isRecording) {
      recognition.stop();
      isRecording = false;
    }

    // Attempt to close the window
    window.close();

    // If window.close() doesn't work (some browsers block it), show a message
    setTimeout(() => {
      alert('Please close this window manually using your browser controls.');
    }, 100);
  }
}

// Update system prompt
function updateSystemPrompt() {
  const select = document.getElementById('systemPromptSelect');
  currentSystemPrompt = systemPrompts[select.value];

  // If conversation has started, warn user
  if (conversationHistory.length > 0) {
    if (confirm('Changing the system prompt will reset the conversation. Continue?')) {
      conversationHistory = [];
      document.getElementById('chatMessages').innerHTML = '';
      updateSystemPromptState(); // Update state after clearing
    } else {
      // Revert selection
      select.value = Object.keys(systemPrompts).find(key => systemPrompts[key] === currentSystemPrompt);
    }
  }
}

// Send message and continue listening (for voice mode)
async function sendMessageAndContinueListening() {
  const input = document.getElementById('userInput');
  const message = input.value.trim();

  if (message) {
    // Clear the accumulated transcript for next input, but keep listening
    accumulatedTranscript = '';
    input.value = '';

    addUserMessage(message);

    // Add a placeholder for AI response
    const aiMessageDiv = addAIMessagePlaceholder();

    // Call Ollama API (this will update conversationHistory and system prompt state)
    await streamOllamaResponse(message, aiMessageDiv);

    // Microphone stays active - user can continue speaking
  }
}

// Send message function
async function sendMessage() {
  const input = document.getElementById('userInput');
  const message = input.value.trim();

  if (message) {
    // If triggered manually (not by voice), stop recording if active
    if (isRecording) {
      recognition.stop();
      isRecording = false;
      document.getElementById('micBtn').classList.remove('recording');
      document.getElementById('micBtn').classList.remove('paused');
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      accumulatedTranscript = '';
    }

    addUserMessage(message);
    input.value = '';

    // Add a placeholder for AI response
    const aiMessageDiv = addAIMessagePlaceholder();

    // Call Ollama API (this will update conversationHistory and system prompt state)
    await streamOllamaResponse(message, aiMessageDiv);
  }
}

// Save chat function
function saveChat() {
  if (conversationHistory.length === 0) {
    alert('No conversation to save!');
    return;
  }

  // Export conversationHistory as JSON so it can be re-imported
  // into the `conversationHistory` variable in future releases.
  // Only include the ISO `timestamp` field (omit `formattedTimestamp`).
  const exportData = conversationHistory.map(({ role, content, timestamp }) => ({ role, content, timestamp }));
  const json = JSON.stringify(exportData, null, 2);

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;

  // Generate filename with ISO timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  a.download = `ollama-chat-${timestamp}.json`;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

}

// Trigger file chooser for opening JSON chat
function openChat() {
  document.getElementById('openInput').click();
}

// Render conversationHistory into the chat messages area
function renderConversationHistory() {
  const messagesDiv = document.getElementById('chatMessages');
  messagesDiv.innerHTML = '';

  conversationHistory.forEach(msg => {
    const roleClass = msg.role === 'user' ? 'user-message' : 'ai-message';
    const label = msg.role === 'user' ? 'You' : 'AI Assistant';
    const formatted = msg.formattedTimestamp || formatTimestamp(new Date(msg.timestamp || Date.now()));

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${roleClass}`;

    if (msg.role === 'user') {
      messageDiv.innerHTML = `
        <div class="message-label">${label}</div>
        <div class="message-content"><p>${escapeHtml(msg.content)}</p></div>
        <div class="message-timestamp">${formatted}</div>
      `;
    } else {
      messageDiv.innerHTML = `
        <div class="message-label">${label}</div>
        <div class="message-content">${DOMPurify.sanitize(marked.parse(msg.content))}</div>
        <div class="message-timestamp">${formatted}</div>
      `;
    }

    messagesDiv.appendChild(messageDiv);
  });

  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  // Update system prompt state after rendering
  updateSystemPromptState();
}

// Handle chosen JSON file and open into conversationHistory
function handleOpenFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data)) throw new Error('Invalid file format: expected an array');

      // Normalize entries: ensure timestamp exists and add formattedTimestamp
      conversationHistory = data.map(item => {
        const ts = item.timestamp || new Date().toISOString();
        return {
          role: item.role,
          content: item.content,
          timestamp: ts,
          formattedTimestamp: formatTimestamp(new Date(ts))
        };
      });

      renderConversationHistory();
      // updateSystemPromptState() is now called inside renderConversationHistory()
    } catch (err) {
      alert('Failed to open chat: ' + err.message);
      console.error(err);
    } finally {
      // reset input so same file can be selected again
      event.target.value = '';
    }
  };

  reader.readAsText(file);
}