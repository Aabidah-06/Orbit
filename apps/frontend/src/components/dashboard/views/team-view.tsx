"use client";

import { useState } from "react";
import { Check, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Permission,
  ROLE_PERMISSIONS,
  TEAM_ROLES,
  TeamRole,
  useTeam,
} from "@/lib/team-context";
import { InviteMemberModal } from "../modals/invite-member-modal";

const ROLE_BADGE_STYLES: Record<TeamRole, string> = {
  owner: "bg-black text-white border-black",
  admin: "bg-indigo-50 text-indigo-700 border-indigo-200",
  developer: "bg-emerald-50 text-emerald-700 border-emerald-200",
  viewer: "bg-neutral-100 text-neutral-600 border-black/10",
};

const PERMISSIONS: Permission[] = ["view", "manageKeys", "runPayroll", "manageTeam"];

export function RoleBadge({ role }: { role: TeamRole }) {
  const t = useTranslations("Team.roles");
  return (
    <span
      className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${ROLE_BADGE_STYLES[role]}`}
      data-testid={`role-badge-${role}`}
    >
      {t(role)}
    </span>
  );
}

function shortAddress(address: string) {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

export function TeamView() {
  const t = useTranslations("Team");
  const locale = useLocale();
  const { members, currentMember, role, can, removeMember } = useTeam();
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const canManage = can("manageTeam");

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));

  const handleRemove = (id: string, name: string) => {
    if (window.confirm(t("removeConfirm", { name }))) removeMember(id);
  };

  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-black/5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-black tracking-tight">{t("title")}</h2>
              <p className="text-xs text-neutral-500 mt-0.5">{t("description")}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 self-start sm:self-auto">
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <span>{t("yourRole")}</span>
              <RoleBadge role={role} />
            </div>
            <button
              onClick={() => setIsInviteOpen(true)}
              disabled={!canManage}
              title={canManage ? undefined : t("noPermission")}
              className="button button-primary text-xs h-9 px-4 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <UserPlus size={14} />
              <span>{t("invite")}</span>
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between pt-5 pb-3">
          <h3 className="text-sm font-semibold text-black">{t("members")}</h3>
          <span className="text-xs font-mono text-neutral-500">{t("memberCount", { count: members.length })}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-50/80 border-b border-black/10 text-neutral-500 uppercase tracking-wider font-semibold text-[10px]">
              <tr>
                <th className="py-3.5 px-5">{t("columns.member")}</th>
                <th className="py-3.5 px-4">{t("columns.wallet")}</th>
                <th className="py-3.5 px-4">{t("columns.role")}</th>
                <th className="py-3.5 px-4">{t("columns.joined")}</th>
                <th className="py-3.5 px-5 text-right">{t("columns.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {members.map((member) => {
                const isOwner = member.role === "owner";
                const isSelf = currentMember?.id === member.id;
                return (
                  <tr key={member.id} className="hover:bg-neutral-50/50 transition-colors">
                    <td className="py-3.5 px-5 font-semibold text-black">
                      {member.name}
                      {isSelf && (
                        <span className="ml-2 text-[10px] font-normal text-neutral-400">({t("you")})</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-neutral-600" title={member.walletAddress}>
                      {member.walletAddress ? shortAddress(member.walletAddress) : "—"}
                    </td>
                    <td className="py-3.5 px-4">
                      <RoleBadge role={member.role} />
                    </td>
                    <td className="py-3.5 px-4 text-neutral-500">{formatDate(member.joinedAt)}</td>
                    <td className="py-3.5 px-5 text-right">
                      <button
                        onClick={() => handleRemove(member.id, member.name)}
                        disabled={isOwner || !canManage}
                        title={isOwner ? t("cannotRemoveOwner") : canManage ? t("remove") : t("noPermission")}
                        aria-label={`${t("remove")}: ${member.name}`}
                        className="p-1 text-neutral-400 hover:text-red-600 transition-colors disabled:opacity-30 disabled:hover:text-neutral-400 disabled:cursor-not-allowed"
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {members.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-neutral-500">
                    {t("empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs">
        <h3 className="text-sm font-semibold text-black">{t("permissionsTitle")}</h3>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-black/10 text-neutral-500 uppercase tracking-wider font-semibold text-[10px]">
              <tr>
                <th className="py-3 px-4">{t("columns.role")}</th>
                {PERMISSIONS.map((p) => (
                  <th key={p} className="py-3 px-4 text-center">
                    {t(`permissions.${p}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {TEAM_ROLES.map((r) => (
                <tr key={r}>
                  <td className="py-3 px-4">
                    <div className="flex flex-col gap-1">
                      <RoleBadge role={r} />
                      <span className="text-[11px] text-neutral-500 max-w-xs">{t(`roleDescriptions.${r}`)}</span>
                    </div>
                  </td>
                  {PERMISSIONS.map((p) => (
                    <td key={p} className="py-3 px-4 text-center">
                      {ROLE_PERMISSIONS[r].includes(p) ? (
                        <Check size={14} className="inline text-emerald-600" aria-label="✓" />
                      ) : (
                        <span className="text-neutral-300" aria-label="—">
                          —
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <InviteMemberModal isOpen={isInviteOpen} onClose={() => setIsInviteOpen(false)} />
    </div>
  );
}
