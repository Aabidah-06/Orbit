import { test, expect, Page } from "@playwright/test";
import { Keypair, Networks } from "@stellar/stellar-sdk";

const merchantWallet = Keypair.random().publicKey();
const subscriberWallet = Keypair.random().publicKey();
const subscriberId = "4a7f2e18-6c51-41b9-9cf3-90d1bf379b32";
const planId = "e0b8e99b-5136-4d1d-9351-91a5db4fb056";
const record = { id: subscriberId, plan_id: planId, customer_wallet_address: subscriberWallet,
  status: "past_due", created_at: "2026-10-01T00:00:00Z", next_billing_date: "2026-10-01T00:00:00Z",
  plans: { name: "Pro Plan", usdc_amount: 290000000, interval_seconds: 2592000 },
  last_failure: { code: "insufficient_balance", message: "Subscriber has insufficient balance for this pull." } };

async function signedIn(page: Page) {
  await page.addInitScript(({ wallet }) => {
    localStorage.setItem("orbit_merchant_session", JSON.stringify({ id: "e2e-merchant", businessName: "Merchant Operations",
      email: "merchant@example.com", walletAddress: wallet, createdAt: "2026-10-01T00:00:00Z" }));
  }, { wallet: merchantWallet });
}

async function liveSubscribers(page: Page) {
  await signedIn(page);
  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path === "/subscribers" ? { subscribers: [record] } :
      path.endsWith("/diagnostics") ? { failure: record.last_failure } :
      path.endsWith("/recovery-link") ? { recovery_url: `http://127.0.0.1:3105/pay/${planId}?recovery=true` } :
      path.endsWith("/waive") ? { subscription: { ...record, status: "active", next_billing_date: "2027-01-01T00:00:00Z" } } :
      path === "/trigger-pull" ? { transaction_xdr: "prepared-envelope", merchant_address: merchantWallet, network_passphrase: Networks.TESTNET } :
      { txHash: "confirmed-hash" };
    await route.fulfill({ json: body });
  });
  await page.goto("/dashboard?demo=false");
  await page.getByRole("button", { name: /^Subscribers/ }).click();
  await page.getByLabel("Merchant API key").fill("orb_test_browser-test");
  await page.getByRole("button", { name: "Connect API", exact: true }).click();
  await page.getByRole("button", { name: "Resolve payment" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("reviews 600 payroll recipients, merges duplicate wallets, searches, sorts and restores the address book", async ({ page }) => {
  await signedIn(page); await page.goto("/dashboard");
  await page.getByRole("button", { name: /^Batch Payroll/ }).click();
  const wallets = Array.from({ length: 600 }, (_, index) => { const seed = Buffer.alloc(32); seed.writeUInt32LE(index + 1); return Keypair.fromRawEd25519Seed(seed).publicKey(); });
  const csv = ["Name,Role,StellarWallet,AmountUSDC", ...wallets.map((wallet, i) => `Contractor ${String(i).padStart(3, "0")},Engineer,${wallet},${i + 1}`), `Duplicate,Engineer,${wallets[0]},0.2`].join("\n");
  await page.locator('input[type="file"]').setInputFiles({ name: "payroll.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const duplicateAlert = page.getByRole("alert").filter({ hasText: "duplicate recipient wallet" });
  await expect(duplicateAlert).toContainText("1 duplicate recipient wallet");
  await expect(page.getByRole("button", { name: /Run Batch/ })).toBeDisabled();
  await page.screenshot({ path: "screenshots/issues-104-payroll-review.png", fullPage: false });
  await page.getByRole("button", { name: "Merge duplicate amounts" }).click();
  await expect(duplicateAlert).toHaveCount(0);
  await page.getByLabel("Search payouts").fill("Contractor 000");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("1.20 USDC");
  await page.getByRole("button", { name: "Save contractor", exact: true }).click();
  await page.getByRole("button", { name: "Saved contractors (1)" }).click();
  await expect(page.getByRole("button", { name: "Quick add" })).toBeVisible();
  await page.reload(); await page.getByRole("button", { name: /^Batch Payroll/ }).click();
  await page.getByRole("button", { name: "Saved contractors (1)" }).click();
  await page.getByRole("button", { name: "Quick add" }).click();
  await page.getByLabel("Search payouts").fill(wallets[0]);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Search payouts").fill("");
  await page.getByRole("button", { name: /^Amount/ }).click();
  await expect(page.locator("tbody tr").first()).toContainText("Contractor 000");
});

test("shows diagnostics, copies a real recovery URL and persists an explicit interval waiver", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await liveSubscribers(page);
  await expect(page.getByRole("dialog")).toContainText("Insufficient balance");
  await page.screenshot({ path: "screenshots/issues-105-past-due-resolution.png" });
  await page.getByRole("button", { name: "Copy Recovery Link" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText("Recovery link copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`/pay/${planId}`);
  const waiver = page.waitForRequest((request) => request.url().endsWith("/waive"));
  await page.getByRole("button", { name: "Waive Interval", exact: true }).click();
  await page.getByRole("button", { name: "Confirm waiver" }).click();
  const submitted = await waiver;
  expect(submitted.headers()["idempotency-key"]).toBeTruthy();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Interval waived");
  await page.getByRole("button", { name: "Close resolution" }).click();
  await expect(page.getByRole("button", { name: "Resolve payment" })).toHaveCount(0);
});

test("retry signs the prepared envelope with Freighter and submits the signed envelope", async ({ page }) => {
  await page.addInitScript(({ address }) => {
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
      window.postMessage({ source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: message.messageId,
        isConnected: true, isAllowed: true, publicKey: address, signerAddress: address, signedTransaction: "signed-envelope" }, window.location.origin);
    });
  }, { address: merchantWallet });
  await liveSubscribers(page);
  const submission = page.waitForRequest((request) => request.url().endsWith("/submit-pull"));
  await page.getByRole("button", { name: "Retry Pull Now" }).click();
  expect((await submission).postDataJSON()).toEqual({ subscription_id: subscriberId, signed_xdr: "signed-envelope" });
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Payment confirmed on Stellar");
});

test("a pending confirmation never marks the subscription paid or enables another charge", async ({ page }) => {
  await page.addInitScript(({ address }) => {
    window.addEventListener("message", (event) => {
      if (event.data?.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
      window.postMessage({ source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: event.data.messageId,
        isConnected: true, isAllowed: true, publicKey: address, signerAddress: address, signedTransaction: "signed-envelope" }, window.location.origin);
    });
  }, { address: merchantWallet });
  await liveSubscribers(page);
  await page.route("http://localhost:3001/submit-pull", (route) => route.fulfill({ status: 202, json: { txHash: "pending-hash" } }));
  await page.getByRole("button", { name: "Retry Pull Now" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("confirmation is pending");
  await expect(page.getByRole("button", { name: "Retry Pull Now" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Waive Interval", exact: true })).toBeDisabled();
  await page.route(`http://localhost:3001/subscriptions/${subscriberId}/check-pull`, (route) => route.fulfill({
    json: { status: "FAILED", txHash: "pending-hash", subscription: { ...record, last_failure: { code: "unknown", message: "Transaction failed on-chain" } } },
  }));
  await page.getByRole("button", { name: "Check transaction status" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("previous transaction failed");
  await expect(page.getByRole("button", { name: "Retry Pull Now" })).toBeEnabled();
});
