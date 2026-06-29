// db.js - IndexedDB persistence for conversation history

const DB_NAME = 'vpal_db';
const DB_VERSION = 1;
const DB_STORE = 'conversations';

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const store = db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('persona', 'persona', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };
    request.onerror = () => reject(request.error);
  });
}

async function dbCreateConversation(persona, personaLabel, messages) {
  const db = await openDB();
  const now = new Date().toISOString();
  const firstUser = messages.find(m => m.role === 'user');
  const title = firstUser
    ? firstUser.content.slice(0, 60) + (firstUser.content.length > 60 ? '…' : '')
    : 'New conversation';
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const req = store.add({ persona, personaLabel, title, messages, createdAt: now, updatedAt: now });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbUpdateConversation(id, messages) {
  const db = await openDB();
  const now = new Date().toISOString();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const conv = getReq.result;
      if (!conv) { reject(new Error('Conversation not found')); return; }
      const firstUser = messages.find(m => m.role === 'user');
      if (firstUser) {
        conv.title = firstUser.content.slice(0, 60) + (firstUser.content.length > 60 ? '…' : '');
      }
      conv.messages = messages;
      conv.updatedAt = now;
      const putReq = store.put(conv);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

async function dbGetConversation(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAllConversations() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      resolve(req.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbDeleteConversation(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbUpdateMessages(id, messages) {
  return dbUpdateConversation(id, messages);
}
