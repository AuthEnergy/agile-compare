import type { AccountData } from './types/octopus';

// Cross-flow session state. Created once in main.ts and passed explicitly — NOT
// a module-level singleton (so flows are re-entrant and tests are isolated).
// Only `diagnostics`/`failureDiag` are read after a flow ends (download buttons).
export interface AppState {
  apiKey: string;
  accountNumber: string;
  mpan: string;
  serial: string;
  serials: string[];
  accountData: AccountData | null;
  isExport: boolean;
  diagnostics: unknown;
  failureDiag: unknown;
}

export function createAppState(): AppState {
  return {
    apiKey: '',
    accountNumber: '',
    mpan: '',
    serial: '',
    serials: [],
    accountData: null,
    isExport: false,
    diagnostics: null,
    failureDiag: null,
  };
}
