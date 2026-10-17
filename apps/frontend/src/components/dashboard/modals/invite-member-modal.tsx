"use client";

import { useState } from "react";
import { X, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { INVITABLE_ROLES, InviteError, TeamRole, useTeam } from "@/lib/team-context";

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function InviteMemberModal({ isOpen, onClose }: InviteMemberModalProps) {
  const t = useTranslations("Team");
  const tCommon = useTranslations("Common");
  const { inviteMember } = useTeam();
  const [name, setName] = useState("");
  const [wallet, setWallet] = useState("");
  const [role, setRole] = useState<TeamRole>("viewer");
  const [error, setError] = useState<InviteError | null>(null);

  if (!isOpen) return null;

  const resetAndClose = () => {
    setName("");
    setWallet("");
    setRole("viewer");
    setError(null);
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = inviteMember({ name, walletAddress: wallet, role });
    if (result.ok) {
      resetAndClose();
    } else {
      setError(result.error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-member-title"
        className="w-full max-w-lg rounded-xl bg-white border border-black/10 shadow-2xl p-6"
      >
        <div className="flex items-center justify-between pb-4 border-b border-black/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <UserPlus size={16} />
            </div>
            <div>
              <h3 id="invite-member-title" className="text-base font-bold text-black tracking-tight">
                {t("modal.title")}
              </h3>
              <p className="text-xs text-neutral-500">{t("modal.description")}</p>
            </div>
          </div>
          <button
            onClick={resetAndClose}
            aria-label={tCommon("close")}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-black hover:bg-neutral-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          <div>
            <label htmlFor="invite-name" className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
              {t("modal.name")}
            </label>
            <input
              id="invite-name"
              type="text"
              placeholder={t("modal.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 text-xs text-black focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="invite-wallet" className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
              {t("modal.wallet")}
            </label>
            <input
              id="invite-wallet"
              type="text"
              spellCheck={false}
              placeholder={t("modal.walletPlaceholder")}
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 text-xs font-mono text-black focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
            />
          </div>

          <div>
            <label htmlFor="invite-role" className="block text-xs font-semibold text-black uppercase tracking-wider mb-1.5">
              {t("modal.role")}
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as TeamRole)}
              className="w-full rounded-lg border border-black/10 px-3.5 py-2.5 text-xs text-black bg-white focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
            >
              {INVITABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-neutral-500 mt-1">{t(`roleDescriptions.${role}`)}</p>
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-600">
              {t(`modal.errors.${error}`)}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-black/10">
            <button type="button" onClick={resetAndClose} className="button button-secondary text-xs h-9 px-4">
              {tCommon("cancel")}
            </button>
            <button type="submit" className="button button-primary text-xs h-9 px-4">
              {t("modal.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
