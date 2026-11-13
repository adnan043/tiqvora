/**
 * The help chat's `sessionStorage` keys and the sign-out wipe (BROWSER-SAFE, no imports).
 * Kept apart from `./helpdesk-handoff.ts` so Base.astro's sign-out handler, on every
 * public page, pulls in only this.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const HD_KEYS = {transcript: 'hd:transcript', handoff: 'hd:handoff', ticket: 'hd:ticket'} as const;

/** Sign-out: nothing of the help chat outlives the session (every `hd:*` key). Never throws. */
export function clearHelpdeskStorage(storage: StorageLike | null): void {
  const keys = new Set<string>(Object.values(HD_KEYS));
  try {
    const s = storage as (StorageLike & {length?: number; key?(i: number): string | null}) | null;
    if (s && typeof s.length === 'number' && typeof s.key === 'function') {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith('hd:')) keys.add(k);
      }
    }
  } catch {
    // Storage blocked: the known keys below.
  }
  for (const k of keys) {
    try {
      storage?.removeItem(k);
    } catch {
      // Storage blocked: nothing was kept.
    }
  }
}
