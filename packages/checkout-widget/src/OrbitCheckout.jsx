import React, { useEffect, useMemo, useState } from 'react';
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { FreighterModule, FREIGHTER_ID } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { AlbedoModule, ALBEDO_ID } from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { LobstrModule, LOBSTR_ID } from '@creit.tech/stellar-wallets-kit/modules/lobstr';
import { HanaModule, HANA_ID } from '@creit.tech/stellar-wallets-kit/modules/hana';
import { xBullModule, XBULL_ID } from '@creit.tech/stellar-wallets-kit/modules/xbull';
import { Networks } from '@stellar/stellar-sdk';
import { authorizePlan } from './soroban';

const STORAGE_KEY = 'orbit:selected-wallet';
const WALLET_MODULES = [
  [FREIGHTER_ID, 'Freighter', FreighterModule], [ALBEDO_ID, 'Albedo', AlbedoModule],
  [LOBSTR_ID, 'Lobstr', LobstrModule], [HANA_ID, 'Hana', HanaModule], [XBULL_ID, 'xBull', xBullModule],
];
const DEFAULT_WALLETS = WALLET_MODULES.map(([id]) => id);
const DEMO_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export default function OrbitCheckout({
  planId, planData, apiUrl = 'http://localhost:3001', demo = false,
  allowedWallets = DEFAULT_WALLETS,
  orbitContractId = import.meta.env.VITE_ORBIT_CONTRACT_ID,
  tokenContractId = import.meta.env.VITE_USDC_CONTRACT_ID,
  rpcUrl = import.meta.env.VITE_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase = import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
}) {
  const walletChoices = useMemo(() => WALLET_MODULES.filter(([id]) => allowedWallets.includes(id)), [allowedWallets]);
  const [plan, setPlan] = useState(planData || null);
  const [loading, setLoading] = useState(!planData);
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [showWallets, setShowWallets] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    StellarWalletsKit.init({ modules: walletChoices.map(([, , Module]) => new Module()) });
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && walletChoices.some(([id]) => id === saved)) {
      StellarWalletsKit.setWallet(saved);
      StellarWalletsKit.getAddress().then(({ address: value }) => setAddress(value)).catch(() => {});
    }
  }, [walletChoices]);

  useEffect(() => {
    if (planData || !planId) return;
    const controller = new AbortController();
    fetch(`${apiUrl}/plans/${planId}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? 'Plan not found.' : 'Unable to load this plan.');
        return response.json();
      })
      .then(({ plan: value }) => setPlan(value))
      .catch((reason) => reason.name !== 'AbortError' && setError(reason.message))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [apiUrl, planData, planId]);

  const connect = async (walletId) => {
    try {
      setError(''); StellarWalletsKit.setWallet(walletId);
      const result = await StellarWalletsKit.getAddress();
      localStorage.setItem(STORAGE_KEY, walletId); setAddress(result.address); setIsDemo(false); setReceipt(null); setShowWallets(false);
    } catch (reason) { setError(reason?.message || 'Wallet connection was cancelled.'); }
  };

  const disconnect = async () => {
    if (!isDemo) await StellarWalletsKit.disconnect().catch(() => {});
    localStorage.removeItem(STORAGE_KEY); setAddress(''); setIsDemo(false); setReceipt(null);
  };

  const subscribe = async () => {
    setProcessing(true); setError('');
    try {
      if (isDemo) {
        setReceipt({ demo: true });
        return;
      }
      const hashes = await authorizePlan({ wallet: StellarWalletsKit, address,
        merchantAddress: plan.merchants.wallet_address, amount: plan.usdc_amount,
        intervalSeconds: plan.interval_seconds, orbitContractId, tokenContractId, rpcUrl, networkPassphrase });
      const response = await fetch(`${apiUrl}/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_id: plan.id || planId, customer_wallet_address: address }) });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not record the subscription.');
      setReceipt(hashes);
    } catch (reason) { setError(reason?.message || 'Authorization failed. No subscription was recorded.'); }
    finally { setProcessing(false); }
  };

  if (loading) return <div style={styles.card}>Loading checkout…</div>;
  if (!plan) return <div role="alert" style={styles.card}>{error || 'Plan not found.'}</div>;
  return <section style={styles.card} aria-label="Orbit checkout">
    <p style={styles.eyebrow}>{plan.merchants?.name || 'Orbit merchant'}</p><h2>{plan.name}</h2>
    <p style={styles.price}>${(Number(plan.usdc_amount) / 10_000_000).toFixed(2)} USDC</p>
    <p>Billed every {Math.max(1, Math.round(Number(plan.interval_seconds) / 86400))} days</p>
    {receipt ? <div role="status"><h3>{receipt.demo ? 'Demo complete — nothing was signed' : 'Subscription active'}</h3>{receipt.vaultHash && <a href={`https://stellar.expert/explorer/testnet/tx/${receipt.vaultHash}`} target="_blank" rel="noreferrer">View vault transaction</a>}<br/><button style={styles.cancel} onClick={disconnect}>Start over</button></div>
      : address ? <><p><strong>{isDemo ? 'Demo address' : 'Wallet'}:</strong> {address.slice(0, 8)}…{address.slice(-5)}</p>{isDemo && <p role="note">Demo mode never signs transactions or creates a subscription.</p>}<button style={styles.button} disabled={processing} onClick={subscribe}>{processing ? 'Approve in your wallet…' : isDemo ? 'Preview success state' : 'Approve & activate vault'}</button><button style={styles.cancel} onClick={() => setShowWallets(true)}>Switch wallet</button><button style={styles.cancel} onClick={disconnect}>Disconnect</button></>
      : <button style={styles.button} onClick={() => setShowWallets(true)}>Connect wallet</button>}
    {error && <p role="alert" style={styles.error}>{error}</p>}
    {showWallets && <div role="dialog" aria-modal="true" aria-labelledby="wallet-title" style={styles.dialog}>
      <h3 id="wallet-title">Choose a Stellar wallet</h3>
      {walletChoices.map(([id, name]) => <button key={id} style={styles.wallet} onClick={() => connect(id)}>{name}</button>)}
      {demo && <button style={styles.wallet} onClick={() => { setAddress(DEMO_ADDRESS); setIsDemo(true); setShowWallets(false); }}>Continue in demo mode (no signing)</button>}
      <button style={styles.cancel} onClick={() => setShowWallets(false)}>Cancel</button></div>}
  </section>;
}

const styles = {
  card: { fontFamily: 'Inter, system-ui, sans-serif', maxWidth: 440, margin: '24px auto', padding: 28, border: '1px solid #ddd', borderRadius: 16, background: '#fff', position: 'relative' },
  eyebrow: { color: '#666', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }, price: { fontSize: 30, fontWeight: 700 },
  button: { width: '100%', padding: 14, border: 0, borderRadius: 9, background: '#111', color: '#fff', fontWeight: 700, cursor: 'pointer' },
  dialog: { position: 'absolute', inset: 16, padding: 24, borderRadius: 14, background: '#fff', boxShadow: '0 12px 50px #0004', zIndex: 2 },
  wallet: { width: '100%', padding: 12, marginBottom: 8, textAlign: 'left', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer' },
  cancel: { border: 0, background: 'transparent', padding: 8, cursor: 'pointer' }, error: { color: '#b42318', fontSize: 13 },
};
