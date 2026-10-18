import { describe,it,expect,vi } from 'vitest';
import { createRequire } from 'module';
const require=createRequire(import.meta.url);
const {MemoryUsageBuffer,rollupUsage}=require('../usage-meter.js');
const {calculateCohorts}=require('../cohorts.js');
const {renderMarkdown,sendWithResend}=require('../notification-templates.js');

describe('exact usage aggregation',()=>{
 it('adds integer usage exactly and deduplicates retried events',async()=>{const buffer=new MemoryUsageBuffer();const base={merchantId:'m1',subscriptionId:'s1',metric:'api_calls',occurredAt:'2026-10-18T10:01:00Z'};expect((await buffer.ingest({...base,quantity:7,idempotencyKey:'event-0001'})).accepted).toBe(true);expect((await buffer.ingest({...base,quantity:7,idempotencyKey:'event-0001'})).accepted).toBe(false);await buffer.ingest({...base,quantity:11,idempotencyKey:'event-0002'});expect((await buffer.closedWindows('2026-10-18T10:06:00Z'))[0]).toMatchObject({quantity:18,events:2});});
 it('commits closed windows and acknowledges only after the replay-safe RPC',async()=>{const buffer=new MemoryUsageBuffer();await buffer.ingest({merchantId:'m',subscriptionId:'s',metric:'minutes',quantity:9,idempotencyKey:'event-123',occurredAt:'2026-10-18T10:01:00Z'});const supabase={rpc:vi.fn().mockResolvedValue({data:true,error:null})};expect(await rollupUsage({buffer,supabase,now:new Date('2026-10-18T10:06:00Z')})).toEqual({scanned:1,committed:1});expect(await buffer.closedWindows('2026-10-18T10:10:00Z')).toHaveLength(0);expect(supabase.rpc).toHaveBeenCalledWith('commit_usage_window',expect.objectContaining({p_quantity:9,p_event_count:1}));});
});

describe('history-correct cohorts',()=>{
 it('uses lifecycle timestamps rather than current-only status',()=>{const rows=calculateCohorts([{plan_id:'pro',customer_wallet_address:'GA',created_at:'2026-01-05T00:00:00Z',history:[{status:'active',changed_at:'2026-01-05T00:00:00Z'},{status:'cancelled',changed_at:'2026-03-10T00:00:00Z'}]},{plan_id:'pro',customer_wallet_address:'GB',created_at:'2026-01-20T00:00:00Z',history:[{status:'active',changed_at:'2026-01-20T00:00:00Z'}]}],{months:3});expect(rows[0].cells.map(c=>c.retention)).toEqual([100,100,50]);expect(rows[0].cells[2].churned_wallets).toEqual(['GA']);});
 it('filters acquisition cohorts by plan',()=>{const data=[{plan_id:'a',customer_wallet_address:'A',created_at:'2026-01-01',history:[]},{plan_id:'b',customer_wallet_address:'B',created_at:'2026-01-01',history:[]}];expect(calculateCohorts(data,{planId:'b',months:1})[0].acquired).toBe(1);});
});

describe('notification templates',()=>{
 it('escapes merchant HTML before applying a small markdown subset',()=>{const html=renderMarkdown('**Hi** <img src=x onerror=alert(1)> {{amount}}',{amount:'<29>'});expect(html).toContain('<strong>Hi</strong>');expect(html).toContain('&lt;img');expect(html).toContain('&lt;29&gt;');expect(html).not.toContain('<img');});
 it('uses the real provider API contract and surfaces its message id',async()=>{const fetchImpl=vi.fn().mockResolvedValue({ok:true,json:async()=>({id:'email_1'})});await expect(sendWithResend({fetchImpl,apiKey:'secret',from:'Orbit <mail@orbit.test>',to:'merchant@example.com',subject:'Test',html:'hello'})).resolves.toBe('email_1');expect(fetchImpl).toHaveBeenCalledWith('https://api.resend.com/emails',expect.objectContaining({method:'POST'}));});
});
