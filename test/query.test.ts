import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Query, Rule, SortKey } from '../src/protocol.ts';
import { CsvSource } from '../src/engine/csvSource.ts';
import { distinctValues, likeMatcher, runQuery } from '../src/engine/query.ts';

const CSV = `name,city,amount,status
Ann,Pune,100,paid
bob,Delhi,25,Unpaid
Cid,pune,,paid
Dee,Agra,1000,
Eve,delhi,25,PAID
`;
const src = new CsvSource(Buffer.from(CSV));
src.indexAll();

let id = 0;
const q = (rules: Rule[] = [], opts: { mode?: 'all' | 'any'; search?: string; sort?: SortKey[] } = {}): Query =>
  ({ id: ++id, filter: { mode: opts.mode ?? 'all', rules }, search: opts.search ?? '', sort: opts.sort ?? [] });
const names = async (query: Query) => {
  const v = await runQuery(src, query, { isStale: () => false });
  const idx = v === null ? [...Array(src.rowCount).keys()] : [...v!];
  return idx.map(i => src.getRow(i)[0]);
};

test('no query is the identity view', async () => {
  assert.equal(await runQuery(src, q(), { isStale: () => false }), null);
});

test('operators', async () => {
  assert.deepEqual(await names(q([{ col: 3, op: 'is', value: 'Paid' }])), ['Ann', 'Cid', 'Eve']);
  assert.deepEqual(await names(q([{ col: 3, op: 'is not', value: 'paid' }])), ['bob', 'Dee']);
  assert.deepEqual(await names(q([{ col: 1, op: 'contains', value: 'EL' }])), ['bob', 'Eve']);
  assert.deepEqual(await names(q([{ col: 1, op: 'not contains', value: 'e' }])), ['Dee']);
  assert.deepEqual(await names(q([{ col: 0, op: 'starts with', value: 'd' }])), ['Dee']);
  assert.deepEqual(await names(q([{ col: 2, op: '>', value: '25' }])), ['Ann', 'Dee']);
  assert.deepEqual(await names(q([{ col: 2, op: '<', value: '100' }])), ['bob', 'Eve']);
  assert.deepEqual(await names(q([{ col: 2, op: '≥', value: '100' }])), ['Ann', 'Dee']);
  assert.deepEqual(await names(q([{ col: 2, op: '≤', value: '1,000' }])), ['Ann', 'bob', 'Dee', 'Eve']);
  assert.deepEqual(await names(q([{ col: 3, op: 'is empty', value: '' }])), ['Dee']);
  assert.deepEqual(await names(q([{ col: 2, op: 'is not empty', value: '' }])), ['Ann', 'bob', 'Dee', 'Eve']);
});

test('all vs any', async () => {
  const rules: Rule[] = [{ col: 1, op: 'is', value: 'pune' }, { col: 3, op: 'is', value: 'paid' }];
  assert.deepEqual(await names(q(rules)), ['Ann', 'Cid']);
  assert.deepEqual(await names(q(rules, { mode: 'any' })), ['Ann', 'Cid', 'Eve']);
});

test('search is ANDed with rules and is case-insensitive', async () => {
  assert.deepEqual(await names(q([], { search: 'DELHI' })), ['bob', 'Eve']);
  assert.deepEqual(await names(q([{ col: 3, op: 'is', value: 'paid' }], { search: 'delhi' })), ['Eve']);
  assert.deepEqual(await names(q([], { search: 'pune,100' })), []); // no match across cells
});

test('invalid numeric value: rule is ignored', async () => {
  assert.equal(await runQuery(src, q([{ col: 2, op: '>', value: 'abc' }]), { isStale: () => false }), null);
});

test('sort: number, text, desc, empties last, stable ties', async () => {
  assert.deepEqual(await names(q([], { sort: [{ col: 2, dir: 'asc' }] })), ['bob', 'Eve', 'Ann', 'Dee', 'Cid']);
  assert.deepEqual(await names(q([], { sort: [{ col: 2, dir: 'desc' }] })), ['Dee', 'Ann', 'bob', 'Eve', 'Cid']);
  assert.deepEqual(await names(q([], { sort: [{ col: 3, dir: 'asc' }] })), ['Ann', 'Cid', 'Eve', 'bob', 'Dee']);
  assert.deepEqual(await names(q([], { sort: [{ col: 0, dir: 'desc' }] })), ['Eve', 'Dee', 'Cid', 'bob', 'Ann']);
});

test('multi-level sort with a filter', async () => {
  const sort: SortKey[] = [{ col: 1, dir: 'asc' }, { col: 2, dir: 'desc' }];
  assert.deepEqual(await names(q([], { sort })), ['Dee', 'bob', 'Eve', 'Ann', 'Cid']);
  assert.deepEqual(await names(q([{ col: 3, op: 'is', value: 'paid' }], { sort })), ['Eve', 'Ann', 'Cid']);
});

test('a newer query cancels an older one', async () => {
  const big = new CsvSource(Buffer.from('n\n' + Array.from({ length: 200_000 }, (_, i) => i).join('\n')));
  big.indexAll();
  let latest = 1;
  const p = runQuery(big, { id: 1, filter: { mode: 'all', rules: [{ col: 0, op: 'contains', value: '1' }] }, search: '', sort: [] }, { isStale: () => latest !== 1 });
  latest = 2;
  assert.equal(await p, undefined);
});

test('like: substring without %, SQL LIKE with %', () => {
  const m = (p: string, v: string) => likeMatcher(p)(v);
  assert.equal(m('EL', 'Delhi'), true);
  assert.equal(m('order_id', 'my order_id x'), true); // _ is literal without %
  assert.equal(m('pa%', 'Paid'), true);
  assert.equal(m('pa%', 'unpaid'), false);
  assert.equal(m('%paid', 'unpaid'), true);
  assert.equal(m('p_ne%', 'Pune'), true);
  assert.equal(m('%a.b%', 'xa.by'), true);
  assert.equal(m('%a.b%', 'xazby'), false); // regex chars are literal
});

test('like operator in rules', async () => {
  assert.deepEqual(await names(q([{ col: 1, op: 'like', value: 'p%' }])), ['Ann', 'Cid']);
  assert.deepEqual(await names(q([{ col: 1, op: 'like', value: 'elh' }])), ['bob', 'Eve']);
});

test('values rule: include, exclude, like + exclude', async () => {
  const vr = (extra: object) => q([{ col: 3, op: 'values', value: '', ...extra }]);
  assert.deepEqual(await names(vr({ include: ['paid', ''] })), ['Ann', 'Cid', 'Dee']); // exact, blanks selectable
  assert.deepEqual(await names(vr({ exclude: ['paid'] })), ['bob', 'Dee', 'Eve']);
  assert.deepEqual(await names(vr({ like: '%paid', exclude: ['Unpaid'] })), ['Ann', 'Cid', 'Eve']);
  assert.deepEqual(await names(vr({ include: [] })), []);
});

test('distinct values: counts, sorted, blanks last, cap', async () => {
  const status = await distinctValues(src, 3);
  assert.deepEqual(status.values, ['PAID', 'paid', 'Unpaid', '']);
  assert.deepEqual(status.counts, [1, 2, 1, 1]);
  const amount = await distinctValues(src, 2);
  assert.deepEqual(amount.values, ['25', '100', '1000', '']); // numeric order
  assert.deepEqual(amount.counts, [2, 1, 1, 1]);
  const capped = await distinctValues(src, 0, 2);
  assert.equal(capped.truncated, true);
  assert.equal(capped.values.length, 2);
});
