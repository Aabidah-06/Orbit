import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

export const SESSION_KEY_STORAGE = 'orbit:session-key';
export const SMART_WALLET_ID = 'orbit:smart-wallet-session';

/**
 * Checks if local web storage is available for session key persistence.
 */
export function isSessionKeySupported() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/**
 * Retrieves the currently active delegated session key if it exists and has not expired.
 */
export function getActiveSessionKey() {
  if (!isSessionKeySupported()) return null;
  const raw = localStorage.getItem(SESSION_KEY_STORAGE);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw);
    if (!session || !session.secret) return null;

    if (session.expiresAt && Date.now() > session.expiresAt) {
      localStorage.removeItem(SESSION_KEY_STORAGE);
      return null;
    }

    const keypair = Keypair.fromSecret(session.secret);
    return {
      ...session,
      keypair,
      address: keypair.publicKey(),
    };
  } catch {
    localStorage.removeItem(SESSION_KEY_STORAGE);
    return null;
  }
}

/**
 * Creates and persists a delegated session key for frictionless 1-click checkout.
 *
 * @param {Object} options
 * @param {string} [options.delegatedBy] - The master wallet address or user ID delegating authority.
 * @param {number} [options.validDurationMs] - Session validity duration in milliseconds (default 24h).
 * @param {Object} [options.permissions] - Fine-grained capability permissions.
 */
export function createDelegatedSessionKey({
  delegatedBy = null,
  validDurationMs = 24 * 60 * 60 * 1000,
  permissions = { maxSpendUsdc: 'unlimited', autoRenew: true },
} = {}) {
  if (!isSessionKeySupported()) {
    throw new Error('Web storage is not available on this platform to persist session keys.');
  }

  const keypair = Keypair.random();
  const session = {
    address: keypair.publicKey(),
    secret: keypair.secret(),
    delegatedBy,
    createdAt: Date.now(),
    expiresAt: Date.now() + validDurationMs,
    permissions,
  };

  localStorage.setItem(SESSION_KEY_STORAGE, JSON.stringify(session));
  return {
    ...session,
    keypair,
  };
}

/**
 * Revokes the delegated session key and removes it from local storage.
 */
export function revokeSessionKey() {
  if (isSessionKeySupported()) {
    localStorage.removeItem(SESSION_KEY_STORAGE);
  }
}

/**
 * Wallet Adapter for Smart Wallet Session Keys.
 * Enables zero-prompt, frictionless signing using the delegated session keypair.
 */
export class SessionWalletAdapter {
  constructor(session) {
    this.session = session;
    this.keypair = session.keypair || Keypair.fromSecret(session.secret);
    this.name = 'Smart Wallet Session';
    this.id = SMART_WALLET_ID;
    this.isSessionKey = true;
  }

  async getAddress() {
    return { address: this.keypair.publicKey() };
  }

  async signTransaction(xdr, { networkPassphrase = Networks.TESTNET } = {}) {
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    tx.sign(this.keypair);
    return { signedTxXdr: tx.toXDR() };
  }

  async disconnect() {
    revokeSessionKey();
    return true;
  }
}
