import { describe, it, expect } from 'vitest';
import { billedKwhMismatch, summariseStatementTransactions } from '../../src/domain/statements';
import type { StatementNode } from '../../src/types/api';

function node(edges: unknown[], hasNextPage = false): StatementNode {
  return { transactions: { edges: edges as never, pageInfo: { hasNextPage } } };
}

describe('summariseStatementTransactions', () => {
  it('isolates the electricity charge + billed kWh, keeps credits separate', () => {
    const s = summariseStatementTransactions(
      node([
        {
          node: {
            __typename: 'BillCharge',
            title: 'Electricity',
            amounts: { gross: 12000 },
            consumption: { quantity: 432 },
          },
        },
        {
          node: {
            __typename: 'BillCharge',
            title: 'Gas',
            amounts: { gross: 9000 },
            consumption: { quantity: 800 },
          },
        },
        {
          node: {
            __typename: 'BillCredit',
            title: 'Referral',
            reasonCode: 'REF',
            amounts: { gross: 5000 },
          },
        },
      ]),
    );
    expect(s.available).toBe(true);
    expect(s.electricityChargePence).toBe(12000); // gas NOT summed in
    expect(s.billedKwh).toBe(432);
    expect(s.creditsPence).toBe(5000);
    expect(s.credits).toHaveLength(1);
  });

  it('returns null billedKwh when no charge is titled Electricity (e.g. gas-only period)', () => {
    const s = summariseStatementTransactions(
      node([
        {
          node: {
            __typename: 'BillCharge',
            title: 'Gas',
            amounts: { gross: 7000 },
            consumption: { quantity: 250 },
          },
        },
      ]),
    );
    // Gas-only billing cycles on dual-fuel accounts must not pollute billedKwh.
    expect(s.electricityChargePence).toBeNull();
    expect(s.billedKwh).toBeNull();
  });

  it('marks incomplete when transactions paginate', () => {
    const s = summariseStatementTransactions(
      node(
        [
          {
            node: {
              __typename: 'BillCharge',
              title: 'Electricity',
              amounts: { gross: 1 },
              consumption: { quantity: 1 },
            },
          },
        ],
        true,
      ),
    );
    expect(s.complete).toBe(false);
  });

  it('reports unavailable when there is no transactions block', () => {
    expect(summariseStatementTransactions({}).available).toBe(false);
    expect(summariseStatementTransactions(null).available).toBe(false);
  });
});

describe('billedKwhMismatch', () => {
  it('uses a max(50 kWh, 2%) threshold', () => {
    expect(billedKwhMismatch(1000, 1010)).toBe(false); // within 50
    expect(billedKwhMismatch(1000, 1100)).toBe(true); // 100 > max(50, 20)
    expect(billedKwhMismatch(5000, 5120)).toBe(true); // 120 > 2% (100)
    expect(billedKwhMismatch(null, 100)).toBe(false);
    expect(billedKwhMismatch(100, null)).toBe(false);
  });
});
