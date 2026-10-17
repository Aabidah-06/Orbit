import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";

export const metadata: Metadata = {
  title: "Orbit — Non-Custodial Pull Payments for Businesses",
  description:
    "Automate on-chain allowances, route stablecoin payouts & payrolls globally, and capture recurring revenue with non-custodial smart contracts.",
  keywords: [
    "Orbit",
    "USDC",
    "Smart Contracts",
    "Web3 Payments",
    "Pull Payments",
    "Recurring Subscriptions",
    "Crypto Payroll",
  ],
  icons: {
    icon: [
      { url: "/favicon-badge.png?v=3", type: "image/png" },
      { url: "/favicon-32.png?v=3", sizes: "32x32", type: "image/png" },
      { url: "/favicon.svg?v=3", type: "image/svg+xml" },
    ],
    shortcut: "/favicon-badge.png?v=3",
    apple: "/favicon-badge.png?v=3",
  },
};

import { AuthProvider } from "@/lib/auth-context";
import { NotificationProvider } from "@/lib/notification-context";
import { ToastNotificationCenter } from "@/components/ui/toast-notification-center";
import { I18nProvider } from "@/i18n/provider";
import { LOCALE_COOKIE, defaultLocale, isLocale } from "@/i18n/config";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : defaultLocale;

  return (
    <html lang={locale}>
      <head>
        <link rel="icon" href="/favicon-badge.png?v=3" type="image/png" />
        <link rel="shortcut icon" href="/favicon-badge.png?v=3" type="image/png" />
        <link rel="apple-touch-icon" href="/favicon-badge.png?v=3" />
      </head>
      <body className="min-h-screen bg-[#FAFAFB] text-[#09090B] selection:bg-black selection:text-white antialiased">
        <I18nProvider initialLocale={locale}>
          <AuthProvider>
            <NotificationProvider>
              <div className="flex flex-col min-h-screen">
                <Navbar />
                <div className="flex-1">{children}</div>
                <Footer />
              </div>
              <ToastNotificationCenter />
            </NotificationProvider>
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
