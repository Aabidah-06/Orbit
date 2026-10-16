"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";

export type NotificationStatus = "submitted" | "pending" | "confirmed" | "failed";

export interface TransactionNotification {
  id: string;
  title: string;
  message: string;
  status: NotificationStatus;
  txHash?: string;
  network?: "testnet" | "public";
  timestamp: number;
  read: boolean;
}

interface NotificationContextType {
  notifications: TransactionNotification[];
  toasts: TransactionNotification[];
  unreadCount: number;
  isDrawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  addNotification: (
    item: Omit<TransactionNotification, "id" | "timestamp" | "read">
  ) => void;
  markAllAsRead: () => void;
  clearNotifications: () => void;
  dismissToast: (id: string) => void;
}

const STORAGE_KEY = "orbit:transaction-notifications";

const NotificationContext = createContext<NotificationContextType | undefined>(
  undefined
);

export function NotificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [notifications, setNotifications] = useState<TransactionNotification[]>(
    []
  );
  const [toasts, setToasts] = useState<TransactionNotification[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  // Load notifications from localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setNotifications(JSON.parse(stored));
      }
    } catch (err) {
      console.error("Failed to parse notifications from localStorage", err);
    }
  }, []);

  // Save notifications to localStorage
  const saveNotifications = useCallback(
    (items: TransactionNotification[]) => {
      setNotifications(items);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 50)));
      } catch (err) {
        console.error("Failed to save notifications to localStorage", err);
      }
    },
    []
  );

  const addNotification = useCallback(
    (item: Omit<TransactionNotification, "id" | "timestamp" | "read">) => {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const newNotif: TransactionNotification = {
        ...item,
        id,
        timestamp: Date.now(),
        read: false,
      };

      setNotifications((prev) => {
        const next = [newNotif, ...prev.filter((n) => n.id !== id)].slice(0, 50);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore storage error
        }
        return next;
      });

      // Add to toast queue
      setToasts((prev) => [...prev, newNotif]);

      // Auto-dismiss confirmed/submitted toasts after 7 seconds
      setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== id));
      }, 7000);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => {
      const updated = prev.map((n) => ({ ...n, read: true }));
      saveNotifications(updated);
      return updated;
    });
  }, [saveNotifications]);

  const clearNotifications = useCallback(() => {
    saveNotifications([]);
  }, [saveNotifications]);

  const openDrawer = useCallback(() => setIsDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setIsDrawerOpen(false), []);
  const toggleDrawer = useCallback(() => setIsDrawerOpen((prev) => !prev), []);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  // WebSocket & Event Listener Bridge
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Listen for custom settlement and transaction events
    const handleTxEvent = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail) {
        const { title, message, status, txHash, network } = customEvent.detail;
        addNotification({
          title: title || "Transaction Settled",
          message: message || "On-chain pull settlement confirmed.",
          status: status || "confirmed",
          txHash,
          network: network || "testnet",
        });
      }
    };

    window.addEventListener("orbit:tx_settled", handleTxEvent);
    window.addEventListener("orbit:notification", handleTxEvent);

    // Optional WebSocket listener for live backend confirmations
    const wsUrl =
      process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/ws/events";
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;

    const connectWs = () => {
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data?.type === "transaction.confirmed" || data?.type === "settlement.confirmed") {
              addNotification({
                title: data.title || "On-Chain Settlement Confirmed",
                message: data.message || `USDC payout of ${data.amount || "amount"} was successfully confirmed.`,
                status: "confirmed",
                txHash: data.txHash || data.hash,
                network: data.network || "testnet",
              });
            } else if (data?.type === "transaction.submitted") {
              addNotification({
                title: "Transaction Submitted",
                message: data.message || "Submitted to Stellar network for confirmation.",
                status: "submitted",
                txHash: data.txHash || data.hash,
                network: data.network || "testnet",
              });
            }
          } catch {
            // Ignore non-json ws messages
          }
        };

        ws.onerror = () => {
          if (ws) ws.close();
        };

        ws.onclose = () => {
          reconnectTimer = setTimeout(connectWs, 15000);
        };
      } catch {
        // WebSocket not available or refused; gracefully degrade
      }
    };

    connectWs();

    return () => {
      window.removeEventListener("orbit:tx_settled", handleTxEvent);
      window.removeEventListener("orbit:notification", handleTxEvent);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [addNotification]);

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        toasts,
        unreadCount,
        isDrawerOpen,
        openDrawer,
        closeDrawer,
        toggleDrawer,
        addNotification,
        markAllAsRead,
        clearNotifications,
        dismissToast,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error(
      "useNotifications must be used within a NotificationProvider"
    );
  }
  return context;
}
