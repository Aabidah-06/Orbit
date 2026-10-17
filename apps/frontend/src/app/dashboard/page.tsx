"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth-context";
import { TeamProvider } from "@/lib/team-context";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default function DashboardPage() {
  const t = useTranslations("Dashboard");
  const router = useRouter();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !user) {
      router.push("/signin");
    }
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="min-h-screen bg-[#fafafb] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-black border-t-transparent rounded-full animate-spin"></div>
          <div className="text-xs font-mono text-neutral-500">
            {t("checkingSession")}
          </div>
        </div>
      </main>
    );
  }

  return (
    <TeamProvider>
      <DashboardShell />
    </TeamProvider>
  );
}
