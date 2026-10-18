import { ORBIT_API_URL, merchantRequestHeaders } from './api';
export interface CohortCell { month:number; retained:number; retention:number; churned_wallets:string[] }
export interface CohortRow { cohort:string; acquired:number; cells:CohortCell[] }
export async function fetchCohorts(filters:{planId?:string;from?:string;to?:string}={}):Promise<CohortRow[]> {
  const url=new URL('/analytics/cohorts',ORBIT_API_URL);
  if(filters.planId) url.searchParams.set('plan_id',filters.planId);
  if(filters.from) url.searchParams.set('from',filters.from);
  if(filters.to) url.searchParams.set('to',filters.to);
  const response=await fetch(url,{headers:merchantRequestHeaders()});
  if(!response.ok) throw new Error((await response.json().catch(()=>null))?.error||'Failed to load retention cohorts');
  return (await response.json()).cohorts;
}
