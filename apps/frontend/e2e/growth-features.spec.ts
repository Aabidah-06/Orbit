import { test, expect } from "@playwright/test";

test("growth features: multi-sig, gift passes, domains and payroll dry-run work end to end", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Failed to fetch|ERR_CONNECTION|localhost:3001|net::ERR/i.test(text)) return;
    errors.push(`console: ${text}`);
  });

  await page.addInitScript(() => {
    localStorage.setItem(
      "orbit_merchant_session",
      JSON.stringify({
        id: "smoke-merchant",
        businessName: "Smoke Co",
        email: "smoke@example.com",
        walletAddress: "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
        createdAt: "2026-10-01T00:00:00Z",
      })
    );
  });

  await page.goto("/dashboard");

  // #144 multi-sig coordination room
  await page.getByRole("button", { name: /^Multi-Sig Room/ }).click();
  await expect(page.getByText("Multi-Sig Coordination Room").first()).toBeVisible();
  await expect(page.getByText("Threshold", { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: "screenshots/issues-144-multisig-room.png", fullPage: false });

  // #146 gift passes wizard + claim management
  await page.getByRole("button", { name: /Gift Passes/ }).click();
  await expect(page.getByText("Gift Links & Pre-paid Passes").first()).toBeVisible();
  await page.getByRole("button", { name: "Review order" }).click();
  await page.getByRole("button", { name: /Pay .*USDC & generate/ }).click();
  await expect(page.getByText(/pre-paid pass/)).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole("button", { name: "Copy link" }).first()).toBeVisible();
  await page.screenshot({ path: "screenshots/issues-146-gift-passes.png", fullPage: false });

  // #145 custom domains + SSL mapping
  await page.getByRole("button", { name: /Custom Domains/ }).click();
  await expect(page.getByText("Custom Domains & SSL").first()).toBeVisible();
  await page.getByRole("button", { name: "Add Domain" }).click();
  await page.getByLabel("Custom domain or subdomain").fill("pay.smoke.store");
  await page.getByRole("button", { name: "Register domain" }).click();
  await expect(page.getByText("Pending DNS").first()).toBeVisible();
  await page.screenshot({ path: "screenshots/issues-145-custom-domains.png", fullPage: false });

  // #147 payroll dry-run simulator
  await page.getByRole("button", { name: /^Batch Payroll/ }).click();
  await page.getByRole("button", { name: /Simulate Payroll Run/ }).click();
  await expect(page.getByText("Payroll Dry-Run Simulation")).toBeVisible();
  await expect(page.getByText("Recipient verification")).toBeVisible();
  await page.screenshot({ path: "screenshots/issues-147-payroll-simulation.png", fullPage: false });

  expect(errors).toEqual([]);
});
