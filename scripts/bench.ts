// Usage: node scripts/bench.ts <file.csv>
// Times the engine against the targets in the spec: first rows, full index, filter, sort.
import { readFileSync } from 'node:fs';
import { CsvSource } from '../src/engine/csvSource.ts';
import { runQuery } from '../src/engine/query.ts';
import type { Query } from '../src/protocol.ts';

const file = process.argv[2];
const t = () => performance.now();
const ms = (a: number) => `${(t() - a).toFixed(0)} ms`;

let t0 = t();
const buf = readFileSync(file);
const src = new CsvSource(buf);
while (src.columnTypes.length === 0) src.indexChunk(8 << 20);
console.log(`first rows ready  ${ms(t0)}  (${src.rowCount} rows, includes reading the file)`);
while (!src.indexChunk(8 << 20));
console.log(`full index        ${ms(t0)}  (${src.rowCount.toLocaleString()} rows, types ${src.columnTypes.join('/')})`);

const run = async (label: string, q: Omit<Query, 'id'>) => {
  const a = t();
  const v = await runQuery(src, { id: 1, ...q }, { isStale: () => false });
  console.log(`${label.padEnd(18)}${ms(a)}  (${v ? v.length.toLocaleString() : 'all'} rows)`);
};
const none = { filter: { mode: 'all' as const, rules: [] }, search: '', sort: [] };
await run('filter is', { ...none, filter: { mode: 'all', rules: [{ col: 3, op: 'is', value: 'paid' }] } });
await run('filter 2 rules', { ...none, filter: { mode: 'all', rules: [{ col: 2, op: 'contains', value: 'pu' }, { col: 4, op: '>', value: '5000' }] } });
await run('search', { ...none, search: 'follow' });
await run('sort number', { ...none, sort: [{ col: 4, dir: 'desc' }] });
await run('sort text+number', { ...none, sort: [{ col: 2, dir: 'asc' }, { col: 4, dir: 'desc' }] });
console.log(`heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
