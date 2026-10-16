export type OrbitTheme = 'dark' | 'light' | 'auto';
export type OrbitBorderRadius = 'none' | 'sm' | 'md' | 'lg' | 'full';
export interface OrbitCustomClasses { modal?: string; header?: string; button?: string; }

export interface OrbitCustomField {
  id: string;
  label?: string;
  type?: 'text' | 'email' | 'number' | 'tel';
  required?: boolean;
  placeholder?: string;
}

export interface OrbitReadyEvent { type: 'orbit:ready'; planId?: string; }
export interface OrbitWalletConnectedEvent { type: 'orbit:wallet_connected'; address: string; type?: 'wallet' | 'passkey'; isNew?: boolean; }
export interface OrbitSubscribedEvent { type: 'orbit:subscribed'; subscriptionId?: string; planId?: string; txHash: string; metadata?: Record<string, any>; }
export interface OrbitErrorEvent { type: 'orbit:error'; message: string; }
export interface OrbitCloseEvent { type: 'orbit:close'; }

export interface OrbitCheckoutProps {
  planId?: string;
  planData?: any;
  apiUrl?: string;
  demo?: boolean;
  allowedWallets?: string[];
  orbitContractId?: string;
  tokenContractId?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  theme?: OrbitTheme;
  accentColor?: string;
  borderRadius?: OrbitBorderRadius;
  fontFamily?: string;
  customClasses?: OrbitCustomClasses;
  allowedOrigins?: string[];
  customFields?: OrbitCustomField[];
}

export default function OrbitCheckout(props: OrbitCheckoutProps): JSX.Element;