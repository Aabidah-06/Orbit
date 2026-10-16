"use client";

import React from "react";
import {
  CheckCircle2,
  Clock,
  AlertCircle,
  ExternalLink,
  X,
  Loader2,
} from "lucide-react";
import { useNotifications, NotificationStatus } from "@/lib/notification-context";

export function ToastNotificationCenter() {
  const { toasts, dismissToast } = useNotifications();

  if (!toasts || toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 pointer-events-none max-w-sm w-full"
    >
      {toasts.map((toast) => {
        const explorerUrl = toast.txHash
          ? `https://stellar.expert/explorer/${
              toast.network === "public" ? "public" : "testnet"
            }/tx/${toast.txHash}`
          : null;

        return (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto bg-white border border-black/10 rounded-xl shadow-xl p-4 flex gap-3 items-start animate-in slide-in-from-bottom-3 duration-200"
          >
            <div className="shrink-0 mt-0.5">
              <StatusIcon status={toast.status} />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-black leading-tight">
                  {toast.title}
                </h4>
                <button
                  onClick={() => dismissToast(toast.id)}
                  className="text-neutral-400 hover:text-black p-0.5 rounded transition-colors"
                  aria-label="Dismiss notification"
                >
                  <X size={14} />
                </button>
              </div>

              <p className="text-xs text-neutral-600 mt-1 leading-snug">
                {toast.message}
              </p>

              {explorerUrl && (
                <div className="mt-2.5 pt-2 border-t border-black/5 flex items-center justify-between">
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
                  >
                    <span>View on Stellar Expert</span>
                    <ExternalLink size={12} />
                  </a>
                  <span className="text-[10px] font-mono text-neutral-400">
                    {toast.txHash?.slice(0, 6)}...{toast.txHash?.slice(-4)}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusIcon({ status }: { status: NotificationStatus }) {
  switch (status) {
    case "confirmed":
      return <CheckCircle2 size={18} className="text-emerald-600" />;
    case "pending":
      return <Loader2 size={18} className="text-amber-500 animate-spin" />;
    case "submitted":
      return <Clock size={18} className="text-blue-500" />;
    case "failed":
      return <AlertCircle size={18} className="text-rose-600" />;
    default:
      return <CheckCircle2 size={18} className="text-neutral-500" />;
  }
}
