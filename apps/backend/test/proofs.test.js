import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import {
  hashSubscriberLeaf,
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  computeActiveSubscriberCommitment,
  generateMrrAttestation,
  verifyProofAttestation,
} from '../proofs.js';

describe('Privacy-Shielded Merkle Proof & MRR Attestation Engine (#167)', () => {
  const merchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
  const mockSubscribers = [
    {
      id: 'sub-1',
      merchant_id: merchantId,
      customer_wallet_address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      status: 'active',
      plan_id: 'plan-pro',
      plans: { id: 'plan-pro', name: 'Enterprise Pro', usdc_amount: 500000000 }, // $50.00
    },
    {
      id: 'sub-2',
      merchant_id: merchantId,
      customer_wallet_address: 'GCF36H5747VGY7W5B23326USKYY5T5VYZG3N7Y546F3P4Q4XWZYAB34M',
      status: 'active',
      plan_id: 'plan-basic',
      plans: { id: 'plan-basic', name: 'Basic Tier', usdc_amount: 200000000 }, // $20.00
    },
    {
      id: 'sub-3',
      merchant_id: merchantId,
      customer_wallet_address: 'GCLQ73G64R33X3Z4Y6QOQJ6BRP7VYYL7U47A4N6D4Q4XWZYAB34M9999',
      status: 'active',
      plan_id: 'plan-enterprise',
      plans: { id: 'plan-enterprise', name: 'Enterprise High', usdc_amount: 1000000000 }, // $100.00
    },
  ];

  describe('Merkle Tree Commitments', () => {
    it('computes deterministic leaf hashes that conceal customer wallet addresses', () => {
      const leaf1 = hashSubscriberLeaf({
        merchantId,
        customerWallet: mockSubscribers[0].customer_wallet_address,
        planTier: 'Enterprise Pro',
      });
      const leaf2 = hashSubscriberLeaf({
        merchantId,
        customerWallet: mockSubscribers[0].customer_wallet_address,
        planTier: 'Enterprise Pro',
      });
      const leafOther = hashSubscriberLeaf({
        merchantId,
        customerWallet: mockSubscribers[1].customer_wallet_address,
        planTier: 'Basic Tier',
      });

      expect(leaf1).toBe(leaf2);
      expect(leaf1).not.toBe(leafOther);
      expect(leaf1).toMatch(/^[a-f0-9]{64}$/);

      // Verify zero disclosure of customer wallet address in the leaf hash
      expect(leaf1).not.toContain(mockSubscribers[0].customer_wallet_address);
      expect(leaf1).not.toContain('GBBD47');
    });

    it('builds a binary Merkle tree and generates verifiable inclusion proofs', () => {
      const leaves = mockSubscribers.map((s) =>
        hashSubscriberLeaf({
          merchantId,
          customerWallet: s.customer_wallet_address,
          planTier: s.plans.name,
        })
      );

      const tree = buildMerkleTree(leaves);
      expect(tree.root).toMatch(/^[a-f0-9]{64}$/);
      expect(tree.leaves).toHaveLength(3);

      // Inclusion proof for leaf 0
      const targetLeaf = leaves[0];
      const inclusion = getMerkleProof(tree, targetLeaf);
      expect(inclusion).not.toBeNull();
      expect(verifyMerkleProof(targetLeaf, inclusion.proof, tree.root)).toBe(true);

      // Fails for tampered leaf
      const fakeLeaf = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(verifyMerkleProof(fakeLeaf, inclusion.proof, tree.root)).toBe(false);
    });

    it('computes active subscriber commitments aggregating volume', async () => {
      const commitment = await computeActiveSubscriberCommitment({
        merchantId,
        subscribers: mockSubscribers,
      });

      expect(commitment.merchant_id).toBe(merchantId);
      expect(commitment.active_subscriber_count).toBe(3);
      expect(commitment.merkle_root).toMatch(/^[a-f0-9]{64}$/);
      // Aggregate MRR = 50 + 20 + 100 = 170 USDC (1,700,000,000 stroops)
      expect(commitment.aggregateMrr).toBe(1700000000);
    });
  });

  describe('Attestation & Proof Generation', () => {
    it('generates verifiable MRR attestation with bounds and zero wallet disclosure', async () => {
      const { attestation, signature, public_verifier_endpoint } = await generateMrrAttestation({
        merchantId,
        minMrr: 1000000000, // $100 minimum MRR bound
        subscribers: mockSubscribers,
      });

      expect(attestation.attestation_id).toMatch(/^att_/);
      expect(attestation.merchant_id).toBe(merchantId);
      expect(attestation.subscriber_count).toBe(3);
      expect(attestation.mrr_bounds.attested_mrr_exceeds_minimum).toBe(true);
      expect(signature).toMatch(/^[a-f0-9]{64}$/);
      expect(public_verifier_endpoint).toBe('/proofs/verify');

      // CRITICAL ACCEPTANCE CRITERIA: Zero customer wallet disclosure
      const serialized = JSON.stringify(attestation);
      for (const sub of mockSubscribers) {
        expect(serialized).not.toContain(sub.customer_wallet_address);
      }
      expect(serialized).not.toContain('GBBD47');
      expect(serialized).not.toContain('GCF36H');
    });

    it('correctly attests when minimum MRR threshold is not met', async () => {
      const { attestation } = await generateMrrAttestation({
        merchantId,
        minMrr: 5000000000, // $500 minimum (actual is $170)
        subscribers: mockSubscribers,
      });

      expect(attestation.mrr_bounds.attested_mrr_exceeds_minimum).toBe(false);
    });
  });

  describe('Public Verifier API', () => {
    it('verifies a valid attestation against the published Merkle root', async () => {
      const { attestation, signature } = await generateMrrAttestation({
        merchantId,
        minMrr: 500000000,
        subscribers: mockSubscribers,
      });

      const result = verifyProofAttestation({
        attestation,
        signature,
        publishedRoot: attestation.merkle_root,
      });

      expect(result.valid).toBe(true);
      expect(result.subscriber_count).toBe(3);
      expect(result.merkle_root).toBe(attestation.merkle_root);
    });

    it('rejects tampered attestation with altered subscriber count or root', async () => {
      const { attestation, signature } = await generateMrrAttestation({
        merchantId,
        subscribers: mockSubscribers,
      });

      // Tamper with subscriber count
      const tamperedAttestation = {
        ...attestation,
        subscriber_count: 99999,
      };

      const result = verifyProofAttestation({
        attestation: tamperedAttestation,
        signature,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid or has been tampered with');
    });

    it('rejects verification if published root does not match', async () => {
      const { attestation, signature } = await generateMrrAttestation({
        merchantId,
        subscribers: mockSubscribers,
      });

      const result = verifyProofAttestation({
        attestation,
        signature,
        publishedRoot: '1111111111111111111111111111111111111111111111111111111111111111',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not match the published root hash');
    });
  });

  describe('API Endpoints (POST /proofs/mrr-attestation & POST /proofs/verify)', () => {
    it('POST /proofs/mrr-attestation and POST /proofs/verify work end-to-end', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      };
      mockSupabase.eq.mockImplementation((col, val) => {
        if (col === 'status') {
          return Promise.resolve({ data: mockSubscribers, error: null });
        }
        return mockSupabase;
      });

      app.locals.supabase = mockSupabase;

      // 1. Generate proof attestation
      const attestRes = await request(app)
        .post('/proofs/mrr-attestation')
        .send({
          merchant_id: merchantId,
          min_mrr: 100000000,
        });

      expect(attestRes.status).toBe(200);
      expect(attestRes.body.success).toBe(true);
      expect(attestRes.body.attestation).toBeDefined();
      expect(attestRes.body.signature).toBeDefined();

      const { attestation, signature } = attestRes.body;

      // 2. Verify proof with public verifier API
      const verifyRes = await request(app)
        .post('/proofs/verify')
        .send({
          attestation,
          signature,
          merkle_root: attestation.merkle_root,
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.valid).toBe(true);
      expect(verifyRes.body.merkle_root).toBe(attestation.merkle_root);
    }, 15000);
  });
});
