import type { FetchStatementsResult, StatementNode } from '../types/api';
import type { AccountData } from '../types/octopus';
import { fetchAccount } from './account';
import { fetchAccountNumbers } from './meters';
import type { OctopusClient } from './client';

interface StatementsConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  edges?: Array<{ node?: StatementNode | null } | null> | null;
}
type LedgerEntry = { statements?: StatementsConnection | null } | null;
interface StatementsQueryData {
  account: { ledgers?: LedgerEntry[] | null };
}

const STATEMENTS_QUERY = `
  query Statements($accountNumber: String!, $after: String) {
    account(accountNumber: $accountNumber) {
      ledgers {
        statements(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              startAt
              endAt
              totalCharges { grossTotal }
              totalCredits { grossTotal }
              transactions(first: 100) {
                totalCount
                pageInfo { hasNextPage endCursor }
                edges {
                  node {
                    __typename
                    title
                    reasonCode
                    amounts { gross net tax }
                    ... on BillCharge {
                      consumption { startDate endDate quantity unit }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

// Pages statements across ledgers. A single $after cursor can only safely page
// ONE statements connection, so if more than one ledger has statements (or wants
// another page) we stop and flag the history incomplete rather than returning
// silently-wrong billing periods.
export async function fetchStatements(
  client: OctopusClient,
  token: string,
  accountNumber: string,
): Promise<FetchStatementsResult> {
  const statements: StatementNode[] = [];
  let after: string | null = null;
  let guard = 0;
  let incomplete = false;
  const ledgersWithStatements = new Set<number>();

  while (guard < 30) {
    const data: StatementsQueryData = await client.graphqlRequest<StatementsQueryData>(
      STATEMENTS_QUERY,
      { accountNumber, after },
      token,
    );
    const ledgers: LedgerEntry[] = data.account.ledgers ?? [];
    let ledgersWantingMore = 0;
    let nextCursor: string | null = null;
    for (let li = 0; li < ledgers.length; li++) {
      const stmts: StatementsConnection | null | undefined = ledgers[li]?.statements;
      if (!stmts || !stmts.edges) continue;
      if (stmts.edges.length) ledgersWithStatements.add(li);
      for (const edge of stmts.edges) {
        if (edge?.node) statements.push(edge.node);
      }
      if (stmts.pageInfo?.hasNextPage) {
        ledgersWantingMore++;
        nextCursor = stmts.pageInfo.endCursor ?? null;
      }
    }
    guard++;
    if (ledgersWantingMore === 0) break;
    if (ledgersWantingMore > 1 || ledgersWithStatements.size > 1) {
      incomplete = true;
      break;
    }
    after = nextCursor;
  }
  return { statements, incomplete: incomplete || guard >= 30 };
}

export interface MeterStatementsResult extends FetchStatementsResult {
  accountsWithMeter: number; // how many of the key's accounts list THIS meter point
}

const electricityMeterPoints = (acct: AccountData) =>
  (acct.properties ?? []).flatMap((p) => p.electricity_meter_points ?? []);

// A statement's bill-charges carry no MPAN, so an account's statements can only be
// safely attributed to THIS meter when the account has exactly one electricity
// meter point and it is this MPAN — otherwise another meter's spend would be mixed
// in. The primary account is exempt (it was always used pre-change, and is the one
// the user explicitly selected a meter from); the extra same-meter accounts this
// change adds must pass the stricter single-meter check.
const accountSafeForMpan = (acct: AccountData, mpan: string): boolean => {
  const points = electricityMeterPoints(acct);
  return points.length === 1 && points[0]?.mpan === mpan;
};
const accountHasMpan = (acct: AccountData, mpan: string): boolean =>
  electricityMeterPoints(acct).some((em) => em.mpan === mpan);

// Statements for an MPAN, gathered across the key's accounts that bill this exact
// meter. Covers billing migrating to a new account number while the physical meter
// stays put — the primary alone then returns a stale statement history. The primary
// is always included (single-account keys behave exactly as before); ADDITIONAL
// accounts contribute only when they bill this one meter alone, so another
// property's bills are never mixed in.
export async function fetchStatementsForMpan(
  client: OctopusClient,
  token: string,
  mpan: string,
  primaryAccountNumber: string,
  primaryAccountData: AccountData,
): Promise<MeterStatementsResult> {
  let others: string[] = [];
  try {
    others = (await fetchAccountNumbers(client, token)).filter((n) => n !== primaryAccountNumber);
  } catch {
    others = []; // best-effort: never let account discovery break the primary fetch
  }

  const byId = new Map<string, StatementNode>();
  let incomplete = false;
  let accountsWithMeter = 0;

  for (const num of [primaryAccountNumber, ...others]) {
    const isPrimary = num === primaryAccountNumber;
    let acct: AccountData;
    if (isPrimary) {
      acct = primaryAccountData;
    } else {
      try {
        acct = await fetchAccount(client, num);
      } catch {
        continue; // sibling accounts are additive — a failure to read one never sinks the run
      }
    }
    // Primary: include as before. Additional accounts: only if they bill this meter
    // (and nothing else), so another property's charges can't be mis-attributed.
    if (isPrimary ? !accountHasMpan(acct, mpan) : !accountSafeForMpan(acct, mpan)) continue;
    accountsWithMeter++;
    const res = await fetchStatements(client, token, num);
    if (res.incomplete) incomplete = true;
    for (const s of res.statements) {
      const key = s.id != null ? String(s.id) : `${String(s.startAt)}|${String(s.endAt)}`;
      if (!byId.has(key)) byId.set(key, s);
    }
  }

  return { statements: [...byId.values()], incomplete, accountsWithMeter };
}
