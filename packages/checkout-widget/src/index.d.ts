export type OrbitTheme = 'dark' | 'light' | 'auto';
export type OrbitBorderRadius = 'none' | 'sm' | 'md' | 'lg' | 'full';
export interface OrbitCustomClasses { modal?: string; header?: string; button?: string; }
export interface OrbitReadyEvent { type: 'orbit:ready'; planId?: string; }
export interface OrbitWalletConnectedEvent { type: 'orbit:wallet_connected'; address: string; }
export interface OrbitSubscribedEvent { type: 'orbit:subscribed'; subscriptionId?: string; planId?: string; txHash: string; }
export interface OrbitErrorEvent { type: 'orbit:error'; message: string; }
export interface OrbitCloseEvent { type: 'orbit:close'; }