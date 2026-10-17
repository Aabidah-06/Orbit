"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { SubscriberRecord } from "../dashboard-types";
import { generateRecoveryLink, mapApiSubscriberToRecord } from "@/lib/api";
import { checkPendingPull, fetchPullDiagnostics, PullFailure, retrySignedPull, waiveInterval } from "@/lib/billing-resolution";

const failureLabels: Record<string, string> = {
  insufficient_balance: "Insufficient balance", expired_allowance: "Expired allowance",
  insufficient_allowance: "Insufficient allowance", rpc_timeout: "RPC timeout", unknown: "Failure reason unavailable",
};

export function PastDueResolutionModal({ subscriber, demo, onClose, onUpdated }: {
  subscriber: SubscriberRecord; demo: boolean; onClose: () => void;
  onUpdated: (subscriber?: SubscriberRecord) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failure, setFailure] = useState<PullFailure | undefined>(subscriber.lastFailure);
  const [loading, setLoading] = useState(!demo);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState(subscriber.lastFailure?.code === "rpc_timeout" ? subscriber.lastFailure.transaction_hash || "" : "");
  const [waiveConfirm, setWaiveConfirm] = useState(false);
  const [resolved, setResolved] = useState(false);
  const waiverKey = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    if (!demo) fetchPullDiagnostics(subscriber.id, controller.signal).then((diagnostic) => {
      setFailure(diagnostic);
      setTxHash(diagnostic.code === "rpc_timeout" ? diagnostic.transaction_hash || "" : "");
      if (diagnostic.code === "rpc_timeout" && diagnostic.transaction_hash) {
        setTxHash(diagnostic.transaction_hash);
        setStatus("A previous transaction has an unknown outcome. Check it before attempting another charge or waiver.");
      }
    })
      .catch((reason) => { if (reason.name !== "AbortError") setError(reason.message); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [demo, subscriber.id]);

  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError(""); setStatus("");
    try { await run(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The action failed."); }
    finally { setBusy(false); }
  };

  return <dialog ref={dialog} aria-labelledby="past-due-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    className="m-auto w-[calc(100%_-_2rem)] max-w-lg rounded-2xl border border-black/10 bg-white p-6 text-sm shadow-xl backdrop:bg-black/40">
    <div className="flex items-center justify-between gap-4"><h2 id="past-due-title" className="text-lg font-bold">Resolve past-due payment</h2>
      <button aria-label="Close resolution" onClick={onClose} disabled={busy}><X size={20} /></button></div>
    <p className="mt-2 text-neutral-500">{subscriber.planName} · {subscriber.amount.toFixed(2)} USDC</p>
    <p className="mt-1 break-all font-mono text-xs">{subscriber.walletAddress}</p>
    <div className="my-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h3 className="font-semibold">{loading ? "Loading failure diagnostics…" : failureLabels[failure?.code || "unknown"] || "Contract failure"}</h3>
      <p className="mt-2 break-words text-xs">{failure?.message || "No specific failure cause was recorded. A retry will simulate the transaction before signing."}</p>
      {failure?.occurred_at && <p className="mt-2 text-xs">Last attempt: {new Date(failure.occurred_at).toLocaleString()}</p>}
    </div>
    {demo && <p className="mb-4 text-xs text-neutral-500">Switch to Live API and connect your merchant API key to resolve a real subscription.</p>}
    <div className="flex flex-col gap-3">
      {txHash && !resolved && <button className="button button-secondary h-10" disabled={busy} onClick={() => action(async () => {
        const result = await checkPendingPull(subscriber.id);
        if (result.status === "NOT_FOUND") { setStatus("The transaction is still unconfirmed. Check again shortly."); return; }
        if (result.status === "SUCCESS") {
          setResolved(true); setStatus("Payment confirmed on Stellar. Billing state is up to date."); onUpdated();
        } else {
          setTxHash(""); setFailure(result.subscription?.last_failure);
          setStatus("The previous transaction failed. You can retry the pull now.");
        }
      })}>Check transaction status</button>}
      <button className="button button-primary h-10" disabled={demo || busy || loading || !!txHash || resolved} onClick={() => action(async () => {
        const result = await retrySignedPull(subscriber.id, setStatus);
        setTxHash(result.txHash);
        setStatus(result.pending ? "Submitted; confirmation is pending. Check the transaction before attempting another charge." : "Payment confirmed on Stellar.");
        if (!result.pending) { setResolved(true); onUpdated(); }
      })}>Retry Pull Now</button>
      <button className="button button-secondary h-10" disabled={demo || busy} onClick={() => action(async () => {
        const recovery = await generateRecoveryLink(subscriber.id);
        await navigator.clipboard.writeText(recovery.recovery_url);
        setStatus("Recovery link copied.");
      })}>Copy Recovery Link</button>
      {!waiveConfirm ? <button className="button button-secondary h-10" disabled={demo || busy || loading || !!txHash || resolved} onClick={() => setWaiveConfirm(true)}>Waive Interval</button> :
        <div className="rounded-lg border p-3"><p className="text-xs">Forgive this cycle and advance the billing date by one interval. This records a waiver without transferring funds.</p>
          <div className="mt-3 flex gap-3"><button className="button button-primary h-9 px-3" disabled={busy} onClick={() => action(async () => {
            const updated = await waiveInterval(subscriber.id, waiverKey.current);
            onUpdated({ ...mapApiSubscriberToRecord(updated), planName: subscriber.planName, amount: subscriber.amount, totalSettled: subscriber.totalSettled });
            setStatus("Interval waived. The billing date has advanced."); setWaiveConfirm(false); setResolved(true);
          })}>Confirm waiver</button><button disabled={busy} onClick={() => setWaiveConfirm(false)}>Cancel</button></div></div>}
    </div>
    <p role="status" aria-live="polite" className="mt-4 text-xs text-emerald-700">{status}</p>
    {txHash && <p className="mt-2 break-all font-mono text-xs">Transaction: {txHash}</p>}
    {error && <p role="alert" className="mt-3 text-xs text-red-700">{error}</p>}
  </dialog>;
}
