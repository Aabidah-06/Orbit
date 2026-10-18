#!/usr/bin/env node
// Captures the Orbit Soroban contract interface (#159) so the TypeScript SDK can be
// generated from a single canonical ABI instead of hand-maintained ScVal code.
//
//   node scripts/inspect-contract.js [--wasm path/to/orbit_soroban.wasm]
//
// Resolution order, and what the script does in each case:
//
//   1. A compiled WASM is present and the `stellar` CLI is on PATH: the CLI dumps
//      the contract interface, and every ABI function is confirmed to be an actual
//      WASM export. The ABI metadata (wasm hash / Stellar SDK version) is refreshed.
//   2. The WASM or CLI is missing: the checked-in ABI is kept as the source of truth
//      and a warning is printed. This keeps SDK generation reproducible on machines
//      (and CI runners) without a Rust/Soroban toolchain.
//
// Run `npm run generate:contract-sdk` afterwards to emit packages/contract-sdk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_WASM = path.resolve(ROOT, 'contracts/soroban/target/wasm32v1-none/release/orbit_soroban.wasm');
const ABI_PATH = path.resolve(__dirname, '../abi/orbit_soroban.abi.json');

const readArgs = () => {
    const index = process.argv.indexOf('--wasm');
    return { wasmPath: index >= 0 ? path.resolve(process.argv[index + 1]) : DEFAULT_WASM };
};

const hasStellarCli = () => {
    const probe = spawnSync('stellar', ['--version'], { encoding: 'utf8' });
    return probe.status === 0 ? (probe.stdout || '').trim() : null;
};

// The `stellar` CLI has changed subcommands across releases; try the current
// interface dump first and fall back to the older `contract inspect`.
const dumpInterface = (wasmPath) => {
    const attempts = [
        ['contract', 'info', 'interface', '--wasm', wasmPath],
        ['contract', 'inspect', '--wasm', wasmPath],
    ];
    for (const args of attempts) {
        const result = spawnSync('stellar', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        if (result.status === 0 && (result.stdout || '').trim()) {
            return { command: `stellar ${args.join(' ')}`, output: result.stdout };
        }
    }
    return null;
};

// Extracts exported function names from either the JSON (`{"functions":[{name}]}`
// or `[{name}]`) or the textual interface representation emitted by the CLI.
const extractExportedFunctions = (output) => {
    const names = new Set();

    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            const entries = Array.isArray(parsed) ? parsed : parsed.functions ?? parsed.exports ?? [];
            for (const entry of entries) {
                const name = typeof entry === 'string' ? entry : entry?.name ?? entry?.func;
                if (name) names.add(name);
            }
            if (names.size > 0) return names;
        } catch {
            // Not JSON after all; fall through to the text scan.
        }
    }

    for (const match of output.matchAll(/"name"\s*:\s*"([a-z0-9_]+)"/gi)) names.add(match[1]);
    for (const match of output.matchAll(/\bfn\s+([a-z0-9_]+)/gi)) names.add(match[1]);
    return names;
};

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const loadAbi = () => JSON.parse(fs.readFileSync(ABI_PATH, 'utf8'));

const main = () => {
    const { wasmPath } = readArgs();
    const abi = loadAbi();
    const abiFunctions = new Set(abi.functions.map((fn) => fn.name));

    if (!fs.existsSync(wasmPath)) {
        console.warn(`[inspect-contract] WASM not found at ${path.relative(ROOT, wasmPath)}.`);
        console.warn('[inspect-contract] Keeping the checked-in ABI as the SDK source of truth.');
        console.warn('[inspect-contract] Build the contract (cd contracts/soroban && stellar contract build) to refresh it.');
        return;
    }

    const sdkVersion = hasStellarCli();
    if (!sdkVersion) {
        console.warn('[inspect-contract] The `stellar` CLI is not on PATH. Keeping the checked-in ABI.');
        console.warn('[inspect-contract] Install it from https://developers.stellar.org to verify against the compiled WASM.');
        return;
    }

    const dump = dumpInterface(wasmPath);
    if (!dump) {
        console.warn('[inspect-contract] Could not read the contract interface from the WASM. Keeping the checked-in ABI.');
        return;
    }

    const exported = extractExportedFunctions(dump.output);
    const missing = [...abiFunctions].filter((name) => !exported.has(name));
    const extra = [...exported].filter((name) => !abiFunctions.has(name));

    if (missing.length > 0) {
        console.error(`[inspect-contract] ABI references functions missing from the compiled WASM: ${missing.join(', ')}`);
        console.error('[inspect-contract] Rebuild the contract and re-run this script.');
        process.exitCode = 1;
        return;
    }

    if (extra.length > 0) {
        console.warn(`[inspect-contract] The WASM exports functions absent from the ABI: ${extra.join(', ')}`);
        console.warn('[inspect-contract] Add them to apps/backend/abi/orbit_soroban.abi.json to expose them in the SDK.');
    }

    abi.wasm = path.relative(ROOT, wasmPath);
    abi.wasmSha256 = sha256(fs.readFileSync(wasmPath));
    abi.sorobanSdk = sdkVersion.replace(/^stellar\s+/i, '').trim();
    fs.writeFileSync(ABI_PATH, JSON.stringify(abi, null, 2) + '\n');

    console.log(`[inspect-contract] Verified ${abi.functions.length} functions against ${path.relative(ROOT, wasmPath)}.`);
    console.log(`[inspect-contract] Updated ${path.relative(ROOT, ABI_PATH)}.`);
};

if (require.main === module) main();

module.exports = { extractExportedFunctions, DEFAULT_WASM, ABI_PATH };
