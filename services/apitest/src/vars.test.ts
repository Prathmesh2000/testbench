import { describe, expect, it } from 'vitest';
import { NoSecretKeyError, toResolved, toStored, toView } from './vars';

const enc = (s: string) => `enc(${s})`;
const dec = (s: string) => s.slice(4, -1);

describe('secret variables', () => {
  it('encrypts secrets, never shows them back, and resolves them for a send', () => {
    const stored = toStored(
      [
        { key: 'host', value: 'api.test', secret: false, enabled: true },
        { key: 'token', value: 'tok', secret: true, enabled: true },
      ],
      [],
      enc,
    );
    expect(stored[1]).toEqual({ key: 'token', value: 'enc(tok)', secret: true, enabled: true });
    expect(toView(stored)[1]).toEqual({ key: 'token', value: '', secret: true, enabled: true, hasValue: true });
    expect(toResolved(stored, dec)[1]!.value).toBe('tok');
  });

  it('keeps the stored secret when saved with an empty value', () => {
    const first = toStored([{ key: 'token', value: 'tok', secret: true, enabled: true }], [], enc);
    const again = toStored([{ key: 'token', value: '', secret: true, enabled: false }], first, enc);
    expect(again[0]).toEqual({ key: 'token', value: 'enc(tok)', secret: true, enabled: false });
  });

  it('refuses a new secret when the server has no key, and drops one it cannot decrypt', () => {
    expect(() => toStored([{ key: 't', value: 'x', secret: true, enabled: true }], [], null)).toThrow(NoSecretKeyError);
    const broken = [{ key: 't', value: 'garbage', secret: true, enabled: true }];
    expect(toResolved(broken, () => { throw new Error('bad tag'); })).toEqual([]);
  });
});
