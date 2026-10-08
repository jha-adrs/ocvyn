import { NUMERIC_OPS, type Query, type Rule } from '../protocol.ts';
import { parseNum, type RowSource } from './types.ts';

const CHUNK = 1 << 16; // check for a newer query every 64k rows

export interface QueryCtx {
  isStale(): boolean;
  onProgress?(rowsDone: number): void;
}

const yieldNow = () => new Promise<void>(r => setImmediate(r));

/** A rule is ignored when its column is gone or a numeric operator has a non-numeric value. */
export function isValidRule(r: Rule, width: number): boolean {
  if (r.col < 0 || r.col >= width) return false;
  if (NUMERIC_OPS.includes(r.op)) return !Number.isNaN(parseNum(r.value));
  return true;
}

/**
 * "Like" matcher, case-insensitive. Without `%` it is a plain substring match.
 * With `%` it is a SQL LIKE pattern over the whole (trimmed) value: `%` = any run, `_` = one character.
 */
export function likeMatcher(pattern: string): (cell: string) => boolean {
  const p = pattern.trim().toLowerCase();
  if (!p.includes('%')) return c => c.toLowerCase().includes(p);
  const body = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  const re = new RegExp(`^${body}$`, 's');
  return c => re.test(c.trim().toLowerCase());
}

function compile(r: Rule): (cell: string) => boolean {
  const v = r.value.trim().toLowerCase();
  const n = parseNum(r.value);
  switch (r.op) {
    case 'is': return c => c.trim().toLowerCase() === v;
    case 'is not': return c => c.trim().toLowerCase() !== v;
    case 'contains': return c => c.toLowerCase().includes(v);
    case 'not contains': return c => !c.toLowerCase().includes(v);
    case 'starts with': return c => c.trim().toLowerCase().startsWith(v);
    case '>': return c => parseNum(c) > n; // NaN compares false, so non-numbers never match
    case '<': return c => parseNum(c) < n;
    case '≥': return c => parseNum(c) >= n;
    case '≤': return c => parseNum(c) <= n;
    case 'is empty': return c => c.trim() === '';
    case 'is not empty': return c => c.trim() !== '';
    case 'like': return likeMatcher(r.value);
    case 'values': {
      const inc = r.include ? new Set(r.include) : undefined;
      const exc = r.exclude?.length ? new Set(r.exclude) : undefined;
      const like = !inc && r.like?.trim() ? likeMatcher(r.like) : undefined;
      return c => {
        const t = c.trim();
        if (exc?.has(t)) return false;
        if (inc) return inc.has(t);
        return like ? like(t) : true;
      };
    }
  }
}

/**
 * Run filter + search + sort. Returns the matching row indices in display order,
 * null for "all rows in file order", or undefined if a newer query superseded this one.
 */
export async function runQuery(src: RowSource, q: Query, ctx: QueryCtx): Promise<Uint32Array | null | undefined> {
  const width = src.header.length;
  const n = src.rowCount;
  const rules = q.filter.rules.filter(r => isValidRule(r, width));
  const tests = rules.map(r => ({ col: r.col, test: compile(r) }));
  const any = q.filter.mode === 'any';
  const search = q.search.trim().toLowerCase();
  const sort = q.sort.filter(s => s.col >= 0 && s.col < width);
  if (tests.length === 0 && !search && sort.length === 0) return null;

  // 1. Filter
  let idx: Uint32Array;
  if (tests.length === 0 && !search) {
    idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
  } else {
    const out = new Uint32Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (i % CHUNK === 0 && i > 0) {
        await yieldNow();
        if (ctx.isStale()) return undefined;
        ctx.onProgress?.(i);
      }
      if (search) {
        if (src.getRaw && !src.getRaw(i).toLowerCase().includes(search)) continue;
        if (!src.getRow(i).some(c => c.toLowerCase().includes(search))) continue;
      }
      if (tests.length > 0) {
        let ok = !any;
        for (const t of tests) {
          const hit = t.test(src.getCell(i, t.col));
          if (any && hit) { ok = true; break; }
          if (!any && !hit) { ok = false; break; }
        }
        if (!ok) continue;
      }
      out[m++] = i;
    }
    idx = out.subarray(0, m);
  }
  if (sort.length === 0) return idx;

  // 2. Sort. Each key becomes an integer rank (empties rank last); keys are folded into one
  // rank, then rank*m + position is sorted with the built-in numeric sort (no JS comparator).
  const m = idx.length;
  const keys = sort.map(s => ({
    desc: s.dir === 'desc',
    num: src.columnTypes[s.col] === 'number' ? new Float64Array(m) : undefined,
    text: src.columnTypes[s.col] === 'number' ? undefined : new Array<string>(m),
    col: s.col,
  }));
  for (let k = 0; k < m; k++) {
    if (k % CHUNK === 0 && k > 0) {
      await yieldNow();
      if (ctx.isStale()) return undefined;
      ctx.onProgress?.(k);
    }
    for (const key of keys) {
      const c = src.getCell(idx[k], key.col);
      if (key.num) key.num[k] = parseNum(c);
      else key.text![k] = c.trim().toLowerCase();
    }
  }
  let combined: Float64Array | undefined;
  let span = 1; // combined values are < span
  for (const key of keys) {
    const { rank, size } = key.num ? rankNumbers(key.num, key.desc) : rankStrings(key.text!, key.desc);
    if (!combined) { combined = rank; span = size; continue; }
    if (span * size * m > 2 ** 52) { combined = rankNumbers(combined, false).rank; span = m; } // keep values exact
    for (let k = 0; k < m; k++) combined[k] = combined[k] * size + rank[k];
    span *= size;
  }
  if (span * m > 2 ** 52) combined = rankNumbers(combined!, false).rank;
  const packed = new Float64Array(m);
  for (let k = 0; k < m; k++) packed[k] = combined![k] * m + k; // k breaks ties: original order
  packed.sort();
  const result = new Uint32Array(m);
  for (let k = 0; k < m; k++) result[k] = idx[packed[k] % m];
  return result;
}

interface Ranked { rank: Float64Array; size: number } // ranks are 0..size-1

/** Dense ranks of numbers; NaN (empty / not a number) ranks after everything. */
function rankNumbers(v: Float64Array, desc: boolean): Ranked {
  const sorted = Float64Array.from(v).sort(); // NaN sorts to the end
  let u = 0;
  for (let k = 0; k < sorted.length; k++) {
    const x = sorted[k];
    if (Number.isNaN(x)) break;
    if (u === 0 || sorted[u - 1] !== x) sorted[u++] = x;
  }
  const rank = new Float64Array(v.length);
  for (let k = 0; k < v.length; k++) {
    const x = v[k];
    if (Number.isNaN(x)) { rank[k] = u; continue; }
    let lo = 0, hi = u - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
    rank[k] = desc ? u - 1 - lo : lo;
  }
  return { rank, size: u + 1 };
}

/** Dense ranks of strings; '' ranks after everything. */
function rankStrings(v: string[], desc: boolean): Ranked {
  const ids = new Map<string, number>();
  for (const s of v) if (s !== '') ids.set(s, 0);
  const uniq = [...ids.keys()].sort();
  const u = uniq.length;
  uniq.forEach((s, j) => ids.set(s, desc ? u - 1 - j : j));
  const rank = new Float64Array(v.length);
  for (let k = 0; k < v.length; k++) rank[k] = v[k] === '' ? u : ids.get(v[k])!;
  return { rank, size: u + 1 };
}

export interface Distinct { values: string[]; counts: number[]; truncated: boolean }

export const MAX_DISTINCT = 500_000;

/**
 * Every distinct (trimmed) value of a column with its row count. Numbers sort numerically,
 * text alphabetically (case-insensitive), blanks last. Stops collecting new values at `cap`.
 */
export async function distinctValues(src: RowSource, col: number, cap = MAX_DISTINCT): Promise<Distinct> {
  const counts = new Map<string, number>();
  let truncated = false;
  for (let i = 0; i < src.rowCount; i++) {
    if (i % CHUNK === 0 && i > 0) await yieldNow();
    const v = src.getCell(i, col).trim();
    const n = counts.get(v);
    if (n !== undefined) counts.set(v, n + 1);
    else if (counts.size < cap) counts.set(v, 1);
    else truncated = true;
  }
  const values = [...counts.keys()];
  if (src.columnTypes[col] === 'number') {
    const num = new Map(values.map(v => [v, parseNum(v)]));
    values.sort((a, b) => {
      const x = num.get(a)!, y = num.get(b)!;
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) === Number.isNaN(y) ? (a < b ? -1 : a > b ? 1 : 0) : Number.isNaN(x) ? 1 : -1;
      return x - y;
    });
  } else {
    const low = new Map(values.map(v => [v, v.toLowerCase()]));
    values.sort((a, b) => { const x = low.get(a)!, y = low.get(b)!; return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; });
  }
  const blank = values.indexOf('');
  if (blank >= 0) { values.splice(blank, 1); values.push(''); }
  return { values, counts: values.map(v => counts.get(v)!), truncated };
}
