import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  Networks,
} from '@stellar/stellar-sdk';
import { signAndSubmit } from './soroban';

// Assets a subscriber can pay with. The plan currency (USDC) is always the
// settlement asset. Issuers are the public Circle / Aqua issuers; verify them
// before enabling a network in production.
const ASSETS_BY_NETWORK = {
  [Networks.PUBLIC]: [
    { code: 'XLM', native: true },
    { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    { code: 'EURC', issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2' },
    { code: 'AQUA', issuer: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA' },
  ],
  [Networks.TESTNET]: [
    { code: 'XLM', native: true },
    { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    { code: 'EURC', issuer: 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVR' },
  ],
};

const HORIZON_BY_NETWORK = {
  [Networks.PUBLIC]: 'https://horizon.stellar.org',
  [Networks.TESTNET]: 'https://horizon-testnet.stellar.org',
};

export const horizonUrlFor = (networkPassphrase) => HORIZON_BY_NETWORK[networkPassphrase] || HORIZON_BY_NETWORK[Networks.TESTNET];

export const payWithAssetsFor = (networkPassphrase) => ASSETS_BY_NETWORK[networkPassphrase] || ASSETS_BY_NETWORK[Networks.TESTNET];

export const assetKey = (asset) => (asset.native ? 'native' : `${asset.code}:${asset.issuer}`);

const toStellarAsset = (asset) => (asset.native ? Asset.native() : new Asset(asset.code, asset.issuer));

export const assetContractId = (asset, networkPassphrase) => toStellarAsset(asset).contractId(networkPassphrase);

// Amounts are 7-decimal fixed point. `toStroops` and `fromStroops` convert to and
// from BigInt raw units so the slippage cap is computed exactly.
const STROOPS = 10_000_000n;

export const toStroops = (decimal) => {
  const [whole, frac = ''] = String(decimal).split('.');
  return BigInt(whole || '0') * STROOPS + BigInt((frac + '0000000').slice(0, 7));
};

export const fromStroops = (stroops) => {
  const value = BigInt(stroops);
  const whole = value / STROOPS;
  const frac = (value % STROOPS).toString().padStart(7, '0');
  return `${whole}.${frac}`;
};

/**
 * Returns the wallet's balances for the assets a subscriber may pay with. Assets
 * with no balance are left out, so the selector only shows what can be spent.
 */
export async function fetchPayWithBalances({ horizonUrl, address, assets, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${horizonUrl}/accounts/${address}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('Could not load wallet balances.');
  const account = await res.json();

  return assets
    .map((asset) => {
      const line = account.balances.find((b) => (asset.native
        ? b.asset_type === 'native'
        : b.asset_code === asset.code && b.asset_issuer === asset.issuer));
      return line ? { ...asset, balance: line.balance } : null;
    })
    .filter((asset) => asset && Number(asset.balance) > 0);
}

// One strict-receive lookup: how much `sourceAsset` is needed to deliver
// `destAmount` of `destAsset`. Returns the cheapest path's source amount.
const strictReceive = async ({ horizonUrl, sourceAsset, destAsset, destAmount, fetchImpl }) => {
  const params = new URLSearchParams({
    destination_asset_type: destAsset.native ? 'native' : 'credit_alphanum4',
    destination_amount: destAmount,
    source_assets: sourceAsset.native ? 'native' : `${sourceAsset.code}:${sourceAsset.issuer}`,
  });
  if (!destAsset.native) {
    params.set('destination_asset_code', destAsset.code);
    params.set('destination_asset_issuer', destAsset.issuer);
  }
  const res = await fetchImpl(`${horizonUrl}/paths/strict-receive?${params.toString()}`);
  if (!res.ok) throw new Error('Could not load a swap quote for this pair.');
  const body = await res.json();
  const records = body?._embedded?.records || [];
  if (records.length === 0) return null;
  return records.reduce((best, record) => (toStroops(record.source_amount) < toStroops(best.source_amount) ? record : best));
};

/**
 * Quotes the swap for a plan. Returns the rate, the price impact against the
 * mid-market rate, and the maximum input the subscriber will authorize after
 * slippage. Returns null when no path exists.
 */
export async function fetchSwapQuote({
  horizonUrl,
  sourceAsset,
  destAsset,
  destAmount,
  slippagePct = 1,
  fetchImpl = globalThis.fetch,
}) {
  const [exact, mid] = await Promise.all([
    strictReceive({ horizonUrl, sourceAsset, destAsset, destAmount, fetchImpl }),
    strictReceive({ horizonUrl, sourceAsset, destAsset, destAmount: '1.0000000', fetchImpl }),
  ]);
  if (!exact || !mid) return null;

  const sourceStroops = toStroops(exact.source_amount);
  const destStroops = toStroops(destAmount);
  const rate = Number(sourceStroops) / Number(destStroops);
  // Mid-market rate: the cost of one whole unit of the destination asset.
  const midRate = Number(toStroops(mid.source_amount)) / Number(toStroops('1.0000000'));
  const priceImpactPct = Math.max(0, (rate / midRate - 1) * 100);

  // Ceil so rounding never caps the input below what the path needs.
  const slippageBps = BigInt(Math.round(slippagePct * 100));
  const maxInputStroops = (sourceStroops * (10_000n + slippageBps) + 9_999n) / 10_000n;

  return {
    path: exact.path || [],
    sourceAmount: fromStroops(sourceStroops),
    maxInputStroops,
    maxInputAmount: fromStroops(maxInputStroops),
    rate,
    midRate,
    priceImpactPct,
    slippagePct,
    sourceAssetCode: sourceAsset.code,
    destAssetCode: destAsset.code,
  };
}

const buildSwapSubscribeTransaction = ({
  account,
  address,
  merchantAddress,
  orbitContractId,
  paymentTokenContractId,
  settlementTokenContractId,
  routerAddress,
  amount,
  intervalSeconds,
  maxInputStroops,
  paymentAllowanceStroops,
  allowanceLiveUntilLedger,
  networkPassphrase,
}) => new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
  .addOperation(new Contract(orbitContractId).call(
    'create_vault_with_swap',
    Address.fromString(address).toScVal(),
    Address.fromString(merchantAddress).toScVal(),
    Address.fromString(paymentTokenContractId).toScVal(),
    Address.fromString(settlementTokenContractId).toScVal(),
    Address.fromString(routerAddress).toScVal(),
    nativeToScVal(BigInt(amount), { type: 'i128' }),
    nativeToScVal(BigInt(intervalSeconds), { type: 'u64' }),
    nativeToScVal(maxInputStroops, { type: 'i128' }),
    nativeToScVal(paymentAllowanceStroops, { type: 'i128' }),
    nativeToScVal(allowanceLiveUntilLedger, { type: 'u32' }),
  ))
  .setTimeout(60)
  .build();

/**
 * Subscribes and sets up the swap in one signed Soroban transaction. The
 * contract creates the vault, stores the swap config, and approves the
 * payment-token allowance together, so the flow either settles fully or reverts.
 */
export async function authorizeSwapPlan({
  wallet,
  address,
  merchantAddress,
  amount,
  intervalSeconds,
  orbitContractId,
  settlementTokenContractId,
  paymentTokenContractId,
  routerAddress,
  maxInputStroops,
  rpcUrl,
  networkPassphrase,
  billingCycles = 12,
  onSubmitted,
  onProgress,
}) {
  if (!routerAddress) throw new Error('This merchant has not approved a swap router for that token yet.');
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(address);
  const ledger = await server.getLatestLedger();
  const ledgersPerCycle = Math.ceil(Number(intervalSeconds) / 5);
  const liveUntilLedger = Number(ledger.sequence) + Math.max(120960, ledgersPerCycle * billingCycles + 120960);
  const paymentAllowanceStroops = BigInt(maxInputStroops) * BigInt(billingCycles);

  const transaction = buildSwapSubscribeTransaction({
    account,
    address,
    merchantAddress,
    orbitContractId,
    paymentTokenContractId,
    settlementTokenContractId,
    routerAddress,
    amount,
    intervalSeconds,
    maxInputStroops: BigInt(maxInputStroops),
    paymentAllowanceStroops,
    allowanceLiveUntilLedger: liveUntilLedger,
    networkPassphrase,
  });

  return signAndSubmit({ server, transaction, wallet, address, networkPassphrase, stage: 'vault', onSubmitted, onProgress });
}
