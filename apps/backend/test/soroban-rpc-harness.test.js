import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  SorobanRpcHarness,
  createSorobanRpcHarness,
  sanitizePayload,
  deriveRequestKey,
  ContractInterfaceMismatchError,
  SnapshotNotFoundError,
} from './soroban-rpc-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.resolve(__dirname, 'fixtures', 'soroban-rpc');

describe('Soroban RPC Snapshot & Replay Harness (#137)', () => {
  describe('Sanitization & Secret Protection', () => {
    it('redacts Stellar secret keys (S...) from payload strings and objects', () => {
      const secret = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6IRKDMPWAZDOBXDT2W2WWDIFAZ5';
      const input = {
        memo: `Transaction signed with ${secret}`,
        nested: {
          private_key: 'super-sensitive-data',
          secretSeed: secret,
        },
      };

      const sanitized = sanitizePayload(input);
      expect(sanitized.memo).not.toContain(secret);
      expect(sanitized.memo).toContain('SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
      expect(sanitized.nested.private_key).toBe('[REDACTED]');
      expect(sanitized.nested.secretSeed).not.toContain(secret);
    });

    it('redacts Authorization bearer tokens', () => {
      const input = 'Authorization: Bearer orb_live_secret1234567890';
      const sanitized = sanitizePayload(input);
      expect(sanitized).toBe('Authorization: Bearer [REDACTED]');
    });
  });

  describe('Deterministic Key Derivation', () => {
    it('generates consistent hash keys for identical simulateTransaction calls', () => {
      const key1 = deriveRequestKey('simulateTransaction', 'AAAAAgAAAA...');
      const key2 = deriveRequestKey('simulateTransaction', 'AAAAAgAAAA...');
      expect(key1).toBe(key2);
      expect(typeof key1).toBe('string');
      expect(key1.length).toBe(32);
    });

    it('generates distinct hash keys for different methods or payloads', () => {
      const key1 = deriveRequestKey('getTransaction', 'hash_a');
      const key2 = deriveRequestKey('getTransaction', 'hash_b');
      expect(key1).not.toBe(key2);
    });
  });

  describe('Offline Replay Mode', () => {
    it('replays simulateTransaction deterministically from fixture without network', async () => {
      const harness = createSorobanRpcHarness({
        fixtureDir,
        mode: 'replay',
      });

      // Inject custom fixture snapshot for testing
      harness.snapshots.simulateTransaction['test_sim_key'] = {
        key: 'test_sim_key',
        response: {
          status: 'SUCCESS',
          latestLedger: 1000,
          results: [{ auth: [], xdr: 'AAAAAwAAAA==' }],
        },
      };

      const key = deriveRequestKey('simulateTransaction', 'test_tx_payload');
      harness.snapshots.simulateTransaction[key] = {
        key,
        response: {
          status: 'SUCCESS',
          latestLedger: 1000,
          results: [{ auth: [], xdr: 'AAAAAwAAAA==' }],
        },
      };

      const server = harness.createServer();
      const res = await server.simulateTransaction('test_tx_payload');
      expect(res.status).toBe('SUCCESS');
      expect(res.latestLedger).toBe(1000);
    });

    it('replays getTransaction successfully without network calls', async () => {
      const harness = createSorobanRpcHarness({
        fixtureDir,
        mode: 'replay',
      });

      const server = harness.createServer();
      const res = await server.getTransaction('4a7f2e186c5141b99cf390d1bf379b329c3e1b527d4a4f8eb1a2c3d4e5f60718');
      expect(res.status).toBe('SUCCESS');
      expect(res.latestLedger).toBe(1005);
    });

    it('throws SnapshotNotFoundError for unrecorded requests in replay mode', async () => {
      const harness = createSorobanRpcHarness({
        fixtureDir,
        mode: 'replay',
      });
      // Clear fixtures for test
      harness.snapshots.sendTransaction = {};

      const server = harness.createServer();
      await expect(server.sendTransaction('unrecorded_tx')).rejects.toThrow(SnapshotNotFoundError);
    });
  });

  describe('Contract Interface & Schema Mismatch Detection', () => {
    it('detects missing required fields in simulateTransaction response', () => {
      const harness = createSorobanRpcHarness({ fixtureDir, mode: 'replay' });
      const badResponse = { foo: 'bar' }; // Missing status, results, error

      expect(() => {
        harness.validateSchema('simulateTransaction', badResponse, {});
      }).toThrow(ContractInterfaceMismatchError);
    });

    it('detects invalid auth array in simulateTransaction results', () => {
      const harness = createSorobanRpcHarness({ fixtureDir, mode: 'replay' });
      const badResponse = {
        status: 'SUCCESS',
        results: [{ auth: 'not-an-array' }],
      };

      expect(() => {
        harness.validateSchema('simulateTransaction', badResponse, {});
      }).toThrow(ContractInterfaceMismatchError);
    });

    it('detects missing status in sendTransaction response', () => {
      const harness = createSorobanRpcHarness({ fixtureDir, mode: 'replay' });
      expect(() => {
        harness.validateSchema('sendTransaction', { hash: '123' }, {});
      }).toThrow(ContractInterfaceMismatchError);
    });
  });

  describe('Opt-In Recording Mode', () => {
    it('records and sanitizes live server responses when recording is enabled', async () => {
      const mockLiveServer = {
        simulateTransaction: vi.fn().mockResolvedValue({
          status: 'SUCCESS',
          latestLedger: 1050,
          results: [{ auth: [] }],
          secret_leak: 'SCZANGBA5YHTNYVVV4C3U252E2B6P6IRKDMPWAZDOBXDT2W2WWDIFAZ5',
        }),
      };

      const harness = createSorobanRpcHarness({
        fixtureDir,
        mode: 'record',
        liveServer: mockLiveServer,
      });

      // Mock saveSnapshots so file system is not written during test
      harness.saveSnapshots = vi.fn();

      const server = harness.createServer();
      const result = await server.simulateTransaction('incoming_tx');

      expect(mockLiveServer.simulateTransaction).toHaveBeenCalled();
      expect(result.status).toBe('SUCCESS');
      // Secret key must be sanitized even if leaked by live server
      expect(result.secret_leak).not.toContain('SCZANGBA5YHTNYVVV4C3U252E2B6P6IRKDMPWAZDOBXDT2W2WWDIFAZ5');
      expect(harness.saveSnapshots).toHaveBeenCalled();
    });
  });
});
