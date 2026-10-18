// Public surface of @orbit/contract-sdk (#159).
//
// `scval` holds the hand-written ScVal encoders/decoders and the struct helpers,
// while `generated/orbit-contract` is emitted from apps/backend/abi/orbit_soroban.abi.json
// by apps/backend/scripts/generate-contract-sdk.js. Regenerate it after any
// contract change with `npm run generate:contract-sdk` from apps/backend.
export * from './scval';
export * from './generated/orbit-contract';
