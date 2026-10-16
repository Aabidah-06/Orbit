import type { Metadata } from "next";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon-badge.png?v=3" type="image/png" />
        <link rel="shortcut icon" href="/favicon-badge.png?v=3" type="image/png" />
        <link rel="apple-touch-icon" href="/favicon-badge.png?v=3" />
      </head>
      <body className="min-h-screen bg-[#FAFAFB] text-[#09090B] selection:bg-black selection:text-white antialiased">
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
      </body>
    </html>
  );
}
