import React, { useState } from 'react';
import OrbitCheckout from './OrbitCheckout';

const PRESET_PLANS = [
  {
    id: "plan_pro",
    name: "Pro Developer Membership",
    usdc_amount: 490000000,
    interval_seconds: 2592000,
    merchants: { name: "Drips Labs", wallet_address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" }
  },
  {
    id: "plan_community",
    name: "Private Alpha Pass",
    usdc_amount: 1000000000,
    interval_seconds: 2592000,
    merchants: { name: "Drips Labs", wallet_address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" }
  },
  {
    id: "plan_enterprise",
    name: "Enterprise Node Retainer",
    usdc_amount: 20000000000,
    interval_seconds: 2592000,
    merchants: { name: "Drips Labs", wallet_address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" }
  }
];

function App() {
  const [selectedPlanIndex, setSelectedPlanIndex] = useState(0);
  const [showWidget, setShowWidget] = useState(true);

  const activePlan = PRESET_PLANS[selectedPlanIndex];

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#09090b',
      color: '#FFFFFF',
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 20px'
    }}>
      {/* Brand Header */}
      <div style={{ textAlign: 'center', marginBottom: '32px' }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 12px',
          borderRadius: '999px',
          backgroundColor: '#18181b',
          border: '1px solid #27272a',
          fontSize: '11px',
          fontFamily: 'monospace',
          color: '#a1a1aa',
          marginBottom: '16px'
        }}>
          <span>orbit</span> • Checkout Widget SDK Tester
        </div>
        <h1 style={{
          fontSize: '28px',
          fontWeight: '700',
          letterSpacing: '-0.03em',
          margin: '0 0 8px 0',
          color: '#ffffff'
        }}>
          Embedded Non-Custodial Checkout
        </h1>
        <p style={{
          fontSize: '13px',
          color: '#71717a',
          maxWidth: '460px',
          margin: '0 auto',
          lineHeight: '1.5'
        }}>
          Test the drop-in <code>&lt;OrbitCheckout /&gt;</code> React component for Stellar Soroban USDC recurring allowances.
        </p>
      </div>

      {/* Preset Plan Selector */}
      <div style={{
        display: 'flex',
        gap: '8px',
        marginBottom: '28px',
        backgroundColor: '#18181b',
        padding: '4px',
        borderRadius: '8px',
        border: '1px solid #27272a'
      }}>
        {PRESET_PLANS.map((plan, idx) => (
          <button
            key={plan.id}
            onClick={() => setSelectedPlanIndex(idx)}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: 'none',
              backgroundColor: selectedPlanIndex === idx ? '#FFFFFF' : 'transparent',
              color: selectedPlanIndex === idx ? '#000000' : '#a1a1aa',
              fontWeight: selectedPlanIndex === idx ? '600' : '400',
              fontSize: '12px',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            {plan.name} (${(plan.usdc_amount / 10000000).toFixed(0)}/mo)
          </button>
        ))}
      </div>

      {/* Embedded Widget */}
      {showWidget && (
        <div style={{
          padding: '8px',
          borderRadius: '16px',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)',
          boxShadow: '0 20px 50px rgba(0,0,0,0.6)'
        }}>
          <OrbitCheckout planId={activePlan.id} planData={activePlan} />
        </div>
      )}

      {/* Footer Info */}
      <div style={{
        marginTop: '36px',
        fontSize: '11px',
        color: '#52525b',
        textAlign: 'center',
        fontFamily: 'monospace'
      }}>
        Contract ID: CAZBZBUWBSQYK2RZ6WHMXVDLIQHSU5WD7ANZYL6HLNSCRUOTNYCDYQNG (Stellar Testnet)
      </div>
    </div>
  );
}

export default App;
