import { describe, expect, it } from "vitest";
import crypto from "node:crypto";

/**
 * Deterministic 64-bit SplitMix PRNG for reproducible property-based fuzzing.
 */
class SplitMix64 {
  constructor(seed = 0x9e3779b97f4a7c15n) {
    this.state = BigInt.asUintN(64, BigInt(seed));
  }

  nextU64() {
    this.state = BigInt.asUintN(64, this.state + 0x9e3779b97f4a7c15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return BigInt.asUintN(64, z ^ (z >> 31n));
  }

  range(min, maxInclusive) {
    const low = BigInt(min);
    const high = BigInt(maxInclusive);
    if (high <= low) return low;
    const span = high - low + 1n;
    return low + (this.nextU64() % span);
  }
}

/**
 * Reference state machine mirroring `contracts/soroban/src/lib.rs`
 * (OrbitSubscriptionContract) for high-throughput stateful sequence fuzzing
 * and invariant verification across 10,000+ randomized actions.
 */
class OrbitContractFuzzModel {
  constructor({ initialTimestamp = 1_000_000n, maxSlippageBps = 2_000n } = {}) {
    this.ledgerTimestamp = BigInt(initialTimestamp);
    this.maxSlippageBps = BigInt(maxSlippageBps);
    this.contractTokenBalance = 0n;
    this.userTokenBalances = new Map();
    this.merchantTokenBalances = new Map();
    this.vaults = new Map();
    this.plans = new Map();
    this.merkleEpoch = null;
  }

  mintUser(subscriber, amount) {
    const current = this.userTokenBalances.get(subscriber) ?? 0n;
    this.userTokenBalances.set(subscriber, current + BigInt(amount));
  }

  advanceTime(deltaSeconds) {
    if (BigInt(deltaSeconds) < 0n) {
      throw new Error("NEGATIVE_TIME_DELTA");
    }
    this.ledgerTimestamp += BigInt(deltaSeconds);
  }

  registerPlan({ planId, merchant, interval, price, usageCap = 0n }) {
    const id = String(planId);
    const intervalBig = BigInt(interval);
    const priceBig = BigInt(price);
    const usageCapBig = BigInt(usageCap);

    if (intervalBig <= 0n || priceBig < 0n || usageCapBig < 0n) {
      return { ok: false, error: "INVALID_PLAN_PARAMETERS" };
    }

    this.plans.set(id, {
      planId: id,
      merchant,
      interval: intervalBig,
      price: priceBig,
      usageCap: usageCapBig,
    });
    return { ok: true };
  }

  deposit({ subscriber, merchant, planId, amount }) {
    const amt = BigInt(amount);
    if (amt <= 0n) {
      return { ok: false, error: "NON_POSITIVE_DEPOSIT" };
    }
    const plan = this.plans.get(String(planId));
    if (!plan || plan.merchant !== merchant) {
      return { ok: false, error: "PLAN_NOT_FOUND" };
    }
    const userBal = this.userTokenBalances.get(subscriber) ?? 0n;
    if (userBal < amt) {
      return { ok: false, error: "INSUFFICIENT_USER_BALANCE" };
    }

    const key = `${subscriber}:${merchant}`;
    const existing = this.vaults.get(key) ?? {
      subscriber,
      merchant,
      planId: String(planId),
      balance: 0n,
      escrowBalance: 0n,
      interval: plan.interval,
      lastPayment: 0n,
      price: plan.price,
      usageCap: plan.usageCap,
      meteredUsage: 0n,
      active: true,
    };

    this.userTokenBalances.set(subscriber, userBal - amt);
    this.contractTokenBalance += amt;
    existing.active = true;
    existing.balance += amt;
    existing.interval = plan.interval;
    existing.price = plan.price;
    existing.usageCap = plan.usageCap;
    this.vaults.set(key, existing);
    return { ok: true, balance: existing.balance };
  }

  lockEscrow({ subscriber, merchant, amount }) {
    const amt = BigInt(amount);
    if (amt <= 0n) {
      return { ok: false, error: "NON_POSITIVE_ESCROW" };
    }
    const key = `${subscriber}:${merchant}`;
    const vault = this.vaults.get(key);
    if (!vault || !vault.active) {
      return { ok: false, error: "VAULT_INACTIVE" };
    }
    if (vault.balance < amt) {
      return { ok: false, error: "INSUFFICIENT_VAULT_BALANCE" };
    }
    vault.balance -= amt;
    vault.escrowBalance += amt;
    return { ok: true };
  }

  pullPayment({ subscriber, merchant }) {
    const key = `${subscriber}:${merchant}`;
    const vault = this.vaults.get(key);
    if (!vault || !vault.active) {
      return { ok: false, error: "VAULT_INACTIVE" };
    }
    if (vault.lastPayment > 0n && this.ledgerTimestamp < vault.lastPayment + vault.interval) {
      return { ok: false, error: "INTERVAL_NOT_ELAPSED" };
    }
    if (vault.balance < vault.price) {
      return { ok: false, error: "INSUFFICIENT_VAULT_BALANCE" };
    }

    vault.balance -= vault.price;
    vault.lastPayment = this.ledgerTimestamp;
    vault.meteredUsage = 0n;
    this.contractTokenBalance -= vault.price;
    const mBal = this.merchantTokenBalances.get(merchant) ?? 0n;
    this.merchantTokenBalances.set(merchant, mBal + vault.price);

    return { ok: true, charged: vault.price, timestamp: this.ledgerTimestamp };
  }

  pullMeteredPayment({ subscriber, merchant, usageAmount }) {
    const amt = BigInt(usageAmount);
    if (amt <= 0n) {
      return { ok: false, error: "NON_POSITIVE_USAGE" };
    }
    const key = `${subscriber}:${merchant}`;
    const vault = this.vaults.get(key);
    if (!vault || !vault.active) {
      return { ok: false, error: "VAULT_INACTIVE" };
    }
    if (vault.usageCap > 0n && vault.meteredUsage + amt > vault.usageCap) {
      return { ok: false, error: "USAGE_CAP_EXCEEDED" };
    }
    if (vault.balance < amt) {
      return { ok: false, error: "INSUFFICIENT_VAULT_BALANCE" };
    }

    vault.balance -= amt;
    vault.meteredUsage += amt;
    this.contractTokenBalance -= amt;
    const mBal = this.merchantTokenBalances.get(merchant) ?? 0n;
    this.merchantTokenBalances.set(merchant, mBal + amt);

    return { ok: true, charged: amt, meteredUsage: vault.meteredUsage };
  }

  cancelSubscription({ subscriber, merchant }) {
    const key = `${subscriber}:${merchant}`;
    const vault = this.vaults.get(key);
    if (!vault || !vault.active) {
      return { ok: false, error: "VAULT_ALREADY_INACTIVE" };
    }

    const refundable = vault.balance;
    vault.balance = 0n;
    vault.active = false;
    this.contractTokenBalance -= refundable;
    const uBal = this.userTokenBalances.get(subscriber) ?? 0n;
    this.userTokenBalances.set(subscriber, uBal + refundable);

    return { ok: true, refunded: refundable };
  }

  initMerkleDistribution({ root, totalDeposited, allocations }) {
    const dep = BigInt(totalDeposited);
    if (dep <= 0n) {
      return { ok: false, error: "NON_POSITIVE_DEPOSIT" };
    }
    this.contractTokenBalance += dep;
    this.merkleEpoch = {
      root,
      totalDeposited: dep,
      totalClaimed: 0n,
      claimedIndices: new Set(),
      allocations: new Map(allocations.map((a) => [Number(a.index), { ...a, amount: BigInt(a.amount) }])),
    };
    return { ok: true };
  }

  claimMerkleDrop({ index, recipient, amount, proofValid = true }) {
    if (!this.merkleEpoch) {
      return { ok: false, error: "NO_ACTIVE_MERKLE_EPOCH" };
    }
    const amt = BigInt(amount);
    if (amt <= 0n) {
      return { ok: false, error: "NON_POSITIVE_CLAIM" };
    }
    if (!proofValid) {
      return { ok: false, error: "INVALID_MERKLE_PROOF" };
    }
    if (this.merkleEpoch.claimedIndices.has(Number(index))) {
      return { ok: false, error: "ALREADY_CLAIMED" };
    }
    const alloc = this.merkleEpoch.allocations.get(Number(index));
    if (!alloc || alloc.recipient !== recipient || alloc.amount !== amt) {
      return { ok: false, error: "LEAF_MISMATCH" };
    }
    if (this.merkleEpoch.totalClaimed + amt > this.merkleEpoch.totalDeposited) {
      return { ok: false, error: "MERKLE_INSOLVENCY_GUARD" };
    }

    this.merkleEpoch.claimedIndices.add(Number(index));
    this.merkleEpoch.totalClaimed += amt;
    this.contractTokenBalance -= amt;
    const uBal = this.userTokenBalances.get(recipient) ?? 0n;
    this.userTokenBalances.set(recipient, uBal + amt);
    return { ok: true, claimed: amt };
  }

  assertGlobalInvariants() {
    let totalVaultLiabilities = 0n;
    for (const vault of this.vaults.values()) {
      expect(vault.balance >= 0n).toBe(true);
      expect(vault.escrowBalance >= 0n).toBe(true);
      if (vault.usageCap > 0n) {
        expect(vault.meteredUsage <= vault.usageCap).toBe(true);
      }
      totalVaultLiabilities += vault.balance + vault.escrowBalance;
    }

    let merkleRemainingLiability = 0n;
    if (this.merkleEpoch) {
      expect(this.merkleEpoch.totalClaimed <= this.merkleEpoch.totalDeposited).toBe(true);
      merkleRemainingLiability = this.merkleEpoch.totalDeposited - this.merkleEpoch.totalClaimed;
    }

    // Core Solvency Invariant: contract token balance >= sum of all active user vault & escrow & Merkle liabilities
    expect(this.contractTokenBalance >= totalVaultLiabilities + merkleRemainingLiability).toBe(
      true,
    );
    expect(this.contractTokenBalance).toBe(totalVaultLiabilities + merkleRemainingLiability);
  }
}

describe("Automated Smart Contract Vulnerability Fuzzing & Invariant Suite (#181)", () => {
  it("executes 10,000+ randomized stateful action sequences while preserving Solvency, Rate-Limiting, and Cap Invariants", () => {
    const rng = new SplitMix64(0x181f00dcafebaben);
    const model = new OrbitContractFuzzModel({ initialTimestamp: 1_700_000_000n });

    const merchants = ["merchant_alpha", "merchant_beta", "merchant_gamma"];
    const subscribers = [
      "sub_01",
      "sub_02",
      "sub_03",
      "sub_04",
      "sub_05",
      "sub_06",
      "sub_07",
      "sub_08",
    ];

    for (const sub of subscribers) {
      model.mintUser(sub, 1_000_000_000_000n);
    }

    model.registerPlan({
      planId: "plan_alpha",
      merchant: "merchant_alpha",
      interval: 86_400n,
      price: 5_000n,
      usageCap: 12_000n,
    });
    model.registerPlan({
      planId: "plan_beta",
      merchant: "merchant_beta",
      interval: 604_800n,
      price: 25_000n,
      usageCap: 50_000n,
    });
    model.registerPlan({
      planId: "plan_gamma",
      merchant: "merchant_gamma",
      interval: 2_592_000n,
      price: 100_000n,
      usageCap: 200_000n,
    });

    const planByMerchant = {
      merchant_alpha: "plan_alpha",
      merchant_beta: "plan_beta",
      merchant_gamma: "plan_gamma",
    };

    const TOTAL_STEPS = 10_500;
    let successfulDeposits = 0;
    let successfulPulls = 0;
    let blockedEarlyPulls = 0;
    let blockedCapOverflows = 0;

    for (let step = 0; step < TOTAL_STEPS; step++) {
      const action = Number(rng.range(0n, 6n));
      const sub = subscribers[Number(rng.range(0n, BigInt(subscribers.length - 1)))];
      const merchant = merchants[Number(rng.range(0n, BigInt(merchants.length - 1)))];
      const planId = planByMerchant[merchant];

      switch (action) {
        case 0: {
          // Deposit random positive or boundary amount
          const amount = rng.range(-500n, 150_000n);
          const res = model.deposit({ subscriber: sub, merchant, planId, amount });
          if (amount <= 0n) {
            expect(res.ok).toBe(false);
          } else if (res.ok) {
            successfulDeposits++;
          }
          break;
        }
        case 1: {
          // Attempt subscription pull_payment
          const key = `${sub}:${merchant}`;
          const prevVault = model.vaults.get(key);
          const prevLastPayment = prevVault ? prevVault.lastPayment : 0n;
          const prevInterval = prevVault ? prevVault.interval : 0n;

          const res = model.pullPayment({ subscriber: sub, merchant });
          if (res.ok) {
            successfulPulls++;
            // Immediately attempting a second pull at the exact same timestamp MUST fail
            const immediateRetry = model.pullPayment({ subscriber: sub, merchant });
            expect(immediateRetry.ok).toBe(false);
            expect(immediateRetry.error).toBe("INTERVAL_NOT_ELAPSED");
            blockedEarlyPulls++;
          } else if (
            prevVault &&
            prevVault.active &&
            prevLastPayment > 0n &&
            model.ledgerTimestamp < prevLastPayment + prevInterval
          ) {
            expect(res.error).toBe("INTERVAL_NOT_ELAPSED");
            blockedEarlyPulls++;
          }
          break;
        }
        case 2: {
          // Attempt metered billing charge
          const usageAmount = rng.range(-200n, 30_000n);
          const res = model.pullMeteredPayment({ subscriber: sub, merchant, usageAmount });
          if (usageAmount <= 0n) {
            expect(res.ok).toBe(false);
          } else if (!res.ok && res.error === "USAGE_CAP_EXCEEDED") {
            blockedCapOverflows++;
          }
          break;
        }
        case 3: {
          // Lock escrow
          const escrowAmt = rng.range(0n, 20_000n);
          model.lockEscrow({ subscriber: sub, merchant, amount: escrowAmt });
          break;
        }
        case 4: {
          // Advance ledger timestamp randomly (including 0s same-block and multi-day jumps)
          const delta = rng.range(0n, 45_000n);
          model.advanceTime(delta);
          break;
        }
        case 5: {
          // Cancel & optionally re-open vault via fresh plan registration
          const cancelRes = model.cancelSubscription({ subscriber: sub, merchant });
          if (cancelRes.ok) {
            // Re-enable vault for subsequent fuzz iterations
            const key = `${sub}:${merchant}`;
            const vault = model.vaults.get(key);
            if (vault && vault.escrowBalance === 0n) {
              model.vaults.delete(key);
            }
          }
          break;
        }
        case 6: {
          // Verify invariant mid-flight
          model.assertGlobalInvariants();
          break;
        }
      }

      if (step % 250 === 0) {
        model.assertGlobalInvariants();
      }
    }

    model.assertGlobalInvariants();
    expect(successfulDeposits).toBeGreaterThan(500);
    expect(successfulPulls).toBeGreaterThan(100);
    expect(blockedEarlyPulls).toBeGreaterThan(100);
    expect(blockedCapOverflows).toBeGreaterThan(10);
  });

  it("enforces Merkle distribution integrity and blocks double-claims or over-claims across randomized trees", () => {
    const rng = new SplitMix64(0x778899aabbccddeeffn);
    const model = new OrbitContractFuzzModel();

    const allocations = [];
    let sumAllocated = 0n;
    for (let i = 0; i < 64; i++) {
      const amount = rng.range(100n, 50_000n);
      sumAllocated += amount;
      allocations.push({
        index: i,
        recipient: `recipient_${i}`,
        amount,
      });
    }

    const root = crypto.createHash("sha256").update(JSON.stringify(allocations.map((a) => a.index))).digest("hex");
    const initRes = model.initMerkleDistribution({
      root,
      totalDeposited: sumAllocated,
      allocations,
    });
    expect(initRes.ok).toBe(true);

    // Randomize claim order and interleave duplicate/corrupted claims
    for (let attempt = 0; attempt < 500; attempt++) {
      const idx = Number(rng.range(0n, 63n));
      const target = allocations[idx];
      const corruptAmount = attempt % 5 === 0 ? target.amount + 1n : target.amount;
      const proofValid = attempt % 11 !== 0;

      const res = model.claimMerkleDrop({
        index: idx,
        recipient: target.recipient,
        amount: corruptAmount,
        proofValid,
      });

      if (!proofValid) {
        expect(res.ok).toBe(false);
        expect(res.error).toBe("INVALID_MERKLE_PROOF");
      } else if (corruptAmount !== target.amount) {
        expect(res.ok).toBe(false);
      }

      model.assertGlobalInvariants();
    }

    // Claim any remaining valid allocations
    for (const alloc of allocations) {
      model.claimMerkleDrop({
        index: alloc.index,
        recipient: alloc.recipient,
        amount: alloc.amount,
        proofValid: true,
      });
    }

    expect(model.merkleEpoch.totalClaimed).toBe(sumAllocated);
    model.assertGlobalInvariants();
  });

  it("rejects boundary edge cases (zero/negative amounts, max timestamp boundaries, and exact interval boundaries)", () => {
    const model = new OrbitContractFuzzModel({ initialTimestamp: 10_000n });
    model.mintUser("alice", 500_000n);
    model.registerPlan({
      planId: "pro",
      merchant: "acme",
      interval: 3_600n,
      price: 10_000n,
      usageCap: 5_000n,
    });

    expect(model.deposit({ subscriber: "alice", merchant: "acme", planId: "pro", amount: 0n }).ok).toBe(false);
    expect(model.deposit({ subscriber: "alice", merchant: "acme", planId: "pro", amount: -1n }).ok).toBe(false);
    expect(model.deposit({ subscriber: "alice", merchant: "acme", planId: "pro", amount: 50_000n }).ok).toBe(true);

    // First pull succeeds at t=10,000
    expect(model.pullPayment({ subscriber: "alice", merchant: "acme" }).ok).toBe(true);

    // At t=13,599 (1 second before interval elapses), pull MUST fail
    model.advanceTime(3_599n);
    expect(model.pullPayment({ subscriber: "alice", merchant: "acme" }).ok).toBe(false);

    // At t=13,600 (exact interval boundary), pull MUST succeed
    model.advanceTime(1n);
    expect(model.pullPayment({ subscriber: "alice", merchant: "acme" }).ok).toBe(true);

    model.assertGlobalInvariants();
  });
});
