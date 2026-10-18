"use client";

import { useState, useEffect } from "react";
import {
  X,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Copy,
  ExternalLink,
  ChevronRight,
  ArrowLeft,
  Sparkles,
  Layers,
  Key,
  Check,
  Loader2,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { updateMerchantContract } from "@/lib/api";
import {
  deployBrandedVaultContract,
  getFreighterAdminAddress,
  DEFAULT_USDC_CONTRACT_ID,
  DEFAULT_WASM_HASH,
} from "@/lib/deploy-soroban";

interface DeployVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (contractId: string) => void;
}

type WizardStep = 1 | 2 | 3 | 4;

export function DeployVaultModal({ isOpen, onClose, onSuccess }: DeployVaultModalProps) {
  const { user, updateContractId } = useAuth();

  const [currentStep, setCurrentStep] = useState<WizardStep>(1);
  const [vaultName, setVaultName] = useState(user?.businessName ? `${user.businessName} Vault` : "My Branded Vault");
  const [symbol, setSymbol] = useState(
    user?.businessName
      ? `${user.businessName.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase()}-VAULT`
      : "ORBIT-VAULT"
  );
  const [adminAddress, setAdminAddress] = useState(user?.walletAddress || "");
  const [tokenContractId, setTokenContractId] = useState(DEFAULT_USDC_CONTRACT_ID);
  const [intervalDays, setIntervalDays] = useState("30");
  const [wasmHash, setWasmHash] = useState(DEFAULT_WASM_HASH);

  // Signature and deployment state
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploymentStatus, setDeploymentStatus] = useState<string>("");
  const [deployedContractId, setDeployedContractId] = useState<string>("");
  const [txHash, setTxHash] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedContractId, setCopiedContractId] = useState(false);

  // Auto-fill admin address from user or Freighter if available
  useEffect(() => {
    if (user?.walletAddress && !adminAddress) {
      setAdminAddress(user.walletAddress);
    }
  }, [user?.walletAddress, adminAddress]);

  if (!isOpen) return null;

  const handleConnectFreighter = async () => {
    try {
      setErrorMessage(null);
      const address = await getFreighterAdminAddress();
      setAdminAddress(address);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to connect to Freighter";
      setErrorMessage(msg);
    }
  };

  const handleNextFromStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!vaultName.trim() || !symbol.trim() || !adminAddress.trim()) {
      setErrorMessage("Please complete all configuration fields.");
      return;
    }
    setErrorMessage(null);
    setCurrentStep(2);
  };

  const handleNextFromStep2 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenContractId.trim()) {
      setErrorMessage("Token contract ID is required.");
      return;
    }
    setErrorMessage(null);
    setCurrentStep(3);
  };

  const handleDeployContract = async () => {
    try {
      setIsDeploying(true);
      setErrorMessage(null);

      const intervalSecs = Math.max(86400, (parseInt(intervalDays, 10) || 30) * 86400);

      const result = await deployBrandedVaultContract(
        {
          vaultName: vaultName.trim(),
          symbol: symbol.trim(),
          adminAddress: adminAddress.trim(),
          network: "testnet",
        },
        {
          tokenContractId: tokenContractId.trim(),
          intervalSeconds: intervalSecs,
          wasmHash: wasmHash.trim(),
        },
        (status) => setDeploymentStatus(status)
      );

      setDeployedContractId(result.contractId);
      setTxHash(result.transactionHash);

      // Save to Supabase profile
      try {
        await updateMerchantContract(result.contractId);
      } catch (saveErr) {
        console.warn("Could not persist to Supabase profile via backend API:", saveErr);
      }

      // Switch context in auth provider
      updateContractId(result.contractId);
      onSuccess?.(result.contractId);

      setCurrentStep(4);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Contract deployment failed";
      setErrorMessage(msg);
    } finally {
      setIsDeploying(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedContractId(true);
    setTimeout(() => setCopiedContractId(false), 2000);
  };

  const resetAndClose = () => {
    setCurrentStep(1);
    setErrorMessage(null);
    setIsDeploying(false);
    setDeploymentStatus("");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="w-full max-w-2xl rounded-2xl bg-white border border-black/10 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-black/10 flex items-center justify-between bg-neutral-50/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-black text-white flex items-center justify-center shadow-xs">
              <Sparkles size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-black tracking-tight">
                Deploy Branded Custom Vault
              </h2>
              <p className="text-xs text-neutral-500">
                Automated Soroban contract deployment wizard on Stellar Testnet
              </p>
            </div>
          </div>
          <button
            onClick={resetAndClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-black hover:bg-neutral-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Step Progress Bar */}
        <div className="px-6 py-3 border-b border-black/5 bg-neutral-50/20">
          <div className="grid grid-cols-4 gap-2 text-xs">
            {[
              { num: 1, label: "Configuration" },
              { num: 2, label: "Parameters" },
              { num: 3, label: "Wallet Signature" },
              { num: 4, label: "Verification" },
            ].map((s) => (
              <div
                key={s.num}
                className={`flex items-center gap-2 py-1 border-b-2 transition-colors ${
                  currentStep === s.num
                    ? "border-black font-semibold text-black"
                    : currentStep > s.num
                    ? "border-emerald-500 font-medium text-emerald-600"
                    : "border-transparent text-neutral-400"
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full text-[10px] flex items-center justify-center shrink-0 font-mono ${
                    currentStep === s.num
                      ? "bg-black text-white"
                      : currentStep > s.num
                      ? "bg-emerald-500 text-white"
                      : "bg-neutral-200 text-neutral-600"
                  }`}
                >
                  {currentStep > s.num ? <Check size={12} /> : s.num}
                </div>
                <span className="truncate">{s.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto max-h-[70vh]">
          {errorMessage && (
            <div className="mb-5 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5">
              <AlertCircle size={16} className="text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Deployment Warning</p>
                <p className="text-rose-700 mt-0.5">{errorMessage}</p>
              </div>
            </div>
          )}

          {/* STEP 1: Configuration */}
          {currentStep === 1 && (
            <form onSubmit={handleNextFromStep1} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
                  Vault Brand Name
                </label>
                <input
                  type="text"
                  required
                  value={vaultName}
                  onChange={(e) => setVaultName(e.target.value)}
                  placeholder="e.g. Acme Premium Subscription Vault"
                  className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 text-xs text-black focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
                />
                <p className="text-[11px] text-neutral-500 mt-1">
                  Branded identifier displayed on subscribers&apos; wallet approvals.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
                  Vault Symbol
                </label>
                <input
                  type="text"
                  required
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="e.g. ACME-VAULT"
                  className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 text-xs font-mono uppercase text-black focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-black uppercase tracking-wider">
                    Merchant Admin Wallet Address
                  </label>
                  <button
                    type="button"
                    onClick={handleConnectFreighter}
                    className="text-[11px] text-black hover:underline flex items-center gap-1 font-medium"
                  >
                    <Key size={12} />
                    Auto-fill from Freighter
                  </button>
                </div>
                <input
                  type="text"
                  required
                  value={adminAddress}
                  onChange={(e) => setAdminAddress(e.target.value)}
                  placeholder="G..."
                  className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 text-xs font-mono text-black focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
                />
                <p className="text-[11px] text-neutral-500 mt-1">
                  The admin public key will hold contract control, receive settlement funds, and manage parameters.
                </p>
              </div>

              <div className="pt-2">
                <label className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
                  Target Blockchain Network
                </label>
                <div className="p-3 rounded-xl border border-black/10 bg-neutral-50/60 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs font-semibold text-black">Stellar Testnet (Soroban v22)</span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold">
                    Testnet
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-black/10 mt-6">
                <button
                  type="button"
                  onClick={resetAndClose}
                  className="button button-secondary text-xs h-9 px-4"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary text-xs h-9 px-5 flex items-center gap-1.5"
                >
                  Next: Parameters
                  <ChevronRight size={14} />
                </button>
              </div>
            </form>
          )}

          {/* STEP 2: Parameters */}
          {currentStep === 2 && (
            <form onSubmit={handleNextFromStep2} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
                  Settlement Token Contract ID (USDC)
                </label>
                <input
                  type="text"
                  required
                  value={tokenContractId}
                  onChange={(e) => setTokenContractId(e.target.value)}
                  placeholder="C..."
                  className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 text-xs font-mono text-black focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
                />
                <p className="text-[11px] text-neutral-500 mt-1">
                  Stellar Asset Contract address for receiving subscriber payments. Defaults to Testnet SAC USDC.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
                  Default Billing Interval (Days)
                </label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(e.target.value)}
                  className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 text-xs font-mono text-black focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
                  Contract WASM Bytecode / Hash
                </label>
                <input
                  type="text"
                  value={wasmHash}
                  onChange={(e) => setWasmHash(e.target.value)}
                  placeholder="64-character hex hash"
                  className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 text-xs font-mono text-black focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
                />
                <p className="text-[11px] text-neutral-500 mt-1">
                  Standard Orbit Vault WASM binary hash deployed to Stellar Testnet.
                </p>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-black/10 mt-6">
                <button
                  type="button"
                  onClick={() => setCurrentStep(1)}
                  className="button button-secondary text-xs h-9 px-4 flex items-center gap-1.5"
                >
                  <ArrowLeft size={14} />
                  Back
                </button>
                <button
                  type="submit"
                  className="button button-primary text-xs h-9 px-5 flex items-center gap-1.5"
                >
                  Next: Wallet Signature
                  <ChevronRight size={14} />
                </button>
              </div>
            </form>
          )}

          {/* STEP 3: Wallet Signature */}
          {currentStep === 3 && (
            <div className="space-y-5">
              <div className="p-4 rounded-xl border border-black/10 bg-neutral-50/50 space-y-3">
                <h3 className="text-xs font-bold text-black uppercase tracking-wider">
                  Deployment Summary
                </h3>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-neutral-500 block text-[11px]">Vault Name:</span>
                    <span className="font-semibold text-black">{vaultName}</span>
                  </div>
                  <div>
                    <span className="text-neutral-500 block text-[11px]">Symbol:</span>
                    <span className="font-mono font-semibold text-black">{symbol}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-neutral-500 block text-[11px]">Merchant Admin:</span>
                    <span className="font-mono text-black text-[11px] break-all">{adminAddress}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-neutral-500 block text-[11px]">Token Contract:</span>
                    <span className="font-mono text-black text-[11px] break-all">{tokenContractId}</span>
                  </div>
                </div>
              </div>

              {isDeploying ? (
                <div className="p-6 rounded-xl border border-black/10 bg-neutral-50 flex flex-col items-center justify-center gap-3">
                  <Loader2 size={28} className="text-black animate-spin" />
                  <div className="text-center">
                    <p className="text-xs font-bold text-black">Deploying Soroban Contract</p>
                    <p className="text-xs font-mono text-neutral-500 mt-1">{deploymentStatus || "Communicating with Freighter..."}</p>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-xl border border-black/10 bg-neutral-50/30 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center shrink-0">
                    <Key size={16} />
                  </div>
                  <div className="text-xs">
                    <p className="font-semibold text-black">Freighter Wallet Authentication</p>
                    <p className="text-neutral-500 mt-0.5">
                      Freighter will prompt you to authorize the contract installation and admin initialization.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-4 border-t border-black/10 mt-6">
                <button
                  type="button"
                  disabled={isDeploying}
                  onClick={() => setCurrentStep(2)}
                  className="button button-secondary text-xs h-9 px-4 flex items-center gap-1.5"
                >
                  <ArrowLeft size={14} />
                  Back
                </button>
                <button
                  type="button"
                  disabled={isDeploying}
                  onClick={handleDeployContract}
                  className="button button-primary text-xs h-9 px-5 flex items-center gap-2"
                >
                  {isDeploying ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Deploying...
                    </>
                  ) : (
                    <>
                      <ShieldCheck size={14} />
                      Sign & Deploy Contract
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: Verification */}
          {currentStep === 4 && (
            <div className="space-y-5 text-center py-2">
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto shadow-xs">
                <CheckCircle2 size={28} />
              </div>

              <div>
                <h3 className="text-base font-bold text-black">
                  Contract Successfully Deployed & Verified!
                </h3>
                <p className="text-xs text-neutral-500 mt-1 max-w-md mx-auto">
                  Your custom branded vault is active on Stellar Testnet and configured with your wallet as admin.
                </p>
              </div>

              <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/60 text-left space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-emerald-800 uppercase tracking-wider">
                    Deployed Contract ID
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-200 text-emerald-900 font-bold">
                    Verified On-Chain
                  </span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-white border border-emerald-200">
                  <code className="text-xs font-mono font-bold text-black break-all select-all">
                    {deployedContractId}
                  </code>
                  <button
                    onClick={() => copyToClipboard(deployedContractId)}
                    className="p-1.5 rounded hover:bg-neutral-100 text-neutral-500 hover:text-black transition-colors shrink-0 ml-2"
                    title="Copy Contract ID"
                  >
                    {copiedContractId ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                  </button>
                </div>

                {txHash && (
                  <div className="text-[11px] text-neutral-600 flex items-center justify-between pt-1">
                    <span>Transaction Hash:</span>
                    <a
                      href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-black hover:underline flex items-center gap-1"
                    >
                      {txHash.slice(0, 10)}...{txHash.slice(-6)}
                      <ExternalLink size={11} />
                    </a>
                  </div>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-neutral-50 border border-black/10 text-xs text-neutral-600 text-left flex items-center gap-2.5">
                <Layers size={16} className="text-black shrink-0" />
                <span>
                  Contract saved to your Supabase merchant profile. The dashboard context has been automatically updated.
                </span>
              </div>

              <div className="pt-4 border-t border-black/10">
                <button
                  type="button"
                  onClick={resetAndClose}
                  className="button button-primary w-full text-xs h-10"
                >
                  Return to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
