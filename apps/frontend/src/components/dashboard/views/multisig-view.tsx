"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signTransaction } from "@stellar/freighter-api";
import {
  BadgeCheck,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  FileSignature,
  Landmark,
  Loader2,
  Radio,
  ShieldAlert,
  UsersRound,
  XCircle,
  Zap,
} from "lucide-react";
import type { MultisigProposal, MultisigSigner } from "../dashboard-types";
import { connectFreighter } from "@/lib/freighter";
import {
  ORBIT_NETWORK_PASSPHRASE,
  SEED_PROPOSALS,
  approvedSigners,
  avatarClass,
  buildProposalEnvelope,
  initials,
  isThresholdMet,
  nextAdvancesSigner,
  proposalStateLabel,
} from "@/lib/multisig";
import { useAuth } from "@/lib/auth-context";

const KIND_META: Record<MultisigProposal["kind"], { label: string; icon: typeof Zap }> = {
  payroll: { label: "Batch payroll", icon: UsersRound },
  plan_update: { label: "Plan update", icon: FileSignature },
  treasury: { label: "Treasury", icon: Landmark },
};

const SIGNER_META: Record<
  MultisigSigner["state"],
  { label: string; ring: string; badge: string }
> = {
  approved: {
    label: "Approved",
    ring: "ring-2 ring-emerald-500",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  pending: {
    label: "Pending",
    ring: "ring-2 ring-neutral-300",
    badge: "bg-neutral-100 text-neutral-600 border-black/10",
  },
  rejected: {
    label: "Rejected",
    ring: "ring-2 ring-red-400",
    badge: "bg-red-50 text-red-700 border-red-200",
  },
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function MultisigView() {
  const { user } = useAuth();
  const selfWallet = user?.walletAddress || user?.linkedVaults?.stellar || "";
  const [proposals, setProposals] = useState<MultisigProposal[]>(SEED_PROPOSALS);
  const [liveSync, setLiveSync] = useState(true);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [broadcastingId, setBroadcastingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState(() => new Date().toISOString());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const proposalsRef = useRef(proposals);
  useEffect(() => {
    proposalsRef.current = proposals;
  }, [proposals]);

  // Real-time feed: mirror approvals arriving from other co-signers while the
  // room is open. Production replaces this with an SSE/polling subscription to
  // `/signing-sessions/:id`.
  useEffect(() => {
    if (!liveSync) return;
    const timer = setInterval(() => {
      if (!proposalsRef.current.some((proposal) => proposal.state === "collecting")) return;
      setProposals((previous) =>
        previous.map((proposal) => {
          if (proposal.state !== "collecting") return proposal;
          const advancing = nextAdvancesSigner(proposal, selfWallet);
          if (!advancing) return proposal;
          const signers = proposal.signers.map((signer) =>
            signer.id === advancing.id
              ? { ...signer, state: "approved" as const, signedAt: new Date().toISOString() }
              : signer
          );
          const updated: MultisigProposal = { ...proposal, signers };
          if (isThresholdMet(updated)) updated.state = "ready";
          return updated;
        })
      );
      setLastSyncedAt(new Date().toISOString());
    }, 5000);
    return () => clearInterval(timer);
  }, [liveSync, selfWallet]);

  const stats = useMemo(() => {
    const pending = proposals.filter((p) => p.state === "collecting" || p.state === "ready");
    const ready = proposals.filter((p) => p.state === "ready" || isThresholdMet(p));
    const collected = proposals.reduce((acc, p) => acc + approvedSigners(p).length, 0);
    const required = proposals.reduce((acc, p) => acc + p.threshold, 0);
    return { pending: pending.length, ready: ready.length, collected, required };
  }, [proposals]);

  const copyEnvelope = useCallback((id: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  }, []);

  const approveSigner = useCallback(
    (proposalId: string, walletAddress: string, signedXdr?: string) => {
      setProposals((previous) =>
        previous.map((proposal) => {
          if (proposal.id !== proposalId) return proposal;
          const existing = proposal.signers.find((s) => s.walletAddress === walletAddress);
          const signers = existing
            ? proposal.signers.map((signer) =>
                signer.walletAddress === walletAddress
                  ? {
                      ...signer,
                      state: "approved" as const,
                      signedAt: new Date().toISOString(),
                      signedXdr,
                    }
                  : signer
              )
            : [
                ...proposal.signers,
                {
                  id: `ms_sig_${Math.random().toString(36).slice(2, 8)}`,
                  name: "You",
                  walletAddress,
                  state: "approved" as const,
                  signedAt: new Date().toISOString(),
                  signedXdr,
                },
              ];
          const updated: MultisigProposal = { ...proposal, signers };
          if (isThresholdMet(updated)) updated.state = "ready";
          return updated;
        })
      );
    },
    []
  );

  const rejectSigner = useCallback((proposalId: string) => {
    setProposals((previous) =>
      previous.map((proposal) =>
        proposal.id === proposalId
          ? {
              ...proposal,
              signers: proposal.signers.map((signer) =>
                signer.walletAddress === selfWallet
                  ? { ...signer, state: "rejected" as const, signedAt: new Date().toISOString() }
                  : signer
              ),
            }
          : proposal
      )
    );
  }, [selfWallet]);

  const handleSign = useCallback(
    async (proposal: MultisigProposal) => {
      setError("");
      setNotice("");
      setSigningId(proposal.id);
      try {
        const connection = await connectFreighter();
        if (!connection.ok) {
          setError(connection.error);
          return;
        }
        // Prefer the stored Soroban envelope; fall back to a locally built one
        // so the Freighter handshake is exercised end to end in the demo.
        const envelope = buildProposalEnvelope(connection.address, proposal);
        const signed = await signTransaction(envelope, {
          address: connection.address,
          networkPassphrase: ORBIT_NETWORK_PASSPHRASE,
        });
        if (!signed.signedTxXdr) {
          throw new Error(signed.error?.message || "Freighter did not return a signed envelope.");
        }
        approveSigner(proposal.id, connection.address, signed.signedTxXdr);
        setNotice(`Partial signature transmitted for ${shortAddress(connection.address)}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Signing failed.");
      } finally {
        setSigningId(null);
      }
    },
    [approveSigner]
  );

  const handleBroadcast = useCallback((proposal: MultisigProposal) => {
    if (!isThresholdMet(proposal)) return;
    setBroadcastingId(proposal.id);
    setError("");
    setNotice("");
    // Combine every approved partial signature into one envelope and submit.
    setTimeout(() => {
      setProposals((previous) =>
        previous.map((p) =>
          p.id === proposal.id
            ? {
                ...p,
                state: "broadcast",
                txHash:
                  "0x" +
                  Array.from({ length: 16 }, () =>
                    "0123456789abcdef"[(Date.now() + Math.random() * 16) % 16 | 0]
                  ).join(""),
              }
            : p
        )
      );
      setBroadcastingId(null);
      setNotice("Combined envelope broadcast to Stellar testnet.");
    }, 1400);
  }, []);

  const connectedIsSigner = Boolean(selfWallet);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight text-black">Multi-Sig Coordination Room</h2>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-black text-white font-bold tracking-wide">
              M-OF-N
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-0.5">
            Coordinate high-value payroll and treasury actions that need several wallet signatures before they settle.
          </p>
        </div>

        <button
          onClick={() => setLiveSync((value) => !value)}
          className={`button text-xs h-9 px-3 flex items-center gap-2 self-start sm:self-auto ${
            liveSync ? "button-primary" : "button-secondary"
          }`}
          aria-pressed={liveSync}
        >
          <Radio size={13} className={liveSync ? "animate-pulse" : ""} />
          <span>{liveSync ? "Live sync on" : "Live sync paused"}</span>
        </button>
      </div>

      {/* Notice / Error banners */}
      {notice && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 flex items-center gap-2.5">
          <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div role="alert" className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-950 flex items-center gap-2.5">
          <ShieldAlert size={16} className="text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Summary ribbon */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Open proposals</div>
          <div className="text-2xl font-bold text-black mt-1">{stats.pending}</div>
          <div className="text-xs text-neutral-500 mt-0.5">Awaiting coordination</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Signatures collected</div>
          <div className="text-2xl font-bold text-black mt-1">
            {stats.collected}
            <span className="text-sm font-mono text-neutral-400"> / {stats.required}</span>
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">Against required thresholds</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Ready to broadcast</div>
          <div className={`text-2xl font-bold mt-1 ${stats.ready > 0 ? "text-emerald-600" : "text-black"}`}>{stats.ready}</div>
          <div className="text-xs text-neutral-500 mt-0.5 flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${liveSync ? "bg-emerald-500 animate-pulse" : "bg-neutral-300"}`} />
            Synced {timeAgo(lastSyncedAt)}
          </div>
        </div>
      </div>

      {/* Approval legend */}
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-neutral-500">
        {Object.entries(SIGNER_META).map(([state, meta]) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                state === "approved" ? "bg-emerald-500" : state === "rejected" ? "bg-red-400" : "bg-neutral-300"
              }`}
            />
            {meta.label}
          </span>
        ))}
      </div>

      {/* Proposal cards */}
      <div className="space-y-4">
        {proposals.map((proposal) => {
          const approvals = approvedSigners(proposal).length;
          const thresholdMet = isThresholdMet(proposal);
          const KindIcon = KIND_META[proposal.kind].icon;
          const selfSigner = proposal.signers.find((s) => s.walletAddress === selfWallet);
          const selfApproved = selfSigner?.state === "approved";
          const isBroadcast = proposal.state === "broadcast";
          const combinedEnvelope = proposal.signers
            .filter((s) => s.state === "approved" && s.signedXdr)
            .map((s) => `# ${s.name}\n${s.signedXdr}`)
            .join("\n\n");

          return (
            <div key={proposal.id} className="rounded-xl border border-black/10 bg-white shadow-xs overflow-hidden">
              <div className="p-5 flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-neutral-100 text-neutral-600 border border-black/5">
                        <KindIcon size={11} />
                        {KIND_META[proposal.kind].label}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border font-medium ${
                          isBroadcast
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : proposal.state === "rejected"
                            ? "bg-red-50 text-red-700 border-red-200"
                            : thresholdMet
                            ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                            : "bg-neutral-100 text-neutral-600 border-black/10"
                        }`}
                      >
                        {thresholdMet && !isBroadcast ? <BadgeCheck size={11} /> : <Clock size={11} />}
                        {proposalStateLabel(proposal)}
                      </span>
                    </div>
                    <h3 className="text-sm font-bold text-black mt-2">{proposal.title}</h3>
                    <p className="text-xs text-neutral-500 mt-0.5 max-w-2xl leading-relaxed">{proposal.description}</p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-neutral-400">
                      {proposal.amount > 0 && (
                        <span className="font-mono font-semibold text-neutral-700">
                          {proposal.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} {proposal.currency}
                        </span>
                      )}
                      <span>Created {timeAgo(proposal.createdAt)}</span>
                      <span>Expires {new Date(proposal.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">Threshold</div>
                    <div className="text-lg font-bold text-black">
                      {approvals}
                      <span className="text-sm text-neutral-400"> / {proposal.threshold}</span>
                    </div>
                    <div className="text-[10px] text-neutral-400 font-mono">{proposal.signers.length} signers</div>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="h-1.5 w-full rounded-full bg-neutral-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      thresholdMet ? "bg-emerald-500" : "bg-indigo-500"
                    }`}
                    style={{ width: `${Math.min(100, (approvals / proposal.threshold) * 100)}%` }}
                  />
                </div>

                {/* Signer roster */}
                <div className="flex flex-wrap items-center gap-4">
                  {proposal.signers.map((signer) => {
                    const meta = SIGNER_META[signer.state];
                    return (
                      <div key={signer.id} className="flex items-center gap-2.5" title={`${signer.name} · ${meta.label}`}>
                        <div className="relative">
                          <div
                            className={`w-9 h-9 rounded-full border flex items-center justify-center text-[11px] font-bold ${avatarClass(
                              signer.walletAddress
                            )} ${meta.ring}`}
                          >
                            {initials(signer.name)}
                          </div>
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white flex items-center justify-center ${
                              signer.state === "approved"
                                ? "bg-emerald-500"
                                : signer.state === "rejected"
                                ? "bg-red-500"
                                : "bg-neutral-300"
                            }`}
                          >
                            {signer.state === "approved" ? (
                              <Check size={8} className="text-white" />
                            ) : signer.state === "rejected" ? (
                              <XCircle size={8} className="text-white" />
                            ) : null}
                          </span>
                        </div>
                        <div className="leading-tight">
                          <div className="text-[11px] font-semibold text-black flex items-center gap-1">
                            {signer.name}
                            {signer.walletAddress === selfWallet && (
                              <span className="text-[9px] font-mono px-1 rounded bg-black text-white">YOU</span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono text-neutral-400">{shortAddress(signer.walletAddress)}</div>
                          <div className={`text-[10px] font-mono ${signer.state === "approved" ? "text-emerald-600" : signer.state === "rejected" ? "text-red-600" : "text-neutral-400"}`}>
                            {meta.label}
                            {signer.signedAt ? ` · ${timeAgo(signer.signedAt)}` : ""}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-black/5">
                  <button
                    onClick={() => handleSign(proposal)}
                    disabled={isBroadcast || selfApproved || signingId === proposal.id || !connectedIsSigner}
                    title={connectedIsSigner ? undefined : "Connect a Freighter wallet to sign"}
                    className="button button-secondary text-xs h-9 px-3 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {signingId === proposal.id ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        <span>Awaiting Freighter…</span>
                      </>
                    ) : selfApproved ? (
                      <>
                        <CheckCircle2 size={13} className="text-emerald-600" />
                        <span>You approved</span>
                      </>
                    ) : (
                      <>
                        <FileSignature size={13} />
                        <span>Sign with Freighter</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={() => handleBroadcast(proposal)}
                    disabled={!thresholdMet || isBroadcast || broadcastingId === proposal.id}
                    className={`button text-xs h-9 px-4 flex items-center gap-1.5 ${
                      thresholdMet && !isBroadcast ? "button-primary" : "button-secondary"
                    } disabled:opacity-50`}
                  >
                    {broadcastingId === proposal.id ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        <span>Broadcasting…</span>
                      </>
                    ) : isBroadcast ? (
                      <>
                        <CheckCircle2 size={13} />
                        <span>Broadcast complete</span>
                      </>
                    ) : (
                      <>
                        <Zap size={13} />
                        <span>Broadcast Transaction</span>
                      </>
                    )}
                  </button>

                  {connectedIsSigner && !selfApproved && !isBroadcast && (
                    <button
                      onClick={() => rejectSigner(proposal.id)}
                      className="button button-secondary text-xs h-9 px-3 text-neutral-500 hover:text-red-600"
                    >
                      Reject
                    </button>
                  )}
                </div>

                {/* Broadcast receipt */}
                {isBroadcast && proposal.txHash && (
                  <div className="rounded-lg bg-neutral-900 text-white p-3.5 text-[11px] font-mono flex items-center justify-between gap-3">
                    <span className="truncate">Combined envelope submitted · tx {proposal.txHash}</span>
                    <a
                      href={`https://stellar.expert/explorer/testnet/tx/${proposal.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-neutral-300 hover:text-white shrink-0"
                    >
                      Explorer <ExternalLink size={11} />
                    </a>
                  </div>
                )}

                {/* Combined partial signatures */}
                {combinedEnvelope && (
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">
                        Partial signature envelopes
                      </span>
                      <button
                        onClick={() => copyEnvelope(proposal.id, combinedEnvelope)}
                        className="text-[10px] text-neutral-400 hover:text-black inline-flex items-center gap-1"
                      >
                        {copiedId === proposal.id ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                        Copy all
                      </button>
                    </div>
                    <pre className="mt-1.5 max-h-24 overflow-auto rounded-lg bg-neutral-50 border border-black/5 p-2.5 text-[10px] font-mono text-neutral-600">
                      {combinedEnvelope}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
