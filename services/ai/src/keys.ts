// Tenant API keys (BYOK) are encrypted with the platform's secret helpers; AI_KEY_SECRET is the key.
export { decryptSecret as decryptKey, encryptSecret as encryptKey } from '@tb/platform';

/** "sk-ant-api03-…7Q2f": enough to recognise which key is set, not enough to use it. */
export function keyHint(plain: string): string {
  const prefix = /^[a-z]+-(?:[a-z]+-)?/i.exec(plain)?.[0] ?? '';
  return `${prefix.slice(0, 8)}••••${plain.slice(-4)}`;
}
