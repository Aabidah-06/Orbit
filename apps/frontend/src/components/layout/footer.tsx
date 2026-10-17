"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Brand } from "./brand";
import { DOCS_URL } from "@/lib/links";
import { LocaleSwitcher } from "./locale-switcher";

export function Footer() {
  const t = useTranslations("Footer");
  const pathname = usePathname();

  if (pathname?.startsWith("/dashboard") || pathname?.startsWith("/pay") || pathname?.startsWith("/docs")) {
    return null;
  }

  return (
    <footer className="site-footer">
      <div className="orbit-container">
        <div className="footer-top">
          <div>
            <Brand />
            <p className="footer-brand-copy">{t("tagline")}</p>
          </div>
          <div className="footer-columns">
            <div className="footer-column">
              <h3>{t("product")}</h3>
              <Link href="/#features">{t("allowanceVault")}</Link>
              <Link href="/#features">{t("batchPayroll")}</Link>
              <Link href="/#features">{t("recurringPulls")}</Link>
              <Link href="/pricing">{t("pricingPlans")}</Link>
            </div>
            <div className="footer-column">
              <h3>{t("resources")}</h3>
              <Link href={DOCS_URL}>{t("documentation")}</Link>
              <Link href={`${DOCS_URL}/api-reference/overview`}>{t("apiReference")}</Link>
              <Link href="/get-started">{t("developerPlayground")}</Link>
              <Link href={`${DOCS_URL}/quickstart`}>{t("sdkQuickstart")}</Link>
            </div>
            <div className="footer-column">
              <h3>{t("company")}</h3>
              <Link href="/docs">{t("aboutOrbit")}</Link>
              <Link href="/docs">{t("brandGuidelines")}</Link>
              <Link href="/docs">{t("releaseNotes")}</Link>
              <Link href="/docs">{t("networkStatus")}</Link>
            </div>
            <div className="footer-column">
              <h3>{t("legal")}</h3>
              <Link href="/docs">{t("privacyPolicy")}</Link>
              <Link href="/docs">{t("termsOfService")}</Link>
              <Link href="/docs">{t("securityDisclosures")}</Link>
            </div>
          </div>
        </div>

        <div className="footer-bottom">
          <span>{t("copyright")}</span>
          <LocaleSwitcher />
          <span className="mono">{t("protocol")}</span>
        </div>
      </div>
    </footer>
  );
}
