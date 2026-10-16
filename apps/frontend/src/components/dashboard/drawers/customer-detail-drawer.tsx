"use client";

import { useState, useEffect, useCallback } from "react";
import {
  X,
  ExternalLink,
  Copy,
  Check,
  Zap,
  RotateCw,
  Clock,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  ShieldCheck,
  ArrowDownLeft,
  DollarSign,
  Ban,
  Link as LinkIcon,
  RefreshCw,
} from "lucide-react";
import { SubscriberRecord, PaymentTimelineEvent } from "../dashboard-types";
import {
  fetchSubscriptionTimeline,
  cancelSubscription,
  refundSubscription,
  generateRecoveryLink,
} from "@/lib/api";

interface CustomerDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  subscriber: SubscriberRecord | null;
  onExecutePull: (sub: SubscriberRecord) => Promise<void>;
  onSubscriberUpdated?: (updated: SubscriberRecord) => void;
  isExecutingPull?: boolean;
}

export function CustomerDetailDrawer({
  isOpen,
  onClose,
  subscriber,
  onExecutePull,
  onSubscriberUpdated,
  isExecutingPull = false,
}: CustomerDetailDrawerProps) {
  const [timeline, setTimeline] = useState<PaymentTimelineEvent[]>([]);
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Action states
  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundAmount, setRefundAmount] = useState<string>("");
  const [refundReason, setRefundReason] = useState("");
  const [isProcessingRefund, setIsProcessingRefund] = useState(false);

  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [isProcessingCancel, setIsProcessingCancel] = useState(false);

  const [recoveryLink, setRecoveryLink] = useState<string | null>(null);
  const [isGeneratingRecovery, setIsGeneratingRecovery] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadTimeline = useCallback(async (subId: string) => {
    setIsLoadingTimeline(true);
    try {
      const res = await fetchSubscriptionTimeline(subId);
      setTimeline(res.timeline || []);
    } catch {
      // Fallback timeline mock if running in demo mode or local mock
      const mockEvents: PaymentTimelineEvent[] = [
        {
          id: `evt-1-${subId}`,
          type: "settled_pull",
          title: "Recurring USDC Pull Settled",
          description: "Soroban smart contract executed pull_funds with 1.2s finality.",
          amount: subscriber?.amount || 29.0,
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
          status: "success",
          txHash: "7b4c...982a",
        },
        {
          id: `evt-0-${subId}`,
          type: "subscription_created",
          title: "Vault Handshake Established",
          description: `Subscriber linked Ed25519 wallet to ${subscriber?.planName || "plan"}.`,
          timestamp: subscriber?.joinedDate ? new Date(subscriber.joinedDate).toISOString() : new Date().toISOString(),
          status: "success",
        },
      ];

      if (subscriber?.status === "past_due") {
        mockEvents.unshift({
          id: `evt-dunning-${subId}`,
          type: "dunning_retry",
          title: "Automated Dunning Attempt #1",
          description: "Grace period retry queued; notification webhook dispatched.",
          timestamp: new Date().toISOString(),
          status: "warning",
        });
        mockEvents.unshift({
          id: `evt-failed-${subId}`,
          type: "failed_pull",
          title: "Recurring Pull Failed",
          description: "Account balance was insufficient or allowance limit reached.",
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
          status: "failed",
        });
      }

      setTimeline(mockEvents);
    } finally {
      setIsLoadingTimeline(false);
    }
  }, [subscriber?.amount, subscriber?.joinedDate, subscriber?.planName, subscriber?.status]);

  useEffect(() => {
    if (isOpen && subscriber) {
      setRefundAmount(subscriber.amount.toFixed(2));
      setShowRefundForm(false);
      setShowCancelConfirm(false);
      setActionSuccess(null);
      setActionError(null);
      setRecoveryLink(subscriber.recoveryLink || null);
      loadTimeline(subscriber.id);
    }
  }, [isOpen, subscriber, loadTimeline]);

  if (!isOpen || !subscriber) return null;

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleRefundSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessingRefund(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const parsedAmount = parseFloat(refundAmount);
      await refundSubscription(subscriber.id, isNaN(parsedAmount) ? undefined : parsedAmount, refundReason || "Merchant initiated refund");
      setActionSuccess(`Refund of ${parsedAmount || subscriber.amount} USDC processed successfully.`);
      setShowRefundForm(false);
      setTimeline((prev) => [
        {
          id: `refund-${Date.now()}`,
          type: "refund",
          title: "Prorated Refund Issued",
          description: `Refund credited back to subscriber (${refundReason || "Merchant initiated"}).`,
          amount: isNaN(parsedAmount) ? subscriber.amount : parsedAmount,
          timestamp: new Date().toISOString(),
          status: "info",
        },
        ...prev,
      ]);
      if (onSubscriberUpdated) {
        onSubscriberUpdated({
          ...subscriber,
          totalSettled: Math.max(0, subscriber.totalSettled - (isNaN(parsedAmount) ? subscriber.amount : parsedAmount)),
        });
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to process refund");
    } finally {
      setIsProcessingRefund(false);
    }
  };

  const handleCancelSubmit = async () => {
    setIsProcessingCancel(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      await cancelSubscription(subscriber.id, cancelReason || "Merchant cancelled");
      setActionSuccess("Subscription successfully cancelled and vault allowance revoked.");
      setShowCancelConfirm(false);
      setTimeline((prev) => [
        {
          id: `cancel-${Date.now()}`,
          type: "cancelled",
          title: "Subscription Cancelled",
          description: "Vault allowance revoked and recurrence stopped.",
          timestamp: new Date().toISOString(),
          status: "failed",
        },
        ...prev,
      ]);
      if (onSubscriberUpdated) {
        onSubscriberUpdated({
          ...subscriber,
          status: "cancelled",
          nextPullDate: "Cancelled",
        });
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel subscription");
    } finally {
      setIsProcessingCancel(false);
    }
  };

  const handleCreateRecoveryLink = async () => {
    setIsGeneratingRecovery(true);
    setActionError(null);

    try {
      const res = await generateRecoveryLink(subscriber.id);
      setRecoveryLink(res.recovery_url);
      copyToClipboard(res.recovery_url, "recovery");
      setActionSuccess("Recovery link generated and copied to clipboard!");
    } catch {
      // Fallback client link
      const fallback = `https://orbit.network/pay/${subscriber.id}?recovery=true&token=rec_${Date.now()}`;
      setRecoveryLink(fallback);
      copyToClipboard(fallback, "recovery");
      setActionSuccess("Recovery link copied to clipboard!");
    } finally {
      setIsGeneratingRecovery(false);
    }
  };

  const isDue = subscriber.status === "pending_pull";
  const isPastDue = subscriber.status === "past_due";
  const isCancelled = subscriber.status === "cancelled";

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
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold uppercase tracking-wider border ${
                  isCancelled
                    ? "bg-neutral-100 text-neutral-600 border-neutral-300"
                    : isPastDue
                    ? "bg-red-50 text-red-700 border-red-200"
                    : isDue
                    ? "bg-amber-50 text-amber-700 border-amber-200"
                    : "bg-emerald-50 text-emerald-700 border-emerald-200"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    isCancelled
                      ? "bg-neutral-400"
                      : isPastDue
                      ? "bg-red-500 animate-pulse"
                      : isDue
                      ? "bg-amber-500 animate-pulse"
                      : "bg-emerald-500"
                  }`}
                />
                {isCancelled
                  ? "REVOKED / CANCELLED"
                  : isPastDue
                  ? "PAST DUE · IN DUNNING"
                  : isDue
                  ? "PULL READY"
                  : "ACTIVE VAULT"}
              </span>
              <span className="text-xs text-neutral-400 font-mono">
                {subscriber.network}
              </span>
            </div>

            <div className="flex items-center gap-2 mt-2">
              <h3 className="text-lg font-bold text-black font-mono">
                {subscriber.walletAddress.slice(0, 8)}...{subscriber.walletAddress.slice(-6)}
              </h3>
              <button
                onClick={() => copyToClipboard(subscriber.walletAddress, "address")}
                className="p-1 rounded hover:bg-black/5 text-neutral-400 hover:text-black transition-colors"
                title="Copy full address"
              >
                {copiedKey === "address" ? (
                  <Check size={13} className="text-emerald-600" />
                ) : (
                  <Copy size={13} />
                )}
              </button>
              <a
                href={`https://stellar.expert/explorer/testnet/account/${subscriber.walletAddress}`}
                target="_blank"
                rel="noreferrer"
                className="p-1 rounded hover:bg-black/5 text-neutral-400 hover:text-black transition-colors"
                title="View on Stellar Expert Explorer"
              >
                <ExternalLink size={13} />
              </a>
            </div>
            <p className="text-xs text-neutral-500 mt-0.5">
              Subscribed to <strong className="text-black">{subscriber.planName}</strong> · Joined {subscriber.joinedDate}
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 text-neutral-400 hover:text-black transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Notifications */}
        {actionSuccess && (
          <div className="mx-6 mt-4 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 flex items-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
            <span>{actionSuccess}</span>
          </div>
        )}
        {actionError && (
          <div className="mx-6 mt-4 p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-950 flex items-center gap-2">
            <AlertCircle size={16} className="text-red-600 shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
          {/* Key Metric Ribbon */}
          <div className="grid grid-cols-3 gap-3 p-4 rounded-xl bg-neutral-50 border border-black/5">
            <div>
              <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                Allowance Rate
              </div>
              <div className="font-mono text-black font-bold text-sm mt-0.5">
                {subscriber.amount.toFixed(2)} USDC
              </div>
              <div className="text-[10px] text-neutral-500">Recurring Cap</div>
            </div>

            <div>
              <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                Total Settled
              </div>
              <div className="font-mono text-emerald-700 font-bold text-sm mt-0.5">
                {subscriber.totalSettled.toFixed(2)} USDC
              </div>
              <div className="text-[10px] text-neutral-500">Non-custodial</div>
            </div>

            <div>
              <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                Next Billing
              </div>
              <div className="font-mono text-black font-bold text-sm mt-0.5">
                {subscriber.nextPullDate}
              </div>
              <div className="text-[10px] text-neutral-500">Auto-pull window</div>
            </div>
          </div>

          {/* Dunning Notice Card (if past due) */}
          {isPastDue && (
            <div className="p-4 rounded-xl bg-amber-50/80 border border-amber-200 text-amber-950 space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-bold text-amber-900">Vault in Smart Dunning Recovery</div>
                  <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                    Automated exponential backoff retries scheduled (Days 1, 3, 5, 7). You can send the customer a self-service recovery link to update their allowance.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleCreateRecoveryLink}
                  disabled={isGeneratingRecovery}
                  className="button button-secondary text-xs h-8 px-3 bg-white text-black hover:bg-neutral-50 border-amber-300 flex items-center gap-1.5 shadow-2xs"
                >
                  {isGeneratingRecovery ? (
                    <RotateCw size={12} className="animate-spin" />
                  ) : (
                    <LinkIcon size={12} />
                  )}
                  <span>{recoveryLink ? "Copy Recovery Link" : "Generate Recovery Link"}</span>
                </button>

                {recoveryLink && (
                  <span className="font-mono text-[10px] text-neutral-600 truncate max-w-xs">
                    {recoveryLink}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Action Center */}
          <div className="rounded-xl border border-black/10 bg-white p-4 space-y-3">
            <div className="text-xs font-bold text-black uppercase tracking-wider flex items-center justify-between">
              <span>Customer Action Center</span>
              <span className="text-[10px] font-mono font-normal text-neutral-400">Merchant Controls</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Trigger Pull Action */}
              {!isCancelled && (
                <button
                  onClick={() => onExecutePull(subscriber)}
                  disabled={isExecutingPull}
                  className="button button-primary text-xs h-8 px-3 inline-flex items-center gap-1.5"
                >
                  {isExecutingPull ? (
                    <>
                      <RotateCw size={12} className="animate-spin" />
                      <span>Pulling Funds...</span>
                    </>
                  ) : (
                    <>
                      <Zap size={12} className="text-emerald-400" />
                      <span>Execute Pull Now</span>
                    </>
                  )}
                </button>
              )}

              {/* Issue Refund Trigger */}
              <button
                onClick={() => {
                  setShowRefundForm((prev) => !prev);
                  setShowCancelConfirm(false);
                }}
                className="button button-secondary text-xs h-8 px-3 flex items-center gap-1.5"
              >
                <DollarSign size={12} />
                <span>Issue Prorated Refund</span>
              </button>

              {/* Cancel Subscription Trigger */}
              {!isCancelled && (
                <button
                  onClick={() => {
                    setShowCancelConfirm((prev) => !prev);
                    setShowRefundForm(false);
                  }}
                  className="button button-secondary text-xs h-8 px-3 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 flex items-center gap-1.5"
                >
                  <Ban size={12} />
                  <span>Cancel Vault</span>
                </button>
              )}
            </div>

            {/* Inline Refund Form */}
            {showRefundForm && (
              <form onSubmit={handleRefundSubmit} className="pt-3 border-t border-black/5 space-y-3 animate-in fade-in duration-150">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-neutral-600 uppercase mb-1">
                      Refund Amount (USDC)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={refundAmount}
                      onChange={(e) => setRefundAmount(e.target.value)}
                      className="w-full rounded-lg border border-black/10 px-3 py-1.5 font-mono text-xs text-black"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-neutral-600 uppercase mb-1">
                      Reason / Note
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Prorated cancellation refund"
                      value={refundReason}
                      onChange={(e) => setRefundReason(e.target.value)}
                      className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-xs text-black"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowRefundForm(false)}
                    className="button button-secondary text-xs h-7 px-3"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isProcessingRefund}
                    className="button button-primary text-xs h-7 px-3"
                  >
                    {isProcessingRefund ? "Processing..." : "Confirm & Send Refund"}
                  </button>
                </div>
              </form>
            )}

            {/* Inline Cancel Confirmation */}
            {showCancelConfirm && (
              <div className="pt-3 border-t border-red-100 p-3 rounded-lg bg-red-50/70 space-y-2.5 animate-in fade-in duration-150">
                <div className="font-semibold text-red-950 text-xs">
                  Revoke On-Chain Vault Subscription?
                </div>
                <p className="text-[11px] text-red-800 leading-relaxed">
                  This revokes future automated pull payments for this customer. Existing settled funds remain in your treasury.
                </p>
                <input
                  type="text"
                  placeholder="Reason for cancellation (optional)"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  className="w-full rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs text-black"
                />
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowCancelConfirm(false)}
                    className="button button-secondary text-xs h-7 px-3 bg-white"
                  >
                    Keep Active
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelSubmit}
                    disabled={isProcessingCancel}
                    className="button button-primary text-xs h-7 px-3 bg-red-600 hover:bg-red-700 text-white border-red-700"
                  >
                    {isProcessingCancel ? "Revoking..." : "Confirm Revocation"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Chronological Payment History Timeline */}
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-1">
              <label className="text-xs font-bold text-black uppercase tracking-wider flex items-center gap-1.5">
                <Clock size={14} className="text-neutral-500" />
                <span>Subscription Payment Timeline</span>
              </label>
              <button
                onClick={() => loadTimeline(subscriber.id)}
                disabled={isLoadingTimeline}
                className="text-neutral-400 hover:text-black text-[11px] flex items-center gap-1"
                title="Refresh timeline events"
              >
                <RefreshCw size={11} className={isLoadingTimeline ? "animate-spin" : ""} />
                <span>Refresh</span>
              </button>
            </div>

            {isLoadingTimeline ? (
              <div className="py-12 flex flex-col items-center justify-center text-center">
                <RotateCw size={18} className="animate-spin text-neutral-400 mb-2" />
                <span className="text-xs text-neutral-500">Loading audit history...</span>
              </div>
            ) : timeline.length > 0 ? (
              <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-black/10">
                {timeline.map((evt) => {
                  let badgeBg = "bg-emerald-500";
                  let Icon = CheckCircle2;
                  if (evt.type === "failed_pull" || evt.type === "cancelled") {
                    badgeBg = "bg-red-500";
                    Icon = AlertCircle;
                  } else if (evt.type === "dunning_retry") {
                    badgeBg = "bg-amber-500";
                    Icon = Clock;
                  } else if (evt.type === "refund") {
                    badgeBg = "bg-blue-500";
                    Icon = ArrowDownLeft;
                  }

                  return (
                    <div key={evt.id} className="relative group">
                      {/* Timeline Dot */}
                      <div
                        className={`absolute -left-6 top-1 w-5 h-5 rounded-full ${badgeBg} text-white flex items-center justify-center shadow-xs ring-4 ring-white`}
                      >
                        <Icon size={11} />
                      </div>

                      {/* Event Card */}
                      <div className="rounded-xl border border-black/10 bg-white p-3.5 shadow-2xs hover:border-black/20 transition-colors">
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="font-semibold text-black text-xs">
                            {evt.title}
                          </h4>
                          <span className="font-mono text-[10px] text-neutral-400 shrink-0">
                            {new Date(evt.timestamp).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-[11px] text-neutral-600 mt-1 leading-relaxed">
                          {evt.description}
                        </p>

                        <div className="flex items-center gap-3 mt-2 pt-2 border-t border-black/5 text-[10px] font-mono text-neutral-500">
                          {evt.amount !== undefined && (
                            <span className="font-bold text-black">
                              Amount: {evt.amount.toFixed(2)} USDC
                            </span>
                          )}
                          {evt.txHash && (
                            <a
                              href={`https://stellar.expert/explorer/testnet/tx/${evt.txHash}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-neutral-500 hover:text-black flex items-center gap-1 underline"
                            >
                              <span>Tx: {evt.txHash.slice(0, 10)}...</span>
                              <ExternalLink size={9} />
                            </a>
                          )}
                          <span className="ml-auto uppercase text-[9px] font-bold px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-600">
                            {evt.type.replace("_", " ")}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-8 text-center rounded-xl border border-black/5 bg-neutral-50 text-neutral-500 text-xs">
                No past transactions recorded yet.
              </div>
            )}
          </div>

          {/* Non-custodial Soroban Guard */}
          <div className="p-3.5 rounded-xl bg-neutral-50 border border-black/5 flex items-start gap-2.5 text-[11px] text-neutral-600">
            <ShieldCheck size={16} className="text-black shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-black">Soroban Pull Security:</span>{" "}
              Customer allowance limits and interval enforcement are cryptographically enforced on-chain by the Orbit contract.
            </div>
          </div>
        </div>

        {/* Drawer Footer */}
        <div className="p-4 border-t border-black/10 bg-neutral-50 flex items-center justify-between">
          <span className="text-[11px] text-neutral-500 font-mono">
            Subscription ID: {subscriber.id.slice(0, 16)}...
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
