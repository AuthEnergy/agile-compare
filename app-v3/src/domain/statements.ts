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
  // Only accept charges explicitly titled "Electricity" (case-insensitive). No
  // fallback — on dual-fuel accounts the fallback previously picked up Gas charges
  // from gas-only billing cycles, producing wildly wrong billedKwh. If a period
  // has no electricity BillCharge, billedKwh stays null (no mismatch fired).
  const electricityCharges = billCharges.filter((n) => /electric/i.test(n.title ?? ''));

  // For billedKwh: count only IMPORT charges (positive grossPence = customer pays).
  // On solar/battery accounts Octopus creates a companion export BillCharge with
  // negative grossPence (Octopus pays the customer); summing both inflates billedKwh
  // far above what the import meter recorded. electricityChargePence keeps all charges
  // so the net cost (import − export revenue) is correct for the "you paid" comparison.
  let electricityChargePence: number | null = null;
  let billedKwh: number | null = null;
  for (const c of electricityCharges) {
    const gross = grossOf(c);
    electricityChargePence = (electricityChargePence ?? 0) + gross;
    if (gross >= 0 && c.consumption && c.consumption.quantity != null) {
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
