import fs from 'node:fs/promises';

const messages = JSON.parse(await fs.readFile('whatsapp_export.json', 'utf8'));
const messagesById = new Map(messages.map((message) => [message.id, message]));
const repliedTo = new Set();

for (const reply of messages) {
  const original = messagesById.get(reply.reply_to?.id);
  if (original && reply.sender !== original.sender) repliedTo.add(original.id);
}
const urlPattern = /https?:\/\/[^\s<>"']+/gi;

let count = 0;
for (const message of messages) {
  const links = message.text.match(urlPattern) || [];
  if (!links.length || repliedTo.has(message.id)) continue;

  for (const link of links) {
    console.log(`${message.timestamp} | ${message.sender} | ${link}`);
    count++;
  }
}

console.log(`\n${count} unreplied link${count === 1 ? '' : 's'}`);
