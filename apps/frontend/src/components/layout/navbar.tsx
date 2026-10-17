"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, ArrowUpRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslations } from "next-intl";

import { Brand } from "./brand";
import { useAuth } from "@/lib/auth-context";
import { DOCS_URL } from "@/lib/links";
import { LocaleSwitcher } from "./locale-switcher";

export function Navbar() {
  const t = useTranslations("Nav");
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();
  const { user, signOut } = useAuth();

  const closeMenu = () => setIsOpen(false);

  if (pathname?.startsWith("/dashboard") || pathname?.startsWith("/pay") || pathname?.startsWith("/docs")) {
    return null;
  }

  return (
    <header className="site-header">
      <div className="orbit-container nav-inner">
        <Brand />
        <nav className="nav-links" aria-label={t("primaryNavigation")}>
          <Link
            className="nav-link"
            href="/#features"
            data-testid="link-features"
          >
            {t("features")}
          </Link>
          <Link
            className="nav-link"
            href="/#how-it-works"
            data-testid="link-how-it-works"
          >
            {t("flow")}
          </Link>
          <Link
            className={`nav-link ${pathname === "/pricing" ? "text-black font-semibold" : ""}`}
            href="/pricing"
            data-testid="link-pricing"
          >
            {t("pricing")}
          </Link>
          <Link
            className="nav-link"
            href={DOCS_URL}
            data-testid="link-developers"
          >
            {t("developers")}
          </Link>
        </nav>

        <div className="nav-actions">
          <LocaleSwitcher />
          {user ? (
            <div className="flex items-center gap-3">
              <Link
                className="button button-primary"
                href="/dashboard"
                data-testid="link-dashboard"
              >
                {t("dashboard")}
              </Link>
              <button
                type="button"
                onClick={() => signOut()}
                className="text-xs text-neutral-500 hover:text-black font-medium transition-colors"
                title={t("signOut")}
              >
                {t("signOut")}
              </button>
            </div>
          ) : (
            <>
              <Link
                className="nav-link"
                href="/signin"
                data-testid="link-signin"
              >
                {t("signIn")}
              </Link>
              <Link
                className="button button-primary button-arrow"
                href="/get-started"
                data-testid="link-get-started"
              >
                {t("getStarted")}
              </Link>
            </>
          )}
        </div>

        <button
          className="mobile-menu-button"
          type="button"
          aria-label={isOpen ? t("closeNavigation") : t("openNavigation")}
          aria-expanded={isOpen}
          onClick={() => setIsOpen((prev) => !prev)}
          data-testid="button-mobile-menu"
        >
          {isOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {/* Mobile Drawer with Framer Motion */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden border-t border-[rgba(0,0,0,0.08)] bg-[#FAFAFB]"
          >
            <div className="orbit-container mobile-nav">
              <Link
                className="nav-link text-base py-1"
                href="/#features"
                onClick={closeMenu}
                data-testid="mobile-link-features"
              >
                {t("features")}
              </Link>
              <Link
                className="nav-link text-base py-1"
                href="/#how-it-works"
                onClick={closeMenu}
                data-testid="mobile-link-flow"
              >
                {t("howItWorks")}
              </Link>
              <Link
                className="nav-link text-base py-1"
                href="/pricing"
                onClick={closeMenu}
                data-testid="mobile-link-pricing"
              >
                {t("pricing")}
              </Link>
              <Link
                className="nav-link text-base py-1"
                href={DOCS_URL}
                onClick={closeMenu}
                data-testid="mobile-link-developers"
              >
                {t("developers")}
              </Link>

              <div className="mobile-nav-actions pt-2 border-t border-[rgba(0,0,0,0.08)]">
                <LocaleSwitcher className="justify-center py-1" />
                {user ? (
                  <div className="flex flex-col gap-2">
                    <Link
                      className="button button-primary w-full justify-center"
                      href="/dashboard"
                      onClick={closeMenu}
                      data-testid="mobile-link-dashboard"
                    >
                      {t("dashboard")}
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        signOut();
                        closeMenu();
                      }}
                      className="text-xs text-neutral-500 hover:text-black text-center py-2 font-medium"
                    >
                      {t("signOut")}
                    </button>
                  </div>
                ) : (
                  <>
                    <Link
                      className="nav-link text-center py-2"
                      href="/signin"
                      onClick={closeMenu}
                      data-testid="mobile-link-signin"
                    >
                      {t("signIn")}
                    </Link>
                    <Link
                      className="button button-primary button-arrow w-full justify-center"
                      href="/get-started"
                      onClick={closeMenu}
                      data-testid="mobile-button-get-started"
                    >
                      {t("getStarted")}
                    </Link>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
