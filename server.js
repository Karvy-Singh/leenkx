import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.resolve('.data');
const publicDirectory = path.resolve('public');
const sessions = new Map();
const logger = pino({ level: 'silent' });
const urlPattern = /https?:\/\/[^\s<>"']+/gi;

await fs.mkdir(dataDirectory, { recursive: true });
const encryptionKey = await getEncryptionKey();

function hash(value) {
  return createHash('sha256').update(value).digest();
}

async function getEncryptionKey() {
  if (process.env.SESSION_ENCRYPTION_KEY) {
    return hash(process.env.SESSION_ENCRYPTION_KEY);
  }
  const keyPath = path.join(dataDirectory, '.session.key');
  try {
    const key = await fs.readFile(keyPath);
    if (key.length !== 32) throw new Error('Invalid local session key');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = randomBytes(32);
    await fs.writeFile(keyPath, key, { mode: 0o600 });
    return key;
  }
}

function digits(value) {
  return value?.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') || null;
}

function unix(value) {
  return Number(value) || 0;
}

function unwrap(message) {
  let value = message;
  while (value?.ephemeralMessage || value?.viewOnceMessage || value?.viewOnceMessageV2) {
    value =
      value.ephemeralMessage?.message ||
      value.viewOnceMessage?.message ||
      value.viewOnceMessageV2?.message;
  }
  return value || {};
}

function textOf(message) {
  return message?.conversation ?? message?.extendedTextMessage?.text ?? null;
}

function matches(key, number) {
  return [key.remoteJid, key.remoteJidAlt].some((jid) => digits(jid) === number);
}

function isDirect(key) {
  return ![key.remoteJid, key.remoteJidAlt].some(
    (jid) => jid?.endsWith('@g.us') || jid?.endsWith('@broadcast'),
  );
}

function encrypt(payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decrypt(payload) {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

class WhatsAppSession {
  constructor(sender) {
    this.sender = sender;
    this.receiver = null;
    this.ownerHash = null;
    this.auth = { creds: initAuthCreds(), keys: {} };
    this.messages = new Map();
    this.socket = null;
    this.status = 'disconnected';
    this.progress = 0;
    this.qrImage = null;
    this.error = null;
    this.historyComplete = false;
    this.reconnectTimer = null;
    this.saveTimer = null;
    this.saving = Promise.resolve();
  }

  static async create(sender) {
    const session = new WhatsAppSession(sender);
    await session.load();
    return session;
  }

  get filePath() {
    return path.join(dataDirectory, `${hash(this.sender).toString('hex')}.enc`);
  }

  async load() {
    try {
      const restored = JSON.parse(
        decrypt(await fs.readFile(this.filePath)).toString(),
        BufferJSON.reviver,
      );
      this.receiver = restored.receiver;
      this.ownerHash = restored.ownerHash;
      this.auth = restored.auth;
      this.historyComplete = restored.historyComplete;
      this.messages = new Map(restored.messages.map((item) => [item.key.id, item]));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  authorize(token) {
    const provided = hash(token);
    if (!this.ownerHash) {
      this.ownerHash = provided.toString('hex');
      this.scheduleSave();
      return true;
    }
    const expected = Buffer.from(this.ownerHash, 'hex');
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 750);
  }

  async save() {
    clearTimeout(this.saveTimer);
    const data = JSON.stringify(
      {
        ownerHash: this.ownerHash,
        receiver: this.receiver,
        auth: this.auth,
        historyComplete: this.historyComplete,
        messages: [...this.messages.values()],
      },
      BufferJSON.replacer,
    );
    const temporary = `${this.filePath}.tmp`;
    this.saving = this.saving.then(async () => {
      await fs.writeFile(temporary, encrypt(data));
      await fs.rename(temporary, this.filePath);
    });
    await this.saving;
  }

  authState() {
    return {
      creds: this.auth.creds,
      keys: {
        get: async (type, ids) => {
          const values = {};
          for (const id of ids) {
            let value = this.auth.keys[`${type}:${id}`];
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
              if (value) this.auth.keys[key] = value;
              else delete this.auth.keys[key];
            }
          }
          this.scheduleSave();
        },
      },
    };
  }

  configure(receiver) {
    this.receiver = receiver;
    this.scheduleSave();
    this.connect();
  }

  connect() {
    if (this.socket) return;
    clearTimeout(this.reconnectTimer);
    this.status = 'connecting';
    this.error = null;
    const socket = makeWASocket({
      auth: this.authState(),
      browser: Browsers.ubuntu('Unreplied Links'),
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: true,
    });
    this.socket = socket;

    socket.ev.on('creds.update', (update) => {
      Object.assign(this.auth.creds, update);
      this.scheduleSave();
    });
    socket.ev.on('messaging-history.set', ({ messages, progress, syncType }) => {
      for (const message of messages) this.storeMessage(message);
      this.progress = progress ?? this.progress;
      if (
        syncType === proto.HistorySync.HistorySyncType.RECENT &&
        progress === 100
      ) {
        this.historyComplete = true;
        this.status = 'ready';
      } else if (this.status !== 'ready') {
        this.status = 'syncing';
      }
      this.scheduleSave();
    });
    socket.ev.on('messages.upsert', ({ messages }) => {
      for (const message of messages) this.storeMessage(message);
      this.scheduleSave();
    });
    socket.ev.on('connection.update', async (update) => {
      if (update.qr) {
        this.qrImage = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 });
        this.status = 'qr';
      }
      if (update.connection === 'open') {
        this.qrImage = null;
        this.status = this.historyComplete ? 'ready' : 'syncing';
        const loggedIn = digits(socket.user?.id);
        if (loggedIn && loggedIn !== this.sender) {
          this.error = `Scanned account is ${loggedIn}, not ${this.sender}`;
          this.status = 'error';
        }
        this.scheduleSave();
      }
      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        this.socket = null;
        if (code === DisconnectReason.loggedOut) {
          this.status = 'logged-out';
          this.error = 'WhatsApp logged out this linked device';
          this.auth = { creds: initAuthCreds(), keys: {} };
          this.historyComplete = false;
        } else {
          this.status = 'disconnected';
          this.reconnectTimer = setTimeout(() => this.connect(), 2000);
        }
        this.scheduleSave();
      }
    });
  }

  storeMessage(item) {
    if (!item.key?.id || !isDirect(item.key)) return;
    const body = unwrap(item.message);
    if (textOf(body) === null && !body.reactionMessage) return;
    if (unix(item.messageTimestamp) < Date.now() / 1000 - 91 * 86400) return;
    this.messages.set(item.key.id, {
      key: item.key,
      messageTimestamp: unix(item.messageTimestamp),
      message: body,
    });
  }

  search(cutoff) {
    const relevant = [...this.messages.values()].filter(
      (item) => matches(item.key, this.receiver) && item.messageTimestamp >= cutoff,
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

    const links = [];
    for (const item of relevant) {
      if (!item.key.fromMe || answered.has(item.key.id)) continue;
      const text = textOf(unwrap(item.message));
      if (text === null) continue;
      for (const url of text.match(urlPattern) || []) {
        links.push({
          id: item.key.id,
          url,
          text,
          timestamp: new Date(item.messageTimestamp * 1000).toISOString(),
        });
      }
    }
    return links.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async close() {
    clearTimeout(this.reconnectTimer);
    await this.save();
    this.socket?.end(new Error('Server shutting down'));
  }
}

async function getSession(sender) {
  if (!sessions.has(sender)) {
    sessions.set(sender, WhatsAppSession.create(sender));
  }
  return sessions.get(sender);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

function json(response, data, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

async function api(request, response) {
  const sender = String(request.headers['x-sender'] || '').replace(/\D/g, '');
  const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
  if (!/^\d{8,15}$/.test(sender) || !token) {
    json(response, { error: 'Valid sender and owner token required' }, 400);
    return;
  }
  const session = await getSession(sender);
  if (!session.authorize(token)) {
    json(response, { error: 'This sender belongs to another browser session' }, 401);
    return;
  }

  if (request.url === '/api/config' && request.method === 'POST') {
    const input = await readJson(request);
    const receiver = String(input.receiver || '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(receiver)) {
      json(response, { error: 'Valid receiver number required' }, 400);
      return;
    }
    session.configure(receiver);
    json(response, { status: session.status });
    return;
  }
  if (request.url === '/api/status') {
    if (session.receiver && !session.socket && session.status !== 'logged-out') {
      session.connect();
    }
    json(response, {
      status: session.status,
      progress: session.progress,
      qr: session.qrImage,
      error: session.error,
    });
    return;
  }
  if (request.url === '/api/search' && request.method === 'POST') {
    if (session.status !== 'ready') {
      json(response, { error: 'WhatsApp history is not ready yet' }, 409);
      return;
    }
    const input = await readJson(request);
    const cutoff = Date.parse(input.cutoff) / 1000;
    const oldestAllowed = Date.now() / 1000 - 91 * 86400;
    if (!Number.isFinite(cutoff) || cutoff < oldestAllowed || cutoff > Date.now() / 1000) {
      json(response, { error: 'Choose a range from 1 to 90 days' }, 400);
      return;
    }
    json(response, { links: session.search(cutoff) });
    return;
  }
  json(response, { error: 'Not found' }, 404);
}

async function staticFile(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDirectory, requested);
  if (!file.startsWith(`${publicDirectory}${path.sep}`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await fs.readFile(file);
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
    response.writeHead(200, {
      'content-type': type,
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    response.end(content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.url?.startsWith('/api/')) await api(request, response);
    else await staticFile(request, response);
  } catch (error) {
    json(response, { error: error.message || 'Internal server error' }, 500);
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Unreplied Links running at http://localhost:${port}`);
});

async function shutdown() {
  server.close();
  await Promise.all([...sessions.values()].map(async (session) => (await session).close()));
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
