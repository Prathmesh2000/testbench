'use client';

import { useCallback, useEffect, useState } from 'react';

// Session values: what extractors pulled out of responses (a login token, a new order id), kept in this
// tester's browser per workspace and environment and sent as the most specific scope. They never reach
// a shared environment, so one tester's token cannot overwrite a teammate's.

const key = (workspaceId: string, environmentId: string | null) => `tb.apitest.locals.${workspaceId}.${environmentId ?? 'none'}`;

function read(k: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function useLocals(workspaceId: string, environmentId: string | null) {
  const k = key(workspaceId, environmentId);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues(read(k)), [k]);

  const save = useCallback(
    (next: Record<string, string>) => {
      setValues(next);
      try {
        localStorage.setItem(k, JSON.stringify(next));
      } catch {
        // Storage full or blocked: the values still work for this page.
      }
    },
    [k],
  );
  /** Adds what a send extracted and drops what its scripts unset. */
  const update = useCallback(
    (extra: Record<string, string>, cleared: string[] = []) => {
      const next = { ...read(k), ...extra };
      for (const name of cleared) delete next[name];
      save(next);
    },
    [k, save],
  );
  return { values, update, clear: () => save({}), remove: (name: string) => update({}, [name]) };
}
