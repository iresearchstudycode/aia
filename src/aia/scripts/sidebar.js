// sidebar.js - Conversation history sidebar

let currentConversationId = null;

const PERSONA_LABELS = {
  default: 'Default Assistant',
  helpful: 'Helpful & Concise',
  auEnglishEditor: 'Australian English Editor',
  claudePromptCompressor: 'Claude Prompt Compressor',
  transcriptai: 'Transcript-Based Assistant',
  quickwrite: 'Quick Write',
  creative: 'Creative Writer',
  technical: 'Technical Expert',
  teacher: 'Patient Teacher',
  casual: 'Casual Friend',
  professional: 'Professional Consultant',
  legal: 'Legal Assistant',
  medical: 'Medical Expert',
};

function getPersonaLabel(key) {
  return PERSONA_LABELS[key] || key;
}

async function renderSidebar() {
  const list = document.getElementById('conversationList');
  list.innerHTML = '';

  let conversations;
  try {
    conversations = await dbGetAllConversations();
  } catch (e) {
    console.error('Failed to load sidebar:', e);
    return;
  }

  if (conversations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sidebar-empty';
    empty.textContent = 'No conversations yet';
    list.appendChild(empty);
    return;
  }

  // Group by persona, preserving order of first appearance
  const groups = new Map();
  conversations.forEach(conv => {
    if (!groups.has(conv.persona)) {
      groups.set(conv.persona, {
        label: conv.personaLabel || getPersonaLabel(conv.persona),
        items: []
      });
    }
    groups.get(conv.persona).items.push(conv);
  });

  groups.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'sidebar-group';

    const heading = document.createElement('div');
    heading.className = 'sidebar-group-heading';
    heading.textContent = group.label;
    groupEl.appendChild(heading);

    group.items.forEach(conv => groupEl.appendChild(createSidebarItem(conv)));
    list.appendChild(groupEl);
  });
}

function createSidebarItem(conv) {
  const item = document.createElement('div');
  item.className = 'sidebar-item' + (conv.id === currentConversationId ? ' active' : '');
  item.dataset.id = String(conv.id);

  const title = document.createElement('span');
  title.className = 'sidebar-item-title';
  title.textContent = conv.title;

  const del = document.createElement('button');
  del.className = 'sidebar-item-delete';
  del.title = 'Delete conversation';
  del.textContent = '✕';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    try { await dbDeleteConversation(conv.id); } catch (err) { console.error(err); }
    if (currentConversationId === conv.id) startNewConversation();
    renderSidebar();
  });

  item.appendChild(title);
  item.appendChild(del);
  item.addEventListener('click', () => loadConversationById(conv.id));
  return item;
}

async function loadConversationById(id) {
  let conv;
  try {
    conv = await dbGetConversation(id);
  } catch (e) {
    console.error('Failed to load conversation:', e);
    return;
  }
  if (!conv) return;

  currentConversationId = id;

  const select = document.getElementById('systemPromptSelect');
  if (systemPrompts[conv.persona]) {
    select.value = conv.persona;
    currentSystemPrompt = systemPrompts[conv.persona];
  }

  conversationHistory = conv.messages.slice();
  renderConversationHistory();

  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id) === id);
  });
}

function startNewConversation() {
  currentConversationId = null;
  conversationHistory = [];
  document.getElementById('chatMessages').innerHTML = '';

  const select = document.getElementById('systemPromptSelect');
  currentSystemPrompt = systemPrompts[select.value];
  updateSystemPromptState();

  document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
}
