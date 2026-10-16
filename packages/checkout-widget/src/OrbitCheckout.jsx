import React, { useEffect, useMemo, useState } from 'react';
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { FreighterModule, FREIGHTER_ID } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { AlbedoModule, ALBEDO_ID } from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { LobstrModule, LOBSTR_ID } from '@creit.tech/stellar-wallets-kit/modules/lobstr';
import { HanaModule, HANA_ID } from '@creit.tech/stellar-wallets-kit/modules/hana';
import { xBullModule, XBULL_ID } from '@creit.tech/stellar-wallets-kit/modules/xbull';
import { Networks, rpc } from '@stellar/stellar-sdk';
import { authorizePlan, PendingTransactionError, pollTransaction, preflightPlan } from './soroban';

const STORAGE_KEY = 'orbit:selected-wallet';
const PENDING_KEY = 'orbit:pending-transaction';
const WALLET_MODULES = [[FREIGHTER_ID, 'Freighter', FreighterModule], [ALBEDO_ID, 'Albedo', AlbedoModule], [LOBSTR_ID, 'Lobstr', LobstrModule], [HANA_ID, 'Hana', HanaModule], [XBULL_ID, 'xBull', xBullModule]];
const DEFAULT_WALLETS = WALLET_MODULES.map(([id]) => id);
const DEMO_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const RADIUS = { none: '0', sm: '4px', md: '10px', lg: '18px', full: '999px' };

export default function OrbitCheckout({
  planId, planData, apiUrl = 'http://localhost:3001', demo = false, allowedWallets = DEFAULT_WALLETS,
  orbitContractId = import.meta.env.VITE_ORBIT_CONTRACT_ID, tokenContractId = import.meta.env.VITE_USDC_CONTRACT_ID,
  rpcUrl = import.meta.env.VITE_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase = import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
  theme = 'auto', accentColor = '#6366f1', borderRadius = 'md', fontFamily = 'inherit', customClasses = {}, allowedOrigins = [],
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
  const [feeEstimate, setFeeEstimate] = useState(null);
  const [pending, setPending] = useState(null);
  const [confirmingSeconds, setConfirmingSeconds] = useState(60);
  const [confirming, setConfirming] = useState(false);
  const actualTheme = theme === 'auto' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : theme;
  const rootStyle = { '--orbit-accent': accentColor, '--orbit-radius': RADIUS[borderRadius] || RADIUS.md, '--orbit-font': fontFamily, '--orbit-surface': actualTheme === 'dark' ? '#171923' : '#fff', '--orbit-text': actualTheme === 'dark' ? '#f8fafc' : '#101828', '--orbit-muted': actualTheme === 'dark' ? '#a7b0c0' : '#667085', '--orbit-border': actualTheme === 'dark' ? '#34394a' : '#d0d5dd', '--orbit-error': actualTheme === 'dark' ? '#ffb4ab' : '#b42318' };

  const dispatch = (type, detail = {}) => {
    if (typeof window === 'undefined' || window.parent === window) return;
    const origins = allowedOrigins.length ? allowedOrigins : [window.location.origin];
    origins.forEach((origin) => window.parent.postMessage({ type, ...detail }, origin));
  };

  useEffect(() => {
    StellarWalletsKit.init({ modules: walletChoices.map(([, , Module]) => new Module()) });
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && walletChoices.some(([id]) => id === saved)) {
      StellarWalletsKit.setWallet(saved);
      StellarWalletsKit.getAddress().then(({ address: value }) => { setAddress(value); dispatch('orbit:wallet_connected', { address: value }); }).catch(() => {});
    }
  }, [walletChoices]);

  useEffect(() => {
    if (planData || !planId) return undefined;
    const controller = new AbortController();
    fetch(`${apiUrl}/plans/${planId}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 404 ? 'Plan not found.' : 'Unable to load this plan.');
      return response.json();
    }).then(({ plan: value }) => setPlan(value)).catch((reason) => reason.name !== 'AbortError' && setError(reason.message)).finally(() => setLoading(false));
    return () => controller.abort();
  }, [apiUrl, planData, planId]);

  useEffect(() => { if (plan) dispatch('orbit:ready', { planId: plan.id || planId }); }, [plan, planId]);

  useEffect(() => {
    const saved = localStorage.getItem(PENDING_KEY);
    if (!saved) return undefined;
    let transaction;
    try { transaction = JSON.parse(saved); } catch { localStorage.removeItem(PENDING_KEY); return undefined; }
    setPending(transaction);
    pollTransaction(new rpc.Server(rpcUrl), transaction.hash, { onProgress: ({ remainingMs }) => setConfirmingSeconds(Math.ceil(remainingMs / 1000)) }).then(() => {
      localStorage.removeItem(PENDING_KEY); setPending(null); setReceipt({ vaultHash: transaction.hash, recovered: true });
    }).catch((reason) => { if (!(reason instanceof PendingTransactionError)) { localStorage.removeItem(PENDING_KEY); setPending(null); } });
    return undefined;
  }, [rpcUrl]);

  const connect = async (walletId) => {
    try {
      setError(''); StellarWalletsKit.setWallet(walletId);
      const result = await StellarWalletsKit.getAddress();
      localStorage.setItem(STORAGE_KEY, walletId); setAddress(result.address); setIsDemo(false); setReceipt(null); setShowWallets(false); dispatch('orbit:wallet_connected', { address: result.address });
    } catch (reason) { const message = reason?.message || 'Wallet connection was cancelled.'; setError(message); dispatch('orbit:error', { message }); }
  };

  const disconnect = async () => {
    if (!isDemo) await StellarWalletsKit.disconnect().catch(() => {});
    localStorage.removeItem(STORAGE_KEY); setAddress(''); setIsDemo(false); setReceipt(null); dispatch('orbit:close');
  };

  const subscribe = async () => {
    setProcessing(true); setError('');
    try {
      if (isDemo) { setReceipt({ demo: true }); return; }
      const preflight = await preflightPlan({ address, merchantAddress: plan.merchants.wallet_address, amount: plan.usdc_amount, intervalSeconds: plan.interval_seconds, orbitContractId, tokenContractId, rpcUrl, networkPassphrase });
      setFeeEstimate(preflight); setConfirming(true); setConfirmingSeconds(60);
      const hashes = await authorizePlan({ wallet: StellarWalletsKit, address, merchantAddress: plan.merchants.wallet_address, amount: plan.usdc_amount, intervalSeconds: plan.interval_seconds, orbitContractId, tokenContractId, rpcUrl, networkPassphrase, preflight, onSubmitted: ({ stage, hash }) => { localStorage.setItem(PENDING_KEY, JSON.stringify({ stage, hash, planId: plan.id || planId })); setPending({ stage, hash }); }, onProgress: ({ remainingMs }) => setConfirmingSeconds(Math.ceil(remainingMs / 1000)) });
      const response = await fetch(`${apiUrl}/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan_id: plan.id || planId, customer_wallet_address: address }) });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not record the subscription.');
      const subscription = await response.json();
      localStorage.removeItem(PENDING_KEY); setPending(null); setReceipt(hashes); dispatch('orbit:subscribed', { subscriptionId: subscription.id, planId: plan.id || planId, txHash: hashes.vaultHash });
    } catch (reason) {
      if (reason instanceof PendingTransactionError) setPending({ stage: 'transaction', hash: reason.hash });
      else { const message = reason?.message || 'Authorization failed. No subscription was recorded.'; setError(message); dispatch('orbit:error', { message }); }
    } finally { setConfirming(false); setProcessing(false); }
  };

  const checkPending = async () => {
    if (!pending) return;
    setProcessing(true); setError(''); setConfirming(true);
    try { await pollTransaction(new rpc.Server(rpcUrl), pending.hash, { onProgress: ({ remainingMs }) => setConfirmingSeconds(Math.ceil(remainingMs / 1000)) }); localStorage.removeItem(PENDING_KEY); setPending(null); setReceipt({ vaultHash: pending.hash, recovered: true }); }
    catch (reason) { if (!(reason instanceof PendingTransactionError)) setError(reason.message); }
    finally { setConfirming(false); setProcessing(false); }
  };

  if (loading) return <div className={customClasses.modal} style={{ ...styles.card, ...rootStyle }}>Loading checkout...</div>;
  if (!plan) return <div role="alert" className={customClasses.modal} style={{ ...styles.card, ...rootStyle }}>{error || 'Plan not found.'}</div>;
  return <section className={`orbit-checkout-root ${customClasses.modal || ''}`} style={{ ...styles.card, ...rootStyle }} aria-label="Orbit checkout">
    <style>{`.orbit-checkout-root { isolation: isolate; } .orbit-checkout-root .orbit-fee, .orbit-checkout-root .orbit-pending { margin: 16px 0; padding: 12px; border: 1px solid var(--orbit-border); border-radius: var(--orbit-radius); } .orbit-checkout-root .orbit-confirming { color: var(--orbit-accent); font-weight: 600; } @keyframes orbit-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } } @media (prefers-reduced-motion: reduce) { .orbit-checkout-root { animation: none; } }`}</style>
    <div className={customClasses.header}><p style={styles.eyebrow}>{plan.merchants?.name || 'Orbit merchant'}</p><h2>{plan.name}</h2></div>
    <p style={styles.price}>${(Number(plan.usdc_amount) / 10000000).toFixed(2)} USDC</p><p>Billed every {Math.max(1, Math.round(Number(plan.interval_seconds) / 86400))} days</p>
    {feeEstimate && <div className="orbit-fee" role="status"><strong>Estimated network fees</strong><br />About {(Number(feeEstimate.estimatedFeeStroops) / 10000000).toFixed(4)} XLM for both transactions.<br /><small>USDC balance: {(Number(feeEstimate.usdcBalance) / 10000000).toFixed(2)}. XLM balance: {(Number(feeEstimate.xlmBalance) / 10000000).toFixed(4)}.</small></div>}
    {confirming && <p className="orbit-confirming" role="status">Confirming on Stellar testnet... {confirmingSeconds}s remaining</p>}
    {pending && <div role="status" className="orbit-pending"><h3>Transaction Pending</h3><p>Stellar is still processing this transaction. Your funds are not lost.</p><code>{pending.hash}</code><p><a href={`https://stellar.expert/explorer/testnet/tx/${pending.hash}`} target="_blank" rel="noreferrer">View on Stellar Expert</a></p><button className={customClasses.button} style={styles.button} disabled={processing} onClick={checkPending}>Check Again</button></div>}
    {receipt ? <div role="status"><h3>{receipt.demo ? 'Demo complete - nothing was signed' : 'Subscription active'}</h3>{receipt.vaultHash && <a href={`https://stellar.expert/explorer/testnet/tx/${receipt.vaultHash}`} target="_blank" rel="noreferrer">View vault transaction</a>}<br /><button style={styles.cancel} onClick={disconnect}>Start over</button></div> : !pending && (address ? <><p><strong>{isDemo ? 'Demo address' : 'Wallet'}:</strong> {address.slice(0, 8)}...{address.slice(-5)}</p>{isDemo && <p role="note">Demo mode never signs transactions or creates a subscription.</p>}<button className={customClasses.button} style={styles.button} disabled={processing} onClick={subscribe}>{processing ? 'Preparing transaction...' : isDemo ? 'Preview success state' : 'Subscribe & Approve'}</button><button style={styles.cancel} onClick={() => setShowWallets(true)}>Switch wallet</button><button style={styles.cancel} onClick={disconnect}>Disconnect</button></> : <button className={customClasses.button} style={styles.button} onClick={() => setShowWallets(true)}>Connect wallet</button>)}
    {error && <p role="alert" style={styles.error}>{error}</p>}
    {showWallets && <div role="dialog" aria-modal="true" aria-labelledby="wallet-title" style={styles.dialog}><h3 id="wallet-title">Choose a Stellar wallet</h3>{walletChoices.map(([id, name]) => <button key={id} style={styles.wallet} onClick={() => connect(id)}>{name}</button>)}{demo && <button style={styles.wallet} onClick={() => { setAddress(DEMO_ADDRESS); setIsDemo(true); setShowWallets(false); dispatch('orbit:wallet_connected', { address: DEMO_ADDRESS }); }}>Continue in demo mode (no signing)</button>}<button style={styles.cancel} onClick={() => { setShowWallets(false); dispatch('orbit:close'); }}>Cancel</button></div>}
  </section>;
}

const styles = {
  card: { fontFamily: 'var(--orbit-font)', maxWidth: 440, margin: '24px auto', padding: 28, border: '1px solid var(--orbit-border)', borderRadius: 'var(--orbit-radius)', background: 'var(--orbit-surface)', color: 'var(--orbit-text)', position: 'relative', animation: 'orbit-in 180ms ease-out' },
  eyebrow: { color: 'var(--orbit-muted)', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }, price: { fontSize: 30, fontWeight: 700 },
  button: { width: '100%', padding: 14, border: 0, borderRadius: 'var(--orbit-radius)', background: 'var(--orbit-accent)', color: '#fff', fontWeight: 700, cursor: 'pointer' },
  dialog: { position: 'absolute', inset: 16, padding: 24, borderRadius: 'var(--orbit-radius)', background: 'var(--orbit-surface)', boxShadow: '0 12px 50px #0004', zIndex: 2 },
  wallet: { width: '100%', padding: 12, marginBottom: 8, textAlign: 'left', border: '1px solid var(--orbit-border)', borderRadius: 'var(--orbit-radius)', background: 'var(--orbit-surface)', color: 'var(--orbit-text)', cursor: 'pointer' },
  cancel: { border: 0, background: 'transparent', color: 'var(--orbit-muted)', padding: 8, cursor: 'pointer' }, error: { color: 'var(--orbit-error)', fontSize: 13 },
};
