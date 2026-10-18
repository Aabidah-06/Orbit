/**
 * Issue #186: Transaction Acceleration Hook
 * Detects stalled transactions and provides fee bump functionality
 */

import { useState, useEffect, useCallback } from 'react';
import { FeeBumpTransaction, Transaction, Networks } from '@stellar/stellar-sdk';

export interface TransactionState {
  hash: string;
  status: 'pending' | 'stalled' | 'confirmed' | 'failed';
  submittedAt: number;
  baseFee: string;
  originalXDR?: string;
}

const STALL_THRESHOLD_MS = 15000; // 15 seconds

export function useTransactionAccelerator(
  transactionHash: string | null,
  rpcUrl: string
) {
  const [txState, setTxState] = useState<TransactionState | null>(null);
  const [isStalled, setIsStalled] = useState(false);
  const [canAccelerate, setCanAccelerate] = useState(false);

  // Poll transaction status
  useEffect(() => {
    if (!transactionHash) return;

    const pollStatus = async () => {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: { hash: transactionHash },
          }),
        });

        const data = await response.json();
        const status = data.result?.status || 'pending';

        setTxState(prev => ({
          ...prev!,
          hash: transactionHash,
          status,
        }));

        // Check for stall
        if (prev && status === 'pending') {
          const elapsed = Date.now() - prev.submittedAt;
          if (elapsed > STALL_THRESHOLD_MS) {
            setIsStalled(true);
            setCanAccelerate(true);
          }
        }
      } catch (error) {
        console.error('Failed to poll transaction status:', error);
      }
    };

    const interval = setInterval(pollStatus, 3000);
    return () => clearInterval(interval);
  }, [transactionHash, rpcUrl]);

  const createFeeBumpTransaction = useCallback(
    async (
      originalXDR: string,
      feeSourcePublicKey: string,
      newBaseFee: string
    ): Promise<string> => {
      try {
        // Parse original transaction
        const innerTx = new Transaction(originalXDR, Networks.TESTNET);

        // Create fee bump with double the original fee
        const feeBumpTx = FeeBumpTransaction.buildFeeBumpTransaction(
          feeSourcePublicKey,
          newBaseFee,
          innerTx,
          Networks.TESTNET
        );

        return feeBumpTx.toXDR();
      } catch (error) {
        console.error('Failed to create fee bump transaction:', error);
        throw error;
      }
    },
    []
  );

  const submitFeeBump = useCallback(
    async (feeBumpXDR: string): Promise<string> => {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: { transaction: feeBumpXDR },
          }),
        });

        const data = await response.json();
        const newHash = data.result?.hash;

        if (!newHash) {
          throw new Error('Failed to submit fee bump transaction');
        }

        // Update state with new hash
        setTxState({
          hash: newHash,
          status: 'pending',
          submittedAt: Date.now(),
          baseFee: txState?.baseFee || '100',
        });

        setIsStalled(false);
        setCanAccelerate(false);

        return newHash;
      } catch (error) {
        console.error('Failed to submit fee bump:', error);
        throw error;
      }
    },
    [rpcUrl, txState]
  );

  return {
    txState,
    isStalled,
    canAccelerate,
    createFeeBumpTransaction,
    submitFeeBump,
  };
}
