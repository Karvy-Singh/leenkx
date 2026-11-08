import { createServer } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

let auth = { creds: initAuthCreds(), keys: {} };
let messages = new Map();
let socket;
let sender;
let receiver;
let qr;
let qrImage;
let status = 'disconnected';
let progress = 0;
let errorMessage;
let dirty = false;
let reconnectTimer;

const digits = (value) => value?.split('@')[0]?.split(':')[0] || null;
const unix = (value) => Number(value) || 0;
const unwrap = (message) => {
  let value = message;
  while (value?.ephemeralMessage || value?.viewOnceMessage || value?.viewOnceMessageV2) {
    value =
      value.ephemeralMessage?.message ||
      value.viewOnceMessage?.message ||
      value.viewOnceMessageV2?.message;
  }
  return value || {};
};
const textOf = (message) =>
  message?.conversation ?? message?.extendedTextMessage?.text ?? null;
const isDirect = (key) =>
  ![key.remoteJid, key.remoteJidAlt].some((jid) =>
    jid?.endsWith('@g.us') || jid?.endsWith('@broadcast'),
  );
const matches = (key, number) =>
  [key.remoteJid, key.remoteJidAlt].some((jid) => digits(jid) === number);

function storeMessage(item) {
  if (!item.key?.id || !isDirect(item.key)) return;
  const body = unwrap(item.message);
  if (textOf(body) === null && !body.reactionMessage) return;
  const cutoff = Date.now() / 1000 - 91 * 24 * 60 * 60;
  if (unix(item.messageTimestamp) < cutoff) return;
  messages.set(item.key.id, {
    key: item.key,
    messageTimestamp: unix(item.messageTimestamp),
    message: body,
  });
  dirty = true;
}

const authState = () => ({
  creds: auth.creds,
  keys: {
    get: async (type, ids) => {
      const values = {};
      for (const id of ids) {
        let value = auth.keys[`${type}:${id}`];
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        values[id] = value;
      }
      return values;
    },
    set: async (data) => {
      for (const [type, values] of Object.entries(data)) {
        for (const [id, value] of Object.entries(values)) {
          const key = `${type}:${id}`;
          if (value) auth.keys[key] = value;
          else delete auth.keys[key];
        }
      }
      dirty = true;
    },
  },
});

function connect() {
  if (socket || !sender) return;
  clearTimeout(reconnectTimer);
  status = 'connecting';
  errorMessage = undefined;
  socket = makeWASocket({
    auth: authState(),
    browser: Browsers.ubuntu('Unreplied Links'),
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: true,
  });

  socket.ev.on('creds.update', (update) => {
    Object.assign(auth.creds, update);
    dirty = true;
  });
  socket.ev.on('messaging-history.set', ({ messages: batch, progress: value, syncType }) => {
    for (const message of batch) storeMessage(message);
    progress = value ?? progress;
    if (
      syncType === proto.HistorySync.HistorySyncType.RECENT &&
      value === 100
    ) {
      status = 'ready';
    } else if (status !== 'ready') {
      status = 'syncing';
    }
  });
  socket.ev.on('messages.upsert', ({ messages: batch }) => {
    for (const message of batch) storeMessage(message);
  });
  socket.ev.on('connection.update', async (update) => {
    if (update.qr) {
      qr = update.qr;
      qrImage = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 });
      status = 'qr';
    }
    if (update.connection === 'open') {
      qr = undefined;
      qrImage = undefined;
      status = progress === 100 ? 'ready' : 'syncing';
      const loggedIn = digits(socket.user?.id);
      if (loggedIn && loggedIn !== sender) {
        errorMessage = `Scanned account is ${loggedIn}, not ${sender}`;
        status = 'error';
      }
      dirty = true;
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      socket = undefined;
      if (code === DisconnectReason.loggedOut) {
        status = 'logged-out';
        errorMessage = 'WhatsApp logged out this linked device';
        auth = { creds: initAuthCreds(), keys: {} };
      } else {
        status = 'disconnected';
        reconnectTimer = setTimeout(connect, 2000);
      }
      dirty = true;
    }
  });
}

function searchLinks(cutoff) {
  const relevant = [...messages.values()].filter(
    (item) => matches(item.key, receiver) && item.messageTimestamp >= cutoff,
  );
  const answered = new Set();

  for (const item of relevant) {
    const body = unwrap(item.message);
    const reaction = body.reactionMessage;
    if (reaction?.key?.id && !item.key.fromMe && reaction.text) {
      answered.add(reaction.key.id);
    }
    const replyId = body.extendedTextMessage?.contextInfo?.stanzaId;
    if (replyId && !item.key.fromMe) answered.add(replyId);
  }

  const results = [];
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  for (const item of relevant) {
    if (!item.key.fromMe || answered.has(item.key.id)) continue;
    const text = textOf(unwrap(item.message));
    if (text === null) continue;
    for (const url of text.match(urlPattern) || []) {
      results.push({
        id: item.key.id,
        url,
        text,
        timestamp: new Date(item.messageTimestamp * 1000).toISOString(),
      });
    }
  }
  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

createServer(async (request, response) => {
  try {
    if (request.url === '/health') {
      response.writeHead(200).end('ok');
      return;
    }
    if (request.url === '/internal/session') {
      if (request.method === 'GET') {
        const payload = JSON.stringify(
          { auth, messages: [...messages.values()], sender, receiver },
          BufferJSON.replacer,
        );
        response.setHeader('content-type', 'application/octet-stream');
        response.end(gzipSync(payload));
        dirty = false;
        return;
      }
      if (request.method === 'POST') {
        const restored = JSON.parse(
          gunzipSync(await body(request)).toString(),
          BufferJSON.reviver,
        );
        auth = restored.auth;
        messages = new Map(restored.messages.map((item) => [item.key.id, item]));
        sender = restored.sender;
        receiver = restored.receiver;
        response.writeHead(204).end();
        return;
      }
    }
    if (request.url === '/api/config' && request.method === 'POST') {
      const config = JSON.parse((await body(request)).toString());
      sender = String(config.sender || '').replace(/\D/g, '');
      receiver = String(config.receiver || '').replace(/\D/g, '');
      if (!/^\d{8,15}$/.test(sender) || !/^\d{8,15}$/.test(receiver)) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Valid sender and receiver are required' }));
        return;
      }
      dirty = true;
      connect();
      response.setHeader('x-session-dirty', '1');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status }));
      return;
    }
    if (request.url === '/api/status') {
      if (sender && !socket && status !== 'logged-out') connect();
      response.setHeader('content-type', 'application/json');
      if (dirty) response.setHeader('x-session-dirty', '1');
      response.end(JSON.stringify({ status, progress, qr: qrImage, error: errorMessage }));
      return;
    }
    if (request.url === '/api/search' && request.method === 'POST') {
      if (status !== 'ready') {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'WhatsApp history is not ready yet' }));
        return;
      }
      const query = JSON.parse((await body(request)).toString());
      const cutoff = Date.parse(query.cutoff) / 1000;
      const oldestAllowed = Date.now() / 1000 - 91 * 24 * 60 * 60;
      if (!Number.isFinite(cutoff) || cutoff < oldestAllowed || cutoff > Date.now() / 1000) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Choose a range from 1 to 90 days' }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (dirty) response.setHeader('x-session-dirty', '1');
      response.end(JSON.stringify({ links: searchLinks(cutoff) }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error.message }));
  }
}).listen(8080, '0.0.0.0');
