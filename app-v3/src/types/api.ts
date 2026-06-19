// Octopus API DTO fragments — only the fields the app actually reads. Expanded
// in Phase 2 (account/consumption/products); Phase 1 needs statement nodes.

export interface TransactionNode {
  __typename?: string;
  title?: string | null;
  reasonCode?: string | null;
  amounts?: { gross?: number | null } | null;
  consumption?: { quantity?: number | string | null } | null;
}

export interface StatementNode {
  id?: string | number;
  startAt?: string;
  endAt?: string;
  totalCharges?: { grossTotal?: number | null } | null;
  totalCredits?: { grossTotal?: number | null } | null;
  transactions?: {
    edges?: Array<{ node?: TransactionNode | null } | null> | null;
    pageInfo?: { hasNextPage?: boolean } | null;
  } | null;
}

export interface FetchStatementsResult {
  statements: StatementNode[];
  incomplete: boolean;
}

export interface StatementCharge {
  title: string;
  grossPence: number;
  kwh: number | null;
}

export interface StatementCredit {
  title: string;
  reasonCode: string;
  grossPence: number;
}

export interface StatementSummary {
  available: boolean;
  complete: boolean;
  electricityChargePence: number | null;
  billedKwh: number | null;
  creditsPence: number;
  credits: StatementCredit[];
  charges: StatementCharge[];
}
