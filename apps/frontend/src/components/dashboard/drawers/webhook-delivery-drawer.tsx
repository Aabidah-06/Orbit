"use client";

import { useState } from "react";
import {
  X,
  Copy,
  Check,
  RotateCw,
  Send,
  CheckCircle2,
  AlertCircle,
  Clock,
  ArrowUpRight,
  ShieldCheck,
} from "lucide-react";
import { WebhookDeliveryLog } from "../dashboard-types";

interface WebhookDeliveryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  delivery: WebhookDeliveryLog | null;
  onResend: (delivery: WebhookDeliveryLog) => Promise<void>;
  isResending?: boolean;
}

export function WebhookDeliveryDrawer({
  isOpen,
  onClose,
  delivery,
  onResend,
  isResending = false,
}: WebhookDeliveryDrawerProps) {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  if (!isOpen || !delivery) return null;

  const copyToClipboard = (text: string, section: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 1800);
  };

  const isSuccess = delivery.status === "success" || (delivery.response_status && delivery.response_status >= 200 && delivery.response_status < 300);
  const formattedPayload = JSON.stringify(delivery.payload, null, 2);
  const formattedHeaders = delivery.request_headers
    ? JSON.stringify(delivery.request_headers, null, 2)
    : JSON.stringify(
        {
          "Content-Type": "application/json",
          "User-Agent": "Orbit-Webhook-Dispatcher/1.0",
          "X-Orbit-Signature": "sha256=48fb12948c7e120516d54ea9f0d93f...",
          "X-Orbit-Event": delivery.event_type,
          "X-Orbit-Delivery": delivery.id,
        },
        null,
        2
      );

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-xs flex justify-end animate-in fade-in duration-200">
      <div
        className="w-full max-w-xl bg-white h-full shadow-2xl flex flex-col border-l border-black/10 overflow-hidden animate-in slide-in-from-right duration-200"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="p-6 border-b border-black/10 flex items-center justify-between gap-4 bg-neutral-50/60">
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold uppercase tracking-wide border ${
                  isSuccess
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-red-50 text-red-700 border-red-200"
                }`}
              >
                {isSuccess ? (
                  <CheckCircle2 size={12} className="text-emerald-500" />
                ) : (
                  <AlertCircle size={12} className="text-red-500" />
                )}
                <span>
                  {delivery.response_status ? `${delivery.response_status} ${isSuccess ? "OK" : "ERROR"}` : delivery.status.toUpperCase()}
                </span>
              </span>
              <span className="font-mono text-xs text-neutral-400">
                Attempt #{delivery.attempt_count}
              </span>
            </div>
            <h3 className="text-base font-bold text-black mt-1 font-mono">
              {delivery.event_type}
            </h3>
            <p className="text-xs text-neutral-500 mt-0.5">
              Target: <span className="font-mono text-black font-medium">{delivery.webhooks?.url || "Registered Endpoint"}</span>
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onResend(delivery)}
              disabled={isResending}
              className="button button-secondary text-xs h-8 px-3 flex items-center gap-1.5 shadow-2xs"
              title="Resend this webhook event to target URL"
            >
              {isResending ? (
                <>
                  <RotateCw size={12} className="animate-spin text-black" />
                  <span>Resending...</span>
                </>
              ) : (
                <>
                  <Send size={12} />
                  <span>Resend Event</span>
                </>
              )}
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-black/5 text-neutral-400 hover:text-black transition-colors"
              title="Close drawer"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 gap-3 p-4 rounded-xl bg-neutral-50 border border-black/5">
            <div>
              <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                Delivery ID
              </div>
              <div className="font-mono text-neutral-800 text-xs mt-0.5 truncate select-all">
                {delivery.id}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                Timestamp
              </div>
              <div className="font-mono text-neutral-800 text-xs mt-0.5 flex items-center gap-1">
                <Clock size={11} className="text-neutral-400" />
                <span>{new Date(delivery.created_at).toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* Section 1: Request Headers */}
          <div>
            <div className="flex items-center justify-between pb-1.5">
              <label className="text-xs font-bold text-black uppercase tracking-wider flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-neutral-500" />
                <span>Dispatched Request Headers</span>
              </label>
              <button
                onClick={() => copyToClipboard(formattedHeaders, "headers")}
                className="text-neutral-400 hover:text-black transition-colors flex items-center gap-1 text-[11px]"
              >
                {copiedSection === "headers" ? (
                  <>
                    <Check size={12} className="text-emerald-600" />
                    <span className="text-emerald-600 font-medium">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy size={12} />
                    <span>Copy Headers</span>
                  </>
                )}
              </button>
            </div>
            <div className="rounded-lg bg-[#09090b] text-neutral-200 p-3.5 font-mono text-[11px] overflow-x-auto border border-neutral-800">
              <pre>
                <code>{formattedHeaders}</code>
              </pre>
            </div>
          </div>

          {/* Section 2: Request Payload */}
          <div>
            <div className="flex items-center justify-between pb-1.5">
              <label className="text-xs font-bold text-black uppercase tracking-wider flex items-center gap-1.5">
                <ArrowUpRight size={14} className="text-neutral-500" />
                <span>JSON Payload Body</span>
              </label>
              <button
                onClick={() => copyToClipboard(formattedPayload, "payload")}
                className="text-neutral-400 hover:text-black transition-colors flex items-center gap-1 text-[11px]"
              >
                {copiedSection === "payload" ? (
                  <>
                    <Check size={12} className="text-emerald-600" />
                    <span className="text-emerald-600 font-medium">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy size={12} />
                    <span>Copy Payload</span>
                  </>
                )}
              </button>
            </div>
            <div className="rounded-lg bg-[#09090b] text-neutral-200 p-3.5 font-mono text-[11px] overflow-x-auto border border-neutral-800">
              <pre>
                <code>{formattedPayload}</code>
              </pre>
            </div>
          </div>

          {/* Section 3: Webhook Response Body */}
          <div>
            <div className="flex items-center justify-between pb-1.5">
              <label className="text-xs font-bold text-black uppercase tracking-wider">
                Recipient Server Response
              </label>
              <span className="text-[10px] font-mono text-neutral-400">
                HTTP {delivery.response_status || "—"}
              </span>
            </div>
            <div
              className={`rounded-lg p-3.5 font-mono text-[11px] overflow-x-auto border ${
                isSuccess
                  ? "bg-neutral-50 text-neutral-800 border-black/10"
                  : "bg-red-50 text-red-900 border-red-200"
              }`}
            >
              <pre className="whitespace-pre-wrap break-all">
                <code>{delivery.response_body || "(Empty response returned by destination server)"}</code>
              </pre>
            </div>
          </div>
        </div>

        {/* Drawer Footer */}
        <div className="p-4 border-t border-black/10 bg-neutral-50 flex items-center justify-between">
          <span className="text-[11px] text-neutral-500 font-mono">
            Signed via HMAC-SHA256 (X-Orbit-Signature)
          </span>
          <button
            onClick={onClose}
            className="button button-secondary text-xs h-8 px-4"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
