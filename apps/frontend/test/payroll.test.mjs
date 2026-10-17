import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateWallets, filterAndSortRecipients, mergeDuplicateRecipients, parsePayrollAmount } from '../src/lib/payroll.ts';

const recipient = (id, walletAddress, amount, name = id) => ({ id, walletAddress, amount, name, role: 'Contractor', network: 'stellar-testnet', status: 'ready' });

test('duplicate merging sums raw token units exactly and preserves the input', () => {
  const input = [recipient('a', 'wallet', 0.1), recipient('b', 'wallet', 0.2), recipient('c', 'other', 1)];
  assert.deepEqual([...duplicateWallets(input)], ['wallet']);
  const output = mergeDuplicateRecipients(input);
  assert.equal(output.length, 2); assert.equal(output[0].amount, 0.3);
  assert.equal(input[0].amount, 0.1); assert.equal(duplicateWallets(output).size, 0);
});
test('completed payments never get merged into the next payroll', () => {
  const input = [{ ...recipient('paid', 'wallet', 2), status: 'disbursed' }, recipient('new', 'wallet', 3)];
  assert.equal(duplicateWallets(input).size, 0); assert.equal(mergeDuplicateRecipients(input).length, 2);
});
test('amount parsing rejects partial numbers, non-finite values, precision loss and overflow', () => {
  for (const amount of ['1abc', 'Infinity', 'NaN', '-1', '0', '0.00000001', '1000000000', '1e3', '900719925.4740991']) assert.equal(parsePayrollAmount(amount), null);
  assert.equal(parsePayrollAmount('0.0000001'), 0.0000001); assert.equal(parsePayrollAmount('100.1234567'), 100.1234567);
});
test('search and amount sorting work for more than 500 recipients without mutating the manifest', () => {
  const input = Array.from({ length: 600 }, (_, i) => recipient(String(i), `wallet-${i}`, i + 1, `Contractor ${i}`));
  assert.equal(filterAndSortRecipients(input, '', 'amount', 'desc')[0].amount, 600);
  assert.equal(filterAndSortRecipients(input, 'WALLET-599', 'name', 'asc')[0].id, '599');
  assert.equal(filterAndSortRecipients(input, 'Contractor 5', 'amount', 'asc').length, 111);
  assert.equal(input[0].id, '0');
});
