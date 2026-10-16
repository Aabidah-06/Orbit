"use client";

import { useState } from "react";
import { X, Webhook, Key, ShieldCheck, Check, Copy } from "lucide-react";
import { WebhookEndpoint } from "../dashboard-types";

interface RegisterWebhookModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (endpoint: { url: string; events: string[]; signingSecret: string }) => Promise<void>;
  initialData?: WebhookEndpoint | null;
}

const AVAILABLE_EVENTS = [
  { id: "payment.settled", label: "payment.settled", desc: "USDC pull successfully executed on-chain" },
  { id: "subscription.created", label: "subscription.created", desc: "Customer authorized new allowance vault" },
  { id: "subscription.past_due", label: "subscription.past_due", desc: "Pull attempt failed, dunning initiated" },
  { id: "subscription.cancelled", label: "subscription.cancelled", desc: "Subscription cancelled / dunning exhausted" },
  { id: "dunning.attempt_failed", label: "dunning.attempt_failed", desc: "Scheduled retry failed during grace period" },
  { id: "payroll.disbursed", label: "payroll.disbursed", desc: "Batch payroll payout completed" },
];

export function RegisterWebhookModal({
  isOpen,
  onClose,
  onSave,
  initialData,
}: RegisterWebhookModalProps) {
  const [url, setUrl] = useState(initialData?.url || "");
  const [signingSecret, setSigningSecret] = useState(
    initialData?.signing_secret ||
      `whsec_${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`
  );
  const [selectedEvents, setSelectedEvents] = useState<string[]>(
    initialData?.events?.length ? initialData.events : ["*"]
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const toggleEvent = (eventId: string) => {
    if (eventId === "*") {
      setSelectedEvents(["*"]);
      return;
    }

    let updated = selectedEvents.filter((e) => e !== "*");
    if (updated.includes(eventId)) {
      updated = updated.filter((e) => e !== eventId);
      if (updated.length === 0) updated = ["*"];
    } else {
      updated.push(eventId);
    }
    setSelectedEvents(updated);
  };

  const handleCopySecret = () => {
    navigator.clipboard.writeText(signingSecret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 1800);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    try {
      setIsSubmitting(true);
      setError(null);
      await onSave({
        url: url.trim(),
        events: selectedEvents,
        signingSecret: signingSecret.trim(),
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to register webhook");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="w-full max-w-lg rounded-2xl border border-black/10 bg-white p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between pb-3 border-b border-black/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <Webhook size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-black tracking-tight">
                {initialData ? "Update Webhook Endpoint" : "Register Webhook Endpoint"}
              </h3>
              <p className="text-xs text-neutral-500">
                Receive HMAC-signed event notifications at your server.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 text-neutral-400 hover:text-black transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900 font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
              Destination URL (HTTPS Recommended)
            </label>
            <input
              type="url"
              required
              placeholder="https://api.yourdomain.com/webhooks/orbit"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 font-mono text-xs text-black focus:outline-hidden focus:ring-1 focus:ring-black"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                HMAC-SHA256 Signing Secret
              </label>
              <button
                type="button"
                onClick={handleCopySecret}
                className="text-neutral-400 hover:text-black text-[11px] flex items-center gap-1"
              >
                {copiedSecret ? (
                  <>
                    <Check size={11} className="text-emerald-600" />
                    <span className="text-emerald-600">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy size={11} />
                    <span>Copy Secret</span>
                  </>
                )}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  required
                  value={signingSecret}
                  onChange={(e) => setSigningSecret(e.target.value)}
                  className="w-full rounded-lg border border-black/10 px-3.5 py-2 font-mono text-xs bg-neutral-50 text-neutral-800"
                />
              </div>
            </div>
            <p className="text-[11px] text-neutral-400 mt-1">
              Verify webhook payloads using header <code className="font-mono text-black">X-Orbit-Signature</code>.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-semibold text-black uppercase tracking-wider">
                Event Subscriptions
              </label>
              <button
                type="button"
                onClick={() => setSelectedEvents(["*"])}
                className={`text-[11px] font-mono font-medium ${
                  selectedEvents.includes("*") ? "text-emerald-600 font-bold" : "text-neutral-400 hover:text-black"
                }`}
              >
                {selectedEvents.includes("*") ? "✓ All Events (*)" : "Select All (*)"}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
              {AVAILABLE_EVENTS.map((item) => {
                const isChecked = selectedEvents.includes("*") || selectedEvents.includes(item.id);

                return (
                  <div
                    key={item.id}
                    onClick={() => toggleEvent(item.id)}
                    className={`p-2.5 rounded-lg border transition-all cursor-pointer flex items-start gap-2.5 ${
                      isChecked
                        ? "bg-neutral-50/80 border-black/30"
                        : "bg-white border-black/10 opacity-70 hover:opacity-100"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {}}
                      className="mt-0.5 rounded border-black/20"
                    />
                    <div>
                      <div className="font-mono text-[11px] font-bold text-black">
                        {item.label}
                      </div>
                      <div className="text-[10px] text-neutral-500 line-clamp-1">
                        {item.desc}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pt-2 flex items-center justify-end gap-2 border-t border-black/10">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="button button-secondary text-xs h-9 px-4"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="button button-primary text-xs h-9 px-4 flex items-center gap-1.5"
            >
              {isSubmitting ? (
                <span>Saving...</span>
              ) : (
                <span>{initialData ? "Save Changes" : "Register Endpoint"}</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
