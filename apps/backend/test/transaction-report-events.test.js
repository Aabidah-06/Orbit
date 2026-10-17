import { describe, it, expect } from 'vitest';
import { Keypair, StrKey, nativeToScVal } from '@stellar/stellar-sdk';
import report from '../transaction-report.js';

const { confirmedSettlementAmount } = report;

function makeEvent({ contractId, customer, merchant, amount = 290000000n }) {
  return {
    contractId: () => StrKey.decodeContract(contractId),
    body: () => ({
      v0: () => ({
        topics: () => [
          nativeToScVal('funds_pulled', { type: 'symbol' }),
          nativeToScVal(customer, { type: 'address' }),
          nativeToScVal(merchant, { type: 'address' }),
        ],
        data: () => nativeToScVal([amount, 1729000000n]),
      }),
    }),
  };
}

function fixture() {
  return {
    contractId: StrKey.encodeContract(Buffer.alloc(32, 9)),
    customer: Keypair.random().publicKey(),
    merchant: Keypair.random().publicKey(),
  };
}

function amountOf(event, f) {
  return confirmedSettlementAmount(
    { events: { contractEventsXdr: [[event]] } },
    { contractId: f.contractId, customerWallet: f.customer, merchantWallet: f.merchant },
  );
}

describe('verified on-chain report amount (#76)', () => {
  it('reads the exact amount from the successful contract event', () => {
    const f = fixture();
    expect(amountOf(makeEvent(f), f)).toBe('290000000');
  });

  it('ignores another contract, including one emitting the same topic', () => {
    const f = fixture();
    const other = { ...f, contractId: StrKey.encodeContract(Buffer.alloc(32, 8)) };
    expect(amountOf(makeEvent(other), f)).toBeNull();
  });

  it('ignores an event for another customer or merchant', () => {
    const f = fixture();
    expect(amountOf(makeEvent({ ...f, customer: Keypair.random().publicKey() }), f)).toBeNull();
    expect(amountOf(makeEvent({ ...f, merchant: Keypair.random().publicKey() }), f)).toBeNull();
  });

  it('does not fabricate settlement amounts when events are missing or negative', () => {
    const f = fixture();
    expect(confirmedSettlementAmount({ status: 'SUCCESS' }, {
      contractId: f.contractId,
      customerWallet: f.customer,
      merchantWallet: f.merchant,
    })).toBeNull();
    expect(amountOf(makeEvent({ ...f, amount: -1n }), f)).toBeNull();
  });
});
