"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { setMerchantApiKey } from "@/lib/api";

export interface LinkedVaults {
  stellar?: string;
  contract_id?: string;
}

export interface MerchantUser {
  id: string;
  email: string;
  businessName: string;
  walletAddress?: string;
  customContractId?: string;
  linkedVaults?: LinkedVaults;
  createdAt: string;
}

interface AuthContextType {
  user: MerchantUser | null;
  isLoading: boolean;
  signUp: (data: {
    email: string;
    password?: string;
    businessName: string;
    walletAddress?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  signIn: (
    email: string,
    password?: string,
    businessName?: string
  ) => Promise<{ success: boolean; error?: string }>;
  signInWithWallet: (walletAddress: string) => Promise<{ success: boolean; error?: string }>;
  updateWallet: (walletAddress: string) => void;
  updateVault: (chain: "stellar", address: string) => void;
  updateContractId: (contractId: string) => void;
  updateBusinessName: (businessName: string) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const STORAGE_KEY = "orbit_merchant_session";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<MerchantUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  useEffect(() => { setMerchantApiKey(""); }, [user?.id]);

  // Restore session on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setUser(JSON.parse(stored));
      }
    } catch (err) {
      console.error("Failed to load merchant session:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const saveUserSession = (userData: MerchantUser) => {
    setUser(userData);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userData));
    } catch (err) {
      console.error("Failed to save merchant session:", err);
    }
  };

  const signUp = async ({
    email,
    businessName,
    walletAddress,
  }: {
    email: string;
    password?: string;
    businessName: string;
    walletAddress?: string;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!email || !email.includes("@")) {
        return { success: false, error: "Please enter a valid work email address." };
      }
      if (!businessName || businessName.trim().length < 2) {
        return { success: false, error: "Please provide your business or project name." };
      }

      const newUser: MerchantUser = {
        id: "mch_" + Math.random().toString(36).substring(2, 11),
        email: email.trim().toLowerCase(),
        businessName: businessName.trim(),
        walletAddress: walletAddress?.trim() || undefined,
        createdAt: new Date().toISOString(),
      };

      saveUserSession(newUser);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Registration failed";
      return { success: false, error: msg };
    }
  };

  const signIn = async (
    email: string,
    password?: string,
    businessName?: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!email || !email.includes("@")) {
        return { success: false, error: "Please enter a valid work email address." };
      }

      // Check if existing user session exists, or initialize merchant profile
      const stored = localStorage.getItem(STORAGE_KEY);
      let userData: MerchantUser;
      const cleanBusiness = businessName?.trim() || "Orbit Merchant";

      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.email === email.trim().toLowerCase()) {
          userData = {
            ...parsed,
            ...(businessName?.trim() ? { businessName: businessName.trim() } : {}),
          };
        } else {
          userData = {
            id: "mch_" + Math.random().toString(36).substring(2, 11),
            email: email.trim().toLowerCase(),
            businessName: cleanBusiness,
            createdAt: new Date().toISOString(),
          };
        }
      } else {
        userData = {
          id: "mch_" + Math.random().toString(36).substring(2, 11),
          email: email.trim().toLowerCase(),
          businessName: cleanBusiness,
          createdAt: new Date().toISOString(),
        };
      }

      saveUserSession(userData);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Sign-in failed";
      return { success: false, error: msg };
    }
  };

  const signInWithWallet = async (
    walletAddress: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!walletAddress || walletAddress.length < 10) {
        return { success: false, error: "Invalid wallet address." };
      }

      const shortAddr = `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
      const userData: MerchantUser = {
        id: "mch_" + Math.random().toString(36).substring(2, 11),
        email: `merchant_${shortAddr.toLowerCase()}@orbit.network`,
        businessName: `Merchant (${shortAddr})`,
        walletAddress: walletAddress.trim(),
        createdAt: new Date().toISOString(),
      };

      saveUserSession(userData);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Wallet sign-in failed";
      return { success: false, error: msg };
    }
  };

  const updateWallet = (walletAddress: string) => {
    if (!user) return;
    const trimmed = walletAddress.trim();
    const updated = {
      ...user,
      walletAddress: trimmed,
      linkedVaults: {
        ...user.linkedVaults,
        stellar: trimmed,
      },
    };
    saveUserSession(updated);
  };

  const updateVault = (chain: "stellar", address: string) => {
    if (!user) return;
    const trimmed = address.trim();
    const updated = {
      ...user,
      walletAddress: user.walletAddress || trimmed,
      linkedVaults: {
        ...user.linkedVaults,
        [chain]: trimmed,
      },
    };
    saveUserSession(updated);
  };

  const updateContractId = (contractId: string) => {
    if (!user) return;
    const trimmed = contractId.trim();
    const updated = {
      ...user,
      customContractId: trimmed,
      linkedVaults: {
        ...user.linkedVaults,
        contract_id: trimmed,
      },
    };
    saveUserSession(updated);
  };

  const updateBusinessName = (businessName: string) => {
    if (!user) return;
    const trimmed = businessName.trim();
    if (!trimmed) return;
    const updated = {
      ...user,
      businessName: trimmed,
    };
    saveUserSession(updated);
  };

  const signOut = () => {
    setUser(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.error("Failed to remove merchant session:", err);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        signUp,
        signIn,
        signInWithWallet,
        updateWallet,
        updateVault,
        updateContractId,
        updateBusinessName,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
