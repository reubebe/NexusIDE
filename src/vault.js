import { randomBytes, scrypt as scryptCallback, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { readState, writeState, listState, safeName } from './state.js';
const scrypt = promisify(scryptCallback);
async function key(password, salt) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('NEXUS_VAULT_PASSWORD must contain at least 12 characters.');
  return scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
export async function setSecret(root, name, value, password = process.env.NEXUS_VAULT_PASSWORD) {
  safeName(name);
  if (typeof value !== 'string' || !value || value.length > 16000) throw new Error('Secret must contain 1–16000 characters.');
  const salt = randomBytes(16), iv = randomBytes(12), derived = await key(password, salt);
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  cipher.setAAD(Buffer.from(name));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  derived.fill(0);
  await writeState(root, 'vault', `${name}.json`, { version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export async function getSecret(root, name, password = process.env.NEXUS_VAULT_PASSWORD) {
  const data = await readState(root, 'vault', `${safeName(name)}.json`);
  if (data.version !== 1) throw new Error('Unsupported vault record.');
  const derived = await key(password, Buffer.from(data.salt, 'base64'));
  try {
    const cipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(data.iv, 'base64'));
    cipher.setAAD(Buffer.from(name)); cipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(data.ciphertext, 'base64')), cipher.final()]).toString('utf8');
  } catch { throw new Error('Cannot unlock secret: wrong password or modified record.'); }
  finally { derived.fill(0); }
}
export async function listSecrets(root) { return (await listState(root, 'vault')).map(f => f.slice(0, -5)); }
