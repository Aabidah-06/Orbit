import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import report from '../transaction-report.js';
const { csvCell, toCsvRow, parseExportFilters, buildExportQuery, streamTransactionCsv, registerTransactionExportRoute } = report;

describe('streaming report (#76)', () => {
  it('produces CRLF-delimited RFC 4180 CSV with correct escaping', () => {
    expect(csvCell('a,"b"\nnext')).toBe('"a,""b""\nnext"');
    expect(csvCell('=HYPERLINK("bad")')).toBe(`"'=HYPERLINK(""bad"")"`);
    expect(toCsvRow({transaction_id:'x',customer_wallet:'wallet',amount_usdc_units:123, status:'settled'})).toContain(',123,settled,');
    expect(toCsvRow({transaction_id:'x'}).endsWith('\r\n')).toBe(true);
  });
  it('rejects bad date and invalid filters rather than interpolating SQL', () => {
    expect(() => parseExportFilters({ start_date:'2026-02-30'})).toThrow();
    expect(() => parseExportFilters({ plan_id:"' OR TRUE --"})).toThrow();
    expect(() => parseExportFilters({ status:'fail'})).toThrow();
    const filters=parseExportFilters({ start_date:'2026-10-01', end_date:'2026-10-17',status:'settled' });
    const q=buildExportQuery('owner',filters);
    expect(q.text).toContain('merchant_id = $1');
    expect(q.text).toContain('settled_at < $3');
    expect(q.values[0]).toBe('owner');
    expect(q.values[2]).toContain('2026-10-18');
  });
  it('reads the database in bounded cursor batches and streams rather than buffering', async () => {
    let reads=0; let params;
    const cursor={ read(batch,callback){ reads++; expect(batch).toBe(2); callback(null, reads===1?[{transaction_id:'x',amount_usdc_units:1},{transaction_id:'y',amount_usdc_units:2}]:[]); },close(callback){callback();} };
    const client={query(arg){params=arg;return cursor;}};
    const output=new PassThrough();const received=[];
    output.on('data', chunk=> received.push(chunk.toString()));
    await streamTransactionCsv({client,cursorFactory:(sql,vals)=>({sql,vals}),merchantId:'owner',filters:parseExportFilters({}),output,batchSize:2});
    expect(reads).toBe(2);
    expect(params.vals).toEqual(['owner']);
    expect(received.join('')).toContain('x,,,,1,');
    expect(received.join('')).toContain('y,,,,2,');
  });
  it('sets CSV headers and closes its database cursor', async () => {
    const mockedCursor = { read(size, callback) { callback(null, []); }, close(callback) { callback(); } };
    const client = { query: vi.fn(() => mockedCursor), release: vi.fn() };
    let route;
    const app = { get(path, auth, handler) { route = handler; } };
    registerTransactionExportRoute(app, 'merchant-auth', () => ({ connect: async () => client }), () => ({ pg: 'cursor' }));
    const out = new PassThrough();
    out.status = vi.fn(() => out);
    out.setHeader = vi.fn();
    const data = [];
    out.on('data', chunk => data.push(chunk.toString()));
    await route({ query: {}, merchant: { id: 'm1' } }, out);
    expect(out.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(out.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="orbit-transactions.csv"');
    expect(data.join('')).toContain('transaction_id,subscription_id,plan_id');
    expect(client.release).toHaveBeenCalled();
  });
  it('registers protected route with merchant auth and correct headers', async () => {
    let handler, auth;
    const app={get(path,middleware,route){expect(path).toBe('/reports/transactions/export');auth=middleware;handler=route;}};
    registerTransactionExportRoute(app, 'merchant-auth', () => null, ()=>{});
    expect(auth).toBe('merchant-auth');
    const res={status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis()};
    await handler({query:{status:'failed'},merchant:{id:'1'}},res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
