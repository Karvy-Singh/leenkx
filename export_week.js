import fs from 'node:fs/promises';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const numbers = {
  '9560965811': '919560965811',
  '7060029183': '917060029183',
};
const loggedInAs = process.argv[2];

if (!numbers[loggedInAs]) {
  console.error('Usage: npm run export -- <logged-in-number>');
  process.exit(2);
}

const ownNumber = numbers[loggedInAs];
const peerNumber = Object.entries(numbers).find(
  ([number]) => number !== loggedInAs,
)[1];
const cutoffDate = new Date();
cutoffDate.setUTCHours(0, 0, 0, 0);
cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 7);
const cutoff = Math.floor(cutoffDate.getTime() / 1000);
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const todayStart = Math.floor(today.getTime() / 1000);
const cacheFile = '.baileys_history.json';
const messages = new Map();
let exportTimer;
let completed = false;
let initialHistoryComplete = false;
let reconnecting = false;
let cacheWrite = Promise.resolve();

const jidNumber = (jid) => jid?.split('@')[0]?.split(':')[0] || null;
const timestamp = (value) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : 0;
};
const content = (message) => {
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
  message.conversation ?? message.extendedTextMessage?.text ?? null;
const isPeerChat = (key) =>
  [key.remoteJid, key.remoteJidAlt].some(
    (jid) => jidNumber(jid) === peerNumber,
  );

function storeMessage(message) {
  if (!message.key?.id || !isPeerChat(message.key)) return;
  const body = content(message.message);
  if (textOf(body) === null && !body.reactionMessage) return;
  messages.set(message.key.id, {
    key: message.key,
    messageTimestamp: timestamp(message.messageTimestamp),
    message: body,
  });
}

function saveCache() {
  cacheWrite = cacheWrite
    .then(() =>
      fs.writeFile(cacheFile, JSON.stringify([...messages.values()])),
    )
    .catch((error) => console.error(`Could not save history cache: ${error.message}`));
}

function scheduleFetch(socket, delay) {
  clearTimeout(exportTimer);
  exportTimer = setTimeout(() => {
    fetchUntilWeek(socket).catch((error) => {
      const status = error?.output?.statusCode;
      if (status !== DisconnectReason.connectionClosed) {
        console.error(error?.stack || error);
        process.exitCode = 1;
      }
    });
  }, delay);
}

async function writeExport(socket) {
  if (completed) return;
  completed = true;

  const reactions = new Map();
  const exported = [];

  for (const item of messages.values()) {
    const body = content(item.message);
    const reaction = body.reactionMessage;
    if (!reaction?.key?.id || !reaction.text) continue;

    const list = reactions.get(reaction.key.id) || [];
    list.push({
      emoji: reaction.text,
      sender: item.key.fromMe ? ownNumber : peerNumber,
      timestamp: new Date(timestamp(item.messageTimestamp) * 1000).toISOString(),
    });
    reactions.set(reaction.key.id, list);
  }

  for (const item of messages.values()) {
    const sentAt = timestamp(item.messageTimestamp);
    const body = content(item.message);
    const text = textOf(body);
    if (text === null || sentAt < cutoff || !isPeerChat(item.key)) continue;

    const context = body.extendedTextMessage?.contextInfo;
    exported.push({
      id: item.key.id,
      timestamp: new Date(sentAt * 1000).toISOString(),
      sender: item.key.fromMe ? ownNumber : peerNumber,
      text,
      reply_to: context?.stanzaId
        ? {
            id: context.stanzaId,
            sender: jidNumber(context.participant),
            text: textOf(content(context.quotedMessage)),
          }
        : null,
      mentions: (context?.mentionedJid || []).map(jidNumber),
      reactions: reactions.get(item.key.id) || [],
    });
  }

  exported.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!exported.length) throw new Error('No messages collected; existing export was not changed.');
  await fs.writeFile('whatsapp_export.json', JSON.stringify(exported, null, 2));
  console.log(`Exported ${exported.length} messages to whatsapp_export.json`);
  socket?.end(new Error('Export complete'));
}

async function fetchUntilWeek(socket) {
  if (!initialHistoryComplete) {
    console.log('Waiting for initial history sync to reach 100%...');
    return;
  }
  await writeExport(socket);
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('.baileys_auth_v5');
  const socket = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Desktop'),
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: true,
  });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('messaging-history.set', ({ messages: batch, progress, syncType }) => {
    if (
      syncType === proto.HistorySync.HistorySyncType.RECENT &&
      progress === 100
    ) {
      initialHistoryComplete = true;
    }
    for (const message of batch) {
      storeMessage(message);
    }
    saveCache();
    console.log(`History sync: ${progress ?? '?'}% (${messages.size} matching messages)`);
    scheduleFetch(socket, initialHistoryComplete ? 1000 : 5000);
  });

  socket.ev.on('messages.upsert', ({ messages: batch }) => {
    const previousSize = messages.size;
    for (const message of batch) storeMessage(message);
    if (messages.size > previousSize) {
      saveCache();
      if (initialHistoryComplete) scheduleFetch(socket, 500);
    }
  });

  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'open') {
      reconnecting = false;
      console.log('Connected with saved authentication.');
      if (messages.size) scheduleFetch(socket, 500);
      else console.log('Send any text in this WhatsApp chat once to start history pagination.');
    }
    if (connection === 'close' && !completed) {
      clearTimeout(exportTimer);
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.error('WhatsApp logged out this saved session.');
        process.exitCode = 1;
      } else if (!reconnecting) {
        reconnecting = true;
        console.error(`Connection closed (${status ?? 'unknown'}); retrying...`);
        setTimeout(() => {
          connect().catch((error) => console.error(error?.stack || error));
        }, 2000);
      }
    }
  });
}

try {
  const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  for (const message of cached) storeMessage(message);
  const cachedTimestamps = [...messages.values()]
    .filter((message) => textOf(content(message.message)) !== null)
    .map((message) => timestamp(message.messageTimestamp));
  initialHistoryComplete =
    cachedTimestamps.some((value) => value < cutoff) &&
    cachedTimestamps.some((value) => value >= todayStart);
  console.log(`Loaded ${messages.size} cached messages.`);
} catch (error) {
  if (error.code !== 'ENOENT') console.error(`Could not load history cache: ${error.message}`);
}

if (initialHistoryComplete) {
  await writeExport();
} else {
  connect().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
