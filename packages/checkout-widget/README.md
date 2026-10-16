# Orbit Checkout Widget

`<OrbitCheckout />` is an embeddable React checkout for Orbit pull payments on Stellar Soroban. It loads a plan, lets the customer choose a supported wallet, signs the USDC `approve` and Orbit `create_vault` transactions, waits for both to confirm, and only then records the subscription with the Merchant API.

## Supported wallets

The widget configures only these tree-shakeable modules from Stellar Wallets Kit:

- Freighter
- Albedo
- Lobstr
- Hana
- xBull

The selected wallet is persisted in `localStorage`. Use `allowedWallets` to expose a subset.

## Setup

```bash
cd packages/checkout-widget
npm install
npm run dev
```

Configure the public Vite environment:

```dotenv
VITE_ORBIT_CONTRACT_ID=C...
VITE_USDC_CONTRACT_ID=C...
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
VITE_STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

## Props

| Prop | Default | Description |
|---|---|---|
| `planId` | — | Plan UUID loaded from `GET /plans/:id`. |
| `planData` | — | Preloaded plan; must include the merchant wallet address. |
| `apiUrl` | `http://localhost:3001` | Merchant API base URL. |
| `allowedWallets` | all five wallets | Array of Stellar Wallets Kit wallet IDs. |
| `demo` | `false` | Adds an explicitly labelled offline preview option. It never signs or records a subscription. |
| `orbitContractId` | `VITE_ORBIT_CONTRACT_ID` | Orbit contract address. |
| `tokenContractId` | `VITE_USDC_CONTRACT_ID` | USDC SAC address. |
| `rpcUrl` | Stellar testnet RPC | Soroban JSON-RPC endpoint. |
| `networkPassphrase` | Stellar testnet | Network used for signing. |

```jsx
<OrbitCheckout
  planId="e2a0b3df-2015-4672-9721-a1e94c1408d7"
  apiUrl="http://localhost:3001"
  allowedWallets={["freighter", "albedo", "lobstr", "hana", "xbull"]}
/>
```

The allowance covers 12 billing cycles and expires after those cycles plus a ledger safety margin. If either wallet transaction fails or is rejected, `POST /subscriptions` is not called and the error remains visible in the widget.
