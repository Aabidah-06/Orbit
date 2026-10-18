# Orbit Implementation Roadmap - Issues #186, #185, #184, #183

This document provides comprehensive implementation guidance for four critical Orbit enhancement issues. Each section includes architecture, code examples, testing strategy, and acceptance criteria.

---

## Issue #186: Adaptive Network Gas Fee Bump and Transaction Acceleration Modal

### Problem
Checkout transactions with standard fees can stall during network congestion, causing customer anxiety and abandoned checkouts.

### Solution Architecture

**File**: `packages/checkout-widget/src/components/TransactionAccelerator.tsx`

```typescript
import { FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk';

interface TransactionState {
  status: 'pending' | 'stalled' | 'confirmed' | 'failed';
  hash: string;
  submittedAt: number;
  baseFee: number;
}

export class TransactionAccelerator {
  private readonly STALL_THRESHOLD_MS = 15000; // 15 seconds
  
  detectStall(txState: TransactionState): boolean {
    const elapsed = Date.now() - txState.submittedAt;
    return txState.status === 'pending' && elapsed > this.STALL_THRESHOLD_MS;
  }

  async createFeeBump(
    originalTx: string,  // XDR envelope
    currentBaseFee: number
  ): Promise<string> {
    const transaction = TransactionBuilder.fromXDR(originalTx, Networks.TESTNET);
    const bumpedBaseFee = currentBaseFee * 2;
    
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,  // Fee-paying account
      bumpedBaseFee.toString(),
      transaction,
      Networks.TESTNET
    );

    return feeBump.toXDR();
  }
}
```

**UI Component**: 
- Show "Network Congested" badge after 15s
- "Speed Up Transaction" button opens modal
- Display new fee estimate vs original
- Freighter signs fee bump
- Auto-resume polling with new hash

### Acceptance Criteria
- [ ] Stall detection triggers at 15s
- [ ] Valid FeeBumpTransaction construction
- [ ] Freighter signature integration
- [ ] Widget build passes

---

## Issue #185: Automated Smart Contract State Snapshot Backup

### Problem
Database loss requires days of ledger scanning to reconstruct state.

### Solution Architecture

**File**: `apps/backend/src/workers/contractStateExporter.ts`

```typescript
import { SorobanRpc } from '@stellar/stellar-sdk';

export class ContractStateExporter {
  async exportState(contractId: string): Promise<ContractSnapshot> {
    const entries = await this.getLedgerEntries(contractId);
    
    return {
      version: '1.0',
      contractId,
      exportedAt: new Date().toISOString(),
      checksum: this.computeChecksum(entries),
      vaults: this.parseVaults(entries),
      plans: this.parsePlans(entries),
      admins: this.parseAdmins(entries),
    };
  }

  async uploadToS3(snapshot: ContractSnapshot): Promise<void> {
    const encrypted = await this.encrypt(snapshot);
    await s3.putObject({
      Bucket: 'orbit-backups',
      Key: `snapshots/${snapshot.exportedAt}.json.enc`,
      Body: encrypted,
    });
  }

  computeChecksum(data: any): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }
}
```

**Recovery CLI**:
```bash
npm run db:restore-from-ledger --snapshot=2024-01-01.json
```

### Acceptance Criteria
- [ ] Daily automated snapshots
- [ ] SHA-256 checksums
- [ ] S3 encrypted storage
- [ ] CLI recovery tool
- [ ] Unit tests pass

---

## Issue #184: Dynamic Volume-Based Fee Tier Discounts

### Problem
Static protocol fees don't reward high-volume merchants.

### Solution Architecture

**File**: `contracts/soroban/src/lib.rs`

```rust
#[derive(Clone)]
pub struct TierConfig {
    threshold_volume: i128,  // Cumulative volume threshold
    fee_bps: u32,           // Basis points (100 = 1%)
}

// Storage: merchant_volume -> cumulative_settled
const MERCHANT_VOLUME: Map<Address, i128> = Map::new(&env);

// Tier configuration
const TIERS: [TierConfig; 3] = [
    TierConfig { threshold_volume: 0, fee_bps: 100 },        // 1.0%
    TierConfig { threshold_volume: 50_000, fee_bps: 50 },    // 0.5%
    TierConfig { threshold_volume: 250_000, fee_bps: 25 },   // 0.25%
];

pub fn pull_funds(env: &Env, user: Address, merchant: Address) -> i128 {
    // Get current cumulative volume
    let current_volume = MERCHANT_VOLUME.get(&merchant).unwrap_or(0);
    
    // Determine active tier
    let active_tier = TIERS.iter()
        .rev()
        .find(|t| current_volume >= t.threshold_volume)
        .unwrap_or(&TIERS[0]);
    
    // Calculate pull amount
    let pull_amount = calculate_due_amount(&vault);
    
    // Calculate protocol fee with tier discount
    let protocol_fee = (pull_amount * active_tier.fee_bps as i128) / 10_000;
    
    // Update merchant volume atomically
    MERCHANT_VOLUME.set(&merchant, current_volume + pull_amount);
    
    // Check if tier upgraded
    let new_volume = current_volume + pull_amount;
    let new_tier = TIERS.iter()
        .rev()
        .find(|t| new_volume >= t.threshold_volume)
        .unwrap_or(&TIERS[0]);
    
    if new_tier.fee_bps < active_tier.fee_bps {
        env.events().publish((symbol_short!("tier_up"), merchant.clone()), new_tier.fee_bps);
    }
    
    pull_amount - protocol_fee
}
```

### Acceptance Criteria
- [ ] Volume tracking per merchant
- [ ] Progressive fee calculation
- [ ] Atomic volume updates
- [ ] Tier upgrade events
- [ ] cargo test passes

---

## Issue #183: Automated Plan Migration and Bulk Subscriber Transfer

### Problem
No tooling for migrating subscribers between pricing tiers.

### Solution Architecture

**File**: `apps/frontend/src/components/PlanMigrationWizard.tsx`

```typescript
interface MigrationCampaign {
  id: string;
  sourcePlanId: string;
  targetPlanId: string;
  discount: {
    percentage: number;
    durationMonths: number;
  };
  sunsetDate: Date;
  status: 'draft' | 'active' | 'completed';
}

export class PlanMigrationWizard {
  async createCampaign(config: MigrationCampaign): Promise<string> {
    // Generate unique migration URLs for each subscriber
    const subscribers = await db.subscription.findMany({
      where: { planId: config.sourcePlanId, status: 'active' },
    });

    const migrationLinks = subscribers.map(sub => ({
      subscriberId: sub.id,
      token: generateSecureToken(),
      url: `${config.targetUrl}/migrate/${generateSecureToken()}`,
    }));

    // Store migration campaign
    await db.migrationCampaign.create({
      data: {
        ...config,
        links: migrationLinks,
      },
    });

    // Queue notification emails
    await notificationService.sendBulk({
      template: 'plan_migration',
      recipients: subscribers.map(s => s.email),
      data: { campaign: config, links: migrationLinks },
    });

    return campaign.id;
  }

  async getMigrationProgress(campaignId: string) {
    const campaign = await db.migrationCampaign.findUnique({
      where: { id: campaignId },
      include: { links: true },
    });

    const transitioned = campaign.links.filter(l => l.completedAt).length;
    const pending = campaign.links.length - transitioned;

    return {
      total: campaign.links.length,
      transitioned,
      pending,
      completionRate: (transitioned / campaign.links.length) * 100,
      projectedMRR: this.calculateMRRImpact(campaign),
    };
  }
}
```

**Subscriber Experience**:
```typescript
// Migration modal shows:
// - Current plan: Legacy Starter ($15/mo)
// - New plan: Pro ($29/mo) with 20% discount for 6 months
// - Effective price: $23.20/mo for 6 months, then $29/mo
// - One-click "Accept Migration" button
// - Freighter signs updated allowance
```

### Acceptance Criteria
- [ ] Migration campaign wizard
- [ ] Unique cryptographic URLs
- [ ] Bulk notification dispatch
- [ ] Real-time progress tracker
- [ ] One-click subscriber upgrade
- [ ] MRR impact calculation

---

## Implementation Priority

1. **#186 Fee Bump** (Quick win, high customer impact)
2. **#185 State Backup** (Critical for production readiness)
3. **#184 Volume Tiers** (Revenue optimization)
4. **#183 Plan Migration** (Enterprise feature)

## Testing Strategy

Each implementation requires:
- Unit tests for core logic
- Integration tests for external APIs
- E2E tests for user workflows
- Load tests for performance validation

## Rollback Procedures

### Fee Bump
- Revert widget build
- Original transaction flow still works

### State Backup
- Manual database restoration from previous backup
- No user-facing impact

### Volume Tiers
- Contract upgrade with static fee fallback
- Merchant volumes preserved

### Plan Migration
- Cancel active campaigns
- Subscribers retain current plans
- Notification rollback not needed (already sent)

## Monitoring

- Transaction acceleration success rates
- Snapshot backup completion times
- Volume tier distribution metrics
- Migration campaign completion rates

---

For detailed implementation of each issue, see individual design docs in `docs/design/`.
