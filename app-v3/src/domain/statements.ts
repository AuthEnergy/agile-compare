import type {
  StatementCredit,
  StatementNode,
  StatementSummary,
  TransactionNode,
} from '../types/api';

// Summarise a statement's transactions into the electricity bill-charge total,
// the billed kWh Octopus actually invoiced, and any credits — kept strictly
// separate so referral/goodwill credits are never netted into a comparison, and
// gas charges on a dual-fuel account are not summed into the electricity figure.
export function summariseStatementTransactions(
  statementNode: StatementNode | null | undefined,
): StatementSummary {
  const txns = statementNode?.transactions;
  if (!txns || !Array.isArray(txns.edges)) {
    return {
      available: false,
      complete: true,
      electricityChargePence: null,
      billedKwh: null,
      creditsPence: 0,
      credits: [],
      charges: [],
    };
  }
  const nodes: TransactionNode[] = txns.edges
    .map((e) => e?.node)
    .filter((n): n is TransactionNode => Boolean(n));
  const grossOf = (n: TransactionNode): number =>
    n.amounts && typeof n.amounts.gross === 'number' ? n.amounts.gross : 0;

  const billCharges = nodes.filter((n) => n.__typename === 'BillCharge');
  // Prefer charges titled "Electricity"; fall back to any bill-charge carrying a
  // consumption quantity (single-fuel accounts with a different title).
  let electricityCharges = billCharges.filter((n) => /electric/i.test(n.title ?? ''));
  if (electricityCharges.length === 0) {
    electricityCharges = billCharges.filter(
      (n) => n.consumption != null && n.consumption.quantity != null,
    );
  }

  let electricityChargePence: number | null = null;
  let billedKwh: number | null = null;
  for (const c of electricityCharges) {
    electricityChargePence = (electricityChargePence ?? 0) + grossOf(c);
    if (c.consumption && c.consumption.quantity != null) {
      billedKwh = (billedKwh ?? 0) + Number(c.consumption.quantity);
    }
  }

  const creditNodes = nodes.filter((n) => n.__typename === 'BillCredit');
  let creditsPence = 0;
  const credits: StatementCredit[] = creditNodes.map((n) => {
    const grossPence = grossOf(n);
    creditsPence += grossPence;
    return { title: n.title ?? 'Credit', reasonCode: n.reasonCode ?? '', grossPence };
  });

  return {
    available: true,
    complete: !(txns.pageInfo && txns.pageInfo.hasNextPage),
    electricityChargePence,
    billedKwh,
    creditsPence,
    credits,
    charges: electricityCharges.map((c) => ({
      title: c.title ?? 'Charge',
      grossPence: grossOf(c),
      kwh: c.consumption && c.consumption.quantity != null ? Number(c.consumption.quantity) : null,
    })),
  };
}

// True when billed kWh and the half-hourly readings diverge enough that
// comparing their costs would mislead. Threshold = max(50 kWh, 2% of billed).
export function billedKwhMismatch(
  billedKwh: number | null | undefined,
  observedKwh: number | null | undefined,
): boolean {
  if (billedKwh == null || observedKwh == null) return false;
  const threshold = Math.max(50, 0.02 * Math.abs(billedKwh));
  return Math.abs(billedKwh - observedKwh) > threshold;
}
