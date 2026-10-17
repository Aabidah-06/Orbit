"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { useAuth } from "@/lib/auth-context";

export type TeamRole = "owner" | "admin" | "developer" | "viewer";

export type Permission = "view" | "manageKeys" | "runPayroll" | "manageTeam";

export const TEAM_ROLES: TeamRole[] = ["owner", "admin", "developer", "viewer"];

/** Roles an owner/admin can hand out when inviting; there is exactly one owner. */
export const INVITABLE_ROLES: TeamRole[] = ["admin", "developer", "viewer"];

export const ROLE_PERMISSIONS: Record<TeamRole, Permission[]> = {
  owner: ["view", "manageKeys", "runPayroll", "manageTeam"],
  admin: ["view", "manageKeys", "runPayroll", "manageTeam"],
  developer: ["view", "manageKeys"],
  viewer: ["view"],
};

export interface TeamMember {
  id: string;
  name: string;
  walletAddress: string;
  role: TeamRole;
  joinedAt: string;
}

export type InviteError = "nameRequired" | "walletInvalid" | "walletDuplicate";

interface TeamContextType {
  members: TeamMember[];
  /** The member record matching the connected wallet, if any. */
  currentMember: TeamMember | null;
  role: TeamRole;
  can: (permission: Permission) => boolean;
  inviteMember: (input: {
    name: string;
    walletAddress: string;
    role: TeamRole;
  }) => { ok: true } | { ok: false; error: InviteError };
  removeMember: (id: string) => void;
}

const TeamContext = createContext<TeamContextType | undefined>(undefined);

const storageKey = (merchantId: string) => `orbit_team_${merchantId}`;

export function TeamProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const merchantId = user?.id;
  const walletAddress = user?.walletAddress || user?.linkedVaults?.stellar || "";

  const [members, setMembers] = useState<TeamMember[]>([]);

  // Load (or seed) the roster for this merchant. The merchant who created the account is the owner.
  useEffect(() => {
    if (!user) {
      setMembers([]);
      return;
    }
    let stored: TeamMember[] | null = null;
    try {
      const raw = localStorage.getItem(storageKey(user.id));
      if (raw) stored = JSON.parse(raw) as TeamMember[];
    } catch (err) {
      console.error("Failed to load team roster:", err);
    }
    setMembers(
      stored && stored.length > 0
        ? stored
        : [
            {
              id: "tm_owner",
              name: user.businessName,
              walletAddress,
              role: "owner",
              joinedAt: user.createdAt,
            },
          ]
    );
    // Seed only when the session identity changes; wallet changes are reconciled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId]);

  const persist = useCallback(
    (next: TeamMember[]) => {
      setMembers(next);
      if (!merchantId) return;
      try {
        localStorage.setItem(storageKey(merchantId), JSON.stringify(next));
      } catch (err) {
        console.error("Failed to save team roster:", err);
      }
    },
    [merchantId]
  );

  // Keep the owner row pointed at the merchant's wallet once one is linked.
  useEffect(() => {
    if (!walletAddress) return;
    setMembers((prev) => {
      const owner = prev.find((m) => m.role === "owner");
      if (!owner || owner.walletAddress) return prev;
      const next = prev.map((m) => (m.id === owner.id ? { ...m, walletAddress } : m));
      if (merchantId) {
        try {
          localStorage.setItem(storageKey(merchantId), JSON.stringify(next));
        } catch {
          // storage unavailable; roster stays in memory
        }
      }
      return next;
    });
  }, [walletAddress, merchantId]);

  const currentMember = useMemo(
    () => (walletAddress ? members.find((m) => m.walletAddress === walletAddress) ?? null : null),
    [members, walletAddress]
  );

  // The signed-in merchant is the owner unless the connected wallet belongs to an invited member.
  const role: TeamRole = currentMember?.role ?? "owner";

  const can = useCallback((permission: Permission) => ROLE_PERMISSIONS[role].includes(permission), [role]);

  const inviteMember: TeamContextType["inviteMember"] = useCallback(
    ({ name, walletAddress: address, role: inviteRole }) => {
      const cleanName = name.trim();
      const cleanAddress = address.trim();
      if (!cleanName) return { ok: false, error: "nameRequired" };
      if (!StrKey.isValidEd25519PublicKey(cleanAddress)) return { ok: false, error: "walletInvalid" };
      if (members.some((m) => m.walletAddress === cleanAddress)) {
        return { ok: false, error: "walletDuplicate" };
      }
      persist([
        ...members,
        {
          id: "tm_" + Math.random().toString(36).substring(2, 9),
          name: cleanName,
          walletAddress: cleanAddress,
          role: inviteRole === "owner" ? "viewer" : inviteRole,
          joinedAt: new Date().toISOString(),
        },
      ]);
      return { ok: true };
    },
    [members, persist]
  );

  const removeMember = useCallback(
    (id: string) => {
      persist(members.filter((m) => m.id !== id || m.role === "owner"));
    },
    [members, persist]
  );

  return (
    <TeamContext.Provider value={{ members, currentMember, role, can, inviteMember, removeMember }}>
      {children}
    </TeamContext.Provider>
  );
}

export function useTeam() {
  const context = useContext(TeamContext);
  if (!context) {
    throw new Error("useTeam must be used within a TeamProvider");
  }
  return context;
}
