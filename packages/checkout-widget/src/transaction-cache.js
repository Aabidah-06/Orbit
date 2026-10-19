/**
 * IndexedDB Session Cache and Transaction Recovery (#179)
 *
 * Persists submitted transaction hashes, plan details, and merchant ID into IndexedDB
 * immediately upon wallet signature to prevent loss of transaction progress during
 * network disconnections or browser crashes.
 */

const DB_NAME = "orbit_checkout_cache";
const DB_VERSION = 1;
const STORE_NAME = "pending_transactions";

/**
 * Initialize IndexedDB connection
 */
export function initTransactionCache() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error("Failed to open IndexedDB:", request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "transaction_hash",
        });
        store.createIndex("merchant_id", "merchant_id", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("status", "status", { unique: false });
      }
    };
  });
}

/**
 * Persist transaction state immediately after wallet signature
 */
export async function cacheTransaction(transactionData) {
  const db = await initTransactionCache();

  const transaction = {
    transaction_hash: transactionData.hash,
    merchant_id: transactionData.merchant_id,
    plan_id: transactionData.plan_id,
    plan_name: transactionData.plan_name,
    amount: transactionData.amount,
    token: transactionData.token,
    interval_seconds: transactionData.interval_seconds,
    user_address: transactionData.user_address,
    timestamp: Date.now(),
    status: "pending",
    retry_count: 0,
    last_check: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(transaction);

    request.onsuccess = () => {
      console.log("Transaction cached:", transaction.transaction_hash);
      resolve(transaction);
    };

    request.onerror = () => {
      console.error("Failed to cache transaction:", request.error);
      reject(request.error);
    };
  });
}

/**
 * Retrieve pending transaction by hash
 */
export async function getTransaction(hash) {
  const db = await initTransactionCache();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(hash);

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Get all pending transactions
 */
export async function getAllPendingTransactions() {
  const db = await initTransactionCache();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("status");
    const request = index.getAll("pending");

    request.onsuccess = () => {
      resolve(request.result || []);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Update transaction status after confirmation
 */
export async function updateTransactionStatus(hash, status, metadata = {}) {
  const db = await initTransactionCache();

  return new Promise(async (resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    // Get existing transaction
    const getRequest = store.get(hash);

    getRequest.onsuccess = () => {
      const transaction = getRequest.result;

      if (!transaction) {
        reject(new Error("Transaction not found"));
        return;
      }

      // Update status and metadata
      transaction.status = status;
      transaction.last_check = Date.now();
      transaction.retry_count = (transaction.retry_count || 0) + 1;

      if (metadata.receipt) {
        transaction.receipt = metadata.receipt;
      }

      if (metadata.error) {
        transaction.error = metadata.error;
      }

      // Save updated transaction
      const putRequest = store.put(transaction);

      putRequest.onsuccess = () => {
        console.log("Transaction status updated:", hash, status);
        resolve(transaction);
      };

      putRequest.onerror = () => {
        reject(putRequest.error);
      };
    };

    getRequest.onerror = () => {
      reject(getRequest.error);
    };
  });
}

/**
 * Remove confirmed transaction from cache
 */
export async function removeTransaction(hash) {
  const db = await initTransactionCache();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(hash);

    request.onsuccess = () => {
      console.log("Transaction removed from cache:", hash);
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Clean up old transactions (older than 7 days)
 */
export async function cleanupOldTransactions() {
  const db = await initTransactionCache();
  const cutoffTime = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("timestamp");
    const request = index.openCursor();

    const deleted = [];

    request.onsuccess = (event) => {
      const cursor = event.target.result;

      if (cursor) {
        const transaction = cursor.value;

        if (transaction.timestamp < cutoffTime) {
          cursor.delete();
          deleted.push(transaction.transaction_hash);
        }

        cursor.continue();
      } else {
        console.log("Cleaned up old transactions:", deleted.length);
        resolve(deleted);
      }
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Restore active checkout state on page load
 */
export async function restoreCheckoutState() {
  try {
    const pendingTransactions = await getAllPendingTransactions();

    if (pendingTransactions.length === 0) {
      return null;
    }

    // Get the most recent pending transaction
    const latest = pendingTransactions.sort(
      (a, b) => b.timestamp - a.timestamp,
    )[0];

    // Only restore if less than 24 hours old
    const hoursSinceSubmission =
      (Date.now() - latest.timestamp) / (1000 * 60 * 60);

    if (hoursSinceSubmission > 24) {
      console.log("Pending transaction too old, not restoring");
      return null;
    }

    console.log("Restoring checkout state:", latest.transaction_hash);
    return latest;
  } catch (error) {
    console.error("Failed to restore checkout state:", error);
    return null;
  }
}
