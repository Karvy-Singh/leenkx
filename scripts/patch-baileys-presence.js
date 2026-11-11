import fs from 'node:fs/promises';

const socketPath = new URL(
  '../node_modules/@whiskeysockets/baileys/lib/Socket/socket.js',
  import.meta.url,
);
const vulnerable = 'if (creds.me?.name !== name) {';
const patched =
  "if (typeof name === 'string' && name.length > 0 && creds.me?.name !== name) {";
const source = await fs.readFile(socketPath, 'utf8');

if (source.includes(patched)) {
  console.log('Baileys presence patch already applied');
} else if (source.includes(vulnerable)) {
  await fs.writeFile(socketPath, source.replace(vulnerable, patched));
  console.log('Applied Baileys passive-presence patch');
} else {
  throw new Error('Installed Baileys version does not match the presence patch');
}
