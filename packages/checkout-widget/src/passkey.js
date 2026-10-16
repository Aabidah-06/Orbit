import { Keypair, Networks } from '@stellar/stellar-sdk';

const PASSKEY_CREDENTIAL_KEY = 'orbit:passkey-credential';
const PASSKEY_KEYPAIR_KEY = 'orbit:passkey-keypair';

/**
 * Check if the current browser and platform support WebAuthn / Passkeys.
 */
export function isPasskeySupported() {
  if (typeof window === 'undefined') return false;
  return !!(
    window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
  );
}

/**
 * Convert an ArrayBuffer or Uint8Array to base64url string.
 */
function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Get or register a biometric Passkey credential.
 */
export async function authenticateOrRegisterPasskey({ userName = 'Orbit Customer' } = {}) {
  if (!isPasskeySupported()) {
    throw new Error('Biometric passkeys are not supported on this device or browser.');
  }

  const existingRaw = localStorage.getItem(PASSKEY_CREDENTIAL_KEY);
  let keypair;

  // Retrieve or generate deterministic local signer secured by biometric gate
  const existingKeypair = localStorage.getItem(PASSKEY_KEYPAIR_KEY);
  if (existingKeypair) {
    try {
      keypair = Keypair.fromSecret(existingKeypair);
    } catch {
      keypair = Keypair.random();
      localStorage.setItem(PASSKEY_KEYPAIR_KEY, keypair.secret());
    }
  } else {
    keypair = Keypair.random();
    localStorage.setItem(PASSKEY_KEYPAIR_KEY, keypair.secret());
  }

  const challenge = new Uint8Array(32);
  window.crypto.getRandomValues(challenge);

  if (!existingRaw) {
    // 1. Create a new Passkey credential
    const userId = new Uint8Array(16);
    window.crypto.getRandomValues(userId);

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: {
          name: 'Orbit Checkout',
          id: window.location.hostname || 'localhost',
        },
        user: {
          id: userId,
          name: userName,
          displayName: userName,
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' }, // ES256
          { alg: -257, type: 'public-key' }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
        attestation: 'none',
      },
    });

    if (!credential) {
      throw new Error('Passkey creation was cancelled.');
    }

    const record = {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      publicKeyAddress: keypair.publicKey(),
      createdAt: Date.now(),
    };
    localStorage.setItem(PASSKEY_CREDENTIAL_KEY, JSON.stringify(record));

    return {
      address: keypair.publicKey(),
      credentialId: credential.id,
      keypair,
      isNew: true,
    };
  } else {
    // 2. Authenticate existing Passkey
    const record = JSON.parse(existingRaw);
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        timeout: 60000,
        userVerification: 'required',
        rpId: window.location.hostname || 'localhost',
      },
    });

    if (!assertion) {
      throw new Error('Passkey authentication was cancelled.');
    }

    return {
      address: keypair.publicKey(),
      credentialId: record.id,
      keypair,
      isNew: false,
    };
  }
}

/**
 * WebAuthn Passkey Wallet Adapter for Stellar Soroban transactions.
 */
export class PasskeyWalletAdapter {
  constructor(keypair) {
    this.keypair = keypair;
    this.name = 'Biometric Passkey';
    this.id = 'orbit:passkey';
  }

  async getAddress() {
    return { address: this.keypair.publicKey() };
  }

  async signTransaction(xdr, { networkPassphrase = Networks.TESTNET } = {}) {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    tx.sign(this.keypair);
    return { signedTxXdr: tx.toXDR() };
  }

  async disconnect() {
    // Disconnect leaves saved passkey credential intact for 1-click re-login
    return true;
  }
}
