// Opt-in API-key storage. The key lives in localStorage ONLY when the user ticks
// "remember", and only ever on this device — no backend. Ported from v2's
// load/saveOrClear pair. All access is guarded: storage may be disabled, full,
// or hold hand-edited JSON.

const STORAGE_KEY = 'octopus-tariff-check-credentials';

export function loadSavedApiKey(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'apiKey' in parsed) {
      const k = (parsed as { apiKey: unknown }).apiKey;
      return typeof k === 'string' ? k : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveApiKey(apiKey: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey }));
  } catch {
    /* storage unavailable or full — silently skip */
  }
}

export function clearApiKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function hasSavedApiKey(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}
