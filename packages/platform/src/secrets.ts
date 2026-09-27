import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Secrets stored by the application (tenant AI keys, Slack-linked tokens): AES-256-GCM with a key
// derived from a configured secret; in AWS the secret comes from KMS. The ciphertext carries its IV
// and auth tag, so it is self-contained.

const derive = (secret: string) => createHash('sha256').update(secret).digest();

export function encryptSecret(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(secret: string, stored: string): string {
  const [iv, tag, body] = stored.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !body) throw new Error('Malformed encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', derive(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
