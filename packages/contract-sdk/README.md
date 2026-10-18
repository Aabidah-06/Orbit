# @orbit/contract-sdk

Typed [Soroban](https://soroban.stellar.org/) client for the Orbit subscription
contract (#159). It turns the checked-in contract ABI into strongly-typed
function wrappers, so the backend, dashboard and checkout widget assemble ScVals
through one surface instead of hand-rolling `xdr.ScVal` values.

## Layout

| Path | Role |
|---|---|
| `abi/orbit_soroban.abi.json` | Mirror of the canonical ABI in `apps/backend/abi/`. |
| `src/scval.ts` | ScVal encoders/decoders and struct helpers (hand-written). |
| `src/generated/orbit-contract.ts` | Generated client — **do not edit by hand**. |
| `src/index.ts` | Public re-export of the two modules above. |

The package is consumed as TypeScript source inside this monorepo (there is no
build step); `@stellar/stellar-sdk` is the only runtime dependency.

## Regenerating

The canonical ABI lives at `apps/backend/abi/orbit_soroban.abi.json`. After a
contract change:

```bash
# 1. Optional: verify the ABI against a locally compiled WASM.
#    Without a WASM/Stellar CLI this keeps the checked-in ABI and warns.
cd apps/backend && npm run inspect-contract

# 2. Regenerate the typed client and the ABI mirror.
cd apps/backend && npm run generate:contract-sdk
```

`generate:contract-sdk` reads the ABI, writes
`packages/contract-sdk/src/generated/orbit-contract.ts`, and refreshes the ABI
mirror under this package. Commit both outputs alongside the ABI change.

## Usage

The generated `OrbitContractClient` is transport-agnostic: you supply an
`OrbitContractInvoker` that knows how to reach the network (Soroban RPC, a
fee-bump relayer, a wallet kit, or a test double).

```ts
import { createOrbitContractClient, type OrbitContractInvoker } from '@orbit/contract-sdk';

const invoker: OrbitContractInvoker = {
  async invoke(functionName, args, options) {
    // Submit (or simulate, when options.readOnly) a contract call and return
    // its decoded return ScVal. Example: client.invokeContract(...)
    return rpcClient.invokeContract({ functionName, args, signer: options.signer, readOnly: options.readOnly });
  },
};

const orbit = createOrbitContractClient(invoker);

// Mutating call — amounts accept bigint, number or string.
await orbit.pullFunds({ user: subscriber, merchant });

// Batched pull (#92): the contract caps a batch at 50 subscribers and returns
// one result per subscriber, in the same order.
const results = await orbit.batchPullFunds({ merchant, subscribers });
for (const { subscriber, success, amount } of results) {
  // success === false means that subscriber was skipped (not active / not due).
}

// Read-only call.
const vault = await orbit.getVault({ user: subscriber, merchant });
if (vault) console.log(vault.amount_per_interval, vault.payment_status);
```

Struct inputs are the `*Input` interfaces exported from the generated module;
read-only struct returns are decoded into the matching output interfaces (for
example `getVault` returns `VaultData | null`). Low-level helpers
(`addressToScVal`, `decodeI128`, `encodeStruct`, …) are re-exported from `scval`
for anywhere the generated wrappers do not cover.
