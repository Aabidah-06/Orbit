/**
 * Service Worker for Background Sync (#179)
 *
 * Registers a background sync listener that continues polling Soroban RPC
 * even if the user switches browser tabs or network connection flickers.
 */

const CACHE_NAME = "orbit-checkout-v1";
const RPC_ENDPOINT = "https://soroban-testnet.stellar.org";
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLL_TIME = 5 * 60 * 1000; // 5 minutes

self.addEventListener("install", (event) => {
  console.log("Service Worker installing...");
  self.skipWaiting(); // Activate immediately
});

self.addEventListener("activate", (event) => {
  console.log("Service Worker activated");
  event.waitUntil(self.clients.claim());
});

/**
 * Background sync for transaction confirmation polling
 */
self.addEventListener("sync", (event) => {
  console.log("Background sync triggered:", event.tag);

  if (event.tag === "poll-transaction") {
    event.waitUntil(pollPendingTransactions());
  }
});

/**
 * Poll all pending transactions and update their status
 */
async function pollPendingTransactions() {
  try {
    // Open IndexedDB in Service Worker context
    const db = await openIndexedDB();
    const pendingTransactions = await getAllPendingFromDB(db);

    console.log("Polling pending transactions:", pendingTransactions.length);

    for (const transaction of pendingTransactions) {
      await checkTransactionStatus(db, transaction);
    }
  } catch (error) {
    console.error("Failed to poll pending transactions:", error);
  }
}

/**
 * Open IndexedDB connection
 */
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("orbit_checkout_cache", 1);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all pending transactions from IndexedDB
 */
function getAllPendingFromDB(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pending_transactions", "readonly");
    const store = tx.objectStore("pending_transactions");
    const index = store.index("status");
    const request = index.getAll("pending");

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Check transaction status on Soroban RPC
 */
async function checkTransactionStatus(db, transaction) {
  const startTime = Date.now();
  const maxRetries = Math.floor(MAX_POLL_TIME / POLL_INTERVAL);

  // Skip if we've been polling too long
  const timeSinceSubmit = Date.now() - transaction.timestamp;
  if (timeSinceSubmit > MAX_POLL_TIME) {
    console.log("Transaction polling timeout:", transaction.transaction_hash);
    await updateTransactionInDB(db, transaction.transaction_hash, "timeout", {
      error: "Transaction confirmation timeout",
    });
    await notifyClient({
      type: "transaction_timeout",
      hash: transaction.transaction_hash,
    });
    return;
  }

  try {
    // Call Soroban RPC to check transaction status
    const response = await fetch(RPC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [transaction.transaction_hash],
      }),
    });

    const data = await response.json();

    if (data.result && data.result.status === "SUCCESS") {
      // Transaction confirmed!
      console.log("Transaction confirmed:", transaction.transaction_hash);

      await updateTransactionInDB(
        db,
        transaction.transaction_hash,
        "confirmed",
        {
          receipt: data.result,
        },
      );

      // Notify the client to display success modal
      await notifyClient({
        type: "transaction_confirmed",
        hash: transaction.transaction_hash,
        transaction: transaction,
        receipt: data.result,
      });
    } else if (data.result && data.result.status === "FAILED") {
      // Transaction failed
      console.error("Transaction failed:", transaction.transaction_hash);

      await updateTransactionInDB(db, transaction.transaction_hash, "failed", {
        error: data.result.resultXdr || "Transaction failed",
      });

      await notifyClient({
        type: "transaction_failed",
        hash: transaction.transaction_hash,
        error: data.result.resultXdr,
      });
    } else {
      // Still pending - schedule next check
      console.log("Transaction still pending:", transaction.transaction_hash);

      // Register for another sync attempt
      if ("sync" in self.registration) {
        await self.registration.sync.register("poll-transaction");
      }
    }
  } catch (error) {
    console.error("Failed to check transaction status:", error);

    // Network error - will retry on next sync
    if ("sync" in self.registration) {
      await self.registration.sync.register("poll-transaction");
    }
  }
}

/**
 * Update transaction status in IndexedDB
 */
function updateTransactionInDB(db, hash, status, metadata = {}) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pending_transactions", "readwrite");
    const store = tx.objectStore("pending_transactions");

    const getRequest = store.get(hash);

    getRequest.onsuccess = () => {
      const transaction = getRequest.result;

      if (!transaction) {
        reject(new Error("Transaction not found"));
        return;
      }

      transaction.status = status;
      transaction.last_check = Date.now();
      transaction.retry_count = (transaction.retry_count || 0) + 1;

      if (metadata.receipt) {
        transaction.receipt = metadata.receipt;
      }

      if (metadata.error) {
        transaction.error = metadata.error;
      }

      const putRequest = store.put(transaction);

      putRequest.onsuccess = () => resolve(transaction);
      putRequest.onerror = () => reject(putRequest.error);
    };

    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * Notify all connected clients about transaction status update
 */
async function notifyClient(message) {
  const allClients = await self.clients.matchAll({ includeUncontrolled: true });

  for (const client of allClients) {
    client.postMessage(message);
  }
}

/**
 * Periodic background sync (fallback for browsers without Background Sync API)
 */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "START_POLLING") {
    console.log("Starting periodic polling:", event.data.hash);
    startPeriodicPolling(event.data.hash);
  }
});

/**
 * Fallback polling mechanism
 */
async function startPeriodicPolling(hash) {
  const db = await openIndexedDB();
  const transaction = await getTransactionFromDB(db, hash);

  if (!transaction || transaction.status !== "pending") {
    return;
  }

  await checkTransactionStatus(db, transaction);

  // Schedule next poll
  setTimeout(() => startPeriodicPolling(hash), POLL_INTERVAL);
}

/**
 * Get specific transaction from IndexedDB
 */
function getTransactionFromDB(db, hash) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pending_transactions", "readonly");
    const store = tx.objectStore("pending_transactions");
    const request = store.get(hash);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
