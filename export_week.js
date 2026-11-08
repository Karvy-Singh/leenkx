import fs from 'node:fs/promises';
import makeWASocket, {
  Browsers,
  DisconnectReason,
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
const messages = new Map();
let exportTimer;
let completed = false;
let requestedOldest;

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

async function writeExport(socket) {
  if (completed) return;
  completed = true;

  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
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
  await fs.writeFile('whatsapp_export.json', JSON.stringify(exported, null, 2));
  console.log(`Exported ${exported.length} messages to whatsapp_export.json`);
  socket.end(new Error('Export complete'));
}

async function fetchUntilWeek(socket) {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const oldest = [...messages.values()]
    .filter(
      (message) =>
        isPeerChat(message.key) && textOf(content(message.message)) !== null,
    )
    .sort(
      (a, b) => timestamp(a.messageTimestamp) - timestamp(b.messageTimestamp),
    )[0];

  if (!oldest || timestamp(oldest.messageTimestamp) <= cutoff) {
    await writeExport(socket);
    return;
  }

  const marker = `${oldest.key.id}:${timestamp(oldest.messageTimestamp)}`;
  if (marker === requestedOldest) {
    await writeExport(socket);
    return;
  }

  requestedOldest = marker;
  console.log(`Requesting messages before ${new Date(timestamp(oldest.messageTimestamp) * 1000).toISOString()}...`);
  await socket.fetchMessageHistory(50, oldest.key, oldest.messageTimestamp);
  clearTimeout(exportTimer);
  exportTimer = setTimeout(() => fetchUntilWeek(socket), 15000);
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('.baileys_auth_v4');
  const socket = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Desktop'),
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: true,
  });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('messaging-history.set', ({ messages: batch, progress }) => {
    for (const message of batch) {
      if (message.key?.id && isPeerChat(message.key)) {
        messages.set(message.key.id, message);
      }
    }
    console.log(`History sync: ${progress ?? '?'}% (${messages.size} matching messages)`);
    clearTimeout(exportTimer);
    exportTimer = setTimeout(() => fetchUntilWeek(socket), 15000);
  });

  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'open') console.log('Connected; waiting for full history sync...');
    if (connection === 'close' && !completed) {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.error('Baileys session logged out; remove .baileys_auth_v4 and scan again.');
        process.exitCode = 1;
      } else if (status === DisconnectReason.connectionClosed) {
        console.error('Connection closed before pairing completed. Run the command again.');
        process.exitCode = 1;
      } else {
        console.error(`Connection closed (${status ?? 'unknown'}); retrying...`);
        setTimeout(connect, 1000);
      }
    }
  });
}

connect().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
