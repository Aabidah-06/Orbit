import { useEffect, useState } from 'react';
import {
  restoreCheckoutState,
  updateTransactionStatus,
  removeTransaction,
} from './transaction-cache';

/**
 * Transaction Recovery Component (#179)
 * 
 * Restores active checkout state when user reconnects or revisits the page,
 * confirms ledger inclusion, and displays the verified payment receipt.
 */
export function TransactionRecovery({ onRecovered, onDismissed }) {
  const [recoveredTransaction, setRecoveredTransaction] = useState(null);
  const [polling, setPolling] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Attempt to restore checkout state on mount
    async function restoreState() {
      try {
        const transaction = await restoreCheckoutState();
        
        if (transaction) {
          setRecoveredTransaction(transaction);
          
          // Register Service Worker for background sync
          if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.ready;
            
            // Listen for transaction status updates from Service Worker
            navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
            
            // Start background sync
            if ('sync' in registration) {
              await registration.sync.register('poll-transaction');
            } else {
              // Fallback: message Service Worker to start periodic polling
              registration.active.postMessage({
                type: 'START_POLLING',
                hash: transaction.transaction_hash,
              });
            }
          } else {
            // Fallback: poll directly in main thread
            await pollTransactionStatus(transaction);
          }
          
          setPolling(true);
        }
      } catch (err) {
        console.error('Failed to restore checkout state:', err);
        setError(err.message);
      }
    }

    restoreState();

    return () => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
      }
    };
  }, []);

  const handleServiceWorkerMessage = (event) => {
    const { type, hash, receipt, error: swError } = event.data;
    
    if (type === 'transaction_confirmed' && hash === recoveredTransaction?.transaction_hash) {
      setPolling(false);
      setConfirmed(true);
      
      if (onRecovered) {
        onRecovered({
          ...recoveredTransaction,
          status: 'confirmed',
          receipt,
        });
      }
    } else if (type === 'transaction_failed' && hash === recoveredTransaction?.transaction_hash) {
      setPolling(false);
      setError(swError || 'Transaction failed');
    } else if (type === 'transaction_timeout' && hash === recoveredTransaction?.transaction_hash) {
      setPolling(false);
      setError('Transaction confirmation timeout');
    }
  };

  // Fallback polling function for browsers without Service Worker support
  const pollTransactionStatus = async (transaction, attempt = 0) => {
    const MAX_ATTEMPTS = 60; // 5 minutes at 5-second intervals
    
    if (attempt >= MAX_ATTEMPTS) {
      setPolling(false);
      setError('Transaction confirmation timeout');
      return;
    }

    try {
      const response = await fetch('https://soroban-testnet.stellar.org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [transaction.transaction_hash],
        }),
      });

      const data = await response.json();
      
      if (data.result && data.result.status === 'SUCCESS') {
        setPolling(false);
        setConfirmed(true);
        
        await updateTransactionStatus(transaction.transaction_hash, 'confirmed', {
          receipt: data.result,
        });
        
        if (onRecovered) {
          onRecovered({
            ...transaction,
            status: 'confirmed',
            receipt: data.result,
          });
        }
      } else if (data.result && data.result.status === 'FAILED') {
        setPolling(false);
        setError('Transaction failed');
        
        await updateTransactionStatus(transaction.transaction_hash, 'failed', {
          error: data.result.resultXdr,
        });
      } else {
        // Still pending - poll again
        setTimeout(() => pollTransactionStatus(transaction, attempt + 1), 5000);
      }
    } catch (err) {
      console.error('Failed to poll transaction:', err);
      // Retry on network error
      setTimeout(() => pollTransactionStatus(transaction, attempt + 1), 5000);
    }
  };

  const handleDismiss = async () => {
    if (confirmed && recoveredTransaction) {
      // Remove from cache once confirmed
      await removeTransaction(recoveredTransaction.transaction_hash);
    }
    
    if (onDismissed) {
      onDismissed();
    }
    
    setRecoveredTransaction(null);
  };

  if (!recoveredTransaction) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
        {polling && !confirmed && !error && (
          <>
            <div className="flex items-center justify-center mb-4">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            </div>
            <h2 className="text-xl font-semibold text-center mb-2">
              Verifying Transaction
            </h2>
            <p className="text-gray-600 text-center mb-4">
              We're checking the status of your subscription payment on the Stellar ledger...
            </p>
            <div className="bg-gray-50 rounded p-3 mb-4">
              <div className="text-sm text-gray-600">
                <div className="flex justify-between mb-1">
                  <span>Plan:</span>
                  <span className="font-medium">{recoveredTransaction.plan_name}</span>
                </div>
                <div className="flex justify-between mb-1">
                  <span>Amount:</span>
                  <span className="font-medium">
                    ${(recoveredTransaction.amount / 10000000).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Transaction:</span>
                  <span className="font-mono text-xs">
                    {recoveredTransaction.transaction_hash.substring(0, 12)}...
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {confirmed && (
          <>
            <div className="flex items-center justify-center mb-4">
              <div className="rounded-full bg-green-100 p-3">
                <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
            <h2 className="text-xl font-semibold text-center mb-2 text-green-600">
              Subscription Activated!
            </h2>
            <p className="text-gray-600 text-center mb-4">
              Your recurring payment has been confirmed on the Stellar ledger.
            </p>
            <div className="bg-green-50 rounded p-3 mb-4">
              <div className="text-sm text-gray-600">
                <div className="flex justify-between mb-1">
                  <span>Plan:</span>
                  <span className="font-medium">{recoveredTransaction.plan_name}</span>
                </div>
                <div className="flex justify-between mb-1">
                  <span>Amount:</span>
                  <span className="font-medium">
                    ${(recoveredTransaction.amount / 10000000).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Status:</span>
                  <span className="font-medium text-green-600">Confirmed</span>
                </div>
              </div>
            </div>
            <button
              onClick={handleDismiss}
              className="w-full bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 transition"
            >
              Continue
            </button>
          </>
        )}

        {error && (
          <>
            <div className="flex items-center justify-center mb-4">
              <div className="rounded-full bg-red-100 p-3">
                <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
            </div>
            <h2 className="text-xl font-semibold text-center mb-2 text-red-600">
              Transaction Issue
            </h2>
            <p className="text-gray-600 text-center mb-4">
              {error}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => pollTransactionStatus(recoveredTransaction, 0)}
                className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition"
              >
                Retry
              </button>
              <button
                onClick={handleDismiss}
                className="flex-1 bg-gray-200 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-300 transition"
              >
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
