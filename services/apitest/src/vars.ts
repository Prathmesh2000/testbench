import type { ApiVariable } from '@tb/contracts';
import type { ResolvedVariable } from './resolve';

// Variables as stored: a secret's value is ciphertext. The browser never gets a secret back (only
// hasValue), and saving a secret with an empty value keeps what is stored, so editing other rows of an
// environment does not wipe its secrets.

export interface StoredVariable {
  key: string;
  value: string;
  secret: boolean;
  enabled: boolean;
}

export class NoSecretKeyError extends Error {}

export function toStored(
  incoming: ApiVariable[],
  existing: StoredVariable[],
  encrypt: ((plain: string) => string) | null,
): StoredVariable[] {
  const before = new Map(existing.map((v) => [v.key, v]));
  return incoming.map((v) => {
    if (!v.secret) return { key: v.key, value: v.value, secret: false, enabled: v.enabled };
    const kept = before.get(v.key);
    if (!v.value && kept?.secret) return { ...kept, enabled: v.enabled };
    if (!v.value) return { key: v.key, value: '', secret: true, enabled: v.enabled };
    if (!encrypt) throw new NoSecretKeyError();
    return { key: v.key, value: encrypt(v.value), secret: true, enabled: v.enabled };
  });
}

export const toView = (stored: StoredVariable[]): ApiVariable[] =>
  stored.map((v) => (v.secret ? { key: v.key, value: '', secret: true, enabled: v.enabled, hasValue: v.value !== '' } : { ...v }));

/** Plain values for one send. A secret that cannot be decrypted (key rotated) resolves as unset. */
export function toResolved(stored: StoredVariable[], decrypt: ((cipher: string) => string) | null): ResolvedVariable[] {
  return stored.flatMap((v) => {
    if (!v.secret || !v.value) return [v];
    if (!decrypt) return [];
    try {
      return [{ ...v, value: decrypt(v.value) }];
    } catch {
      return [];
    }
  });
}
