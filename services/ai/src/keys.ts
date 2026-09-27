import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Tenant API keys (BYOK) at rest. AES-256-GCM with a key derived from AI_KEY_SECRET; in AWS the
// secret comes from KMS. The ciphertext carries its IV and auth tag, so it is self-contained.

const derive = (secret: string) => createHash('sha256').update(secret).digest();

export function encryptKey(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function decryptKey(secret: string, stored: string): string {
  const [iv, tag, body] = stored.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !body) throw new Error('Malformed encrypted key');
  const decipher = createDecipheriv('aes-256-gcm', derive(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** "sk-ant-api03-…7Q2f": enough to recognise which key is set, not enough to use it. */
export function keyHint(plain: string): string {
  const prefix = /^[a-z]+-(?:[a-z]+-)?/i.exec(plain)?.[0] ?? '';
  return `${prefix.slice(0, 8)}••••${plain.slice(-4)}`;
}
