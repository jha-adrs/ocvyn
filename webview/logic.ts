import { NO_VALUE_OPS, NUMERIC_OPS, type Op, type Rule, type SortKey } from '../src/protocol.ts';
import { parseNum } from '../src/engine/types.ts';

/**
 * Header click: sort by this column only, cycling asc → desc → off.
 * Shift+click: add the column as the next level, or cycle it in place (asc → desc → removed).
 */
export function nextSort(sort: SortKey[], col: number, shift: boolean): SortKey[] {
  const cur = sort.find(s => s.col === col);
  if (!shift) {
    if (sort.length === 1 && cur) return cur.dir === 'asc' ? [{ col, dir: 'desc' }] : [];
    return [{ col, dir: 'asc' }];
  }
  if (!cur) return [...sort, { col, dir: 'asc' }];
  if (cur.dir === 'asc') return sort.map(s => (s.col === col ? { col, dir: 'desc' } : s));
  return sort.filter(s => s.col !== col);
}

export const needsValue = (op: Op) => !NO_VALUE_OPS.includes(op);

/** Numeric operators need a numeric value; otherwise the rule is ignored and its pill turns red. */
export const ruleIsValid = (r: Rule) => !NUMERIC_OPS.includes(r.op) || !Number.isNaN(parseNum(r.value));

const showValues = (vs: string[]) =>
  vs.slice(0, 2).map(v => (v === '' ? '(Blanks)' : v)).join(', ') + (vs.length > 2 ? ` +${vs.length - 2}` : '');

export function ruleLabel(r: Rule, header: string[]): string {
  const name = header[r.col] ?? `column_${r.col + 1}`;
  if (r.op === 'values') {
    if (r.include) return `${name}: ${showValues(r.include)}`;
    const parts = [name];
    if (r.like) parts.push(`like ${r.like}`);
    if (r.exclude?.length) parts.push(`except ${showValues(r.exclude)}`);
    return parts.join(' ');
  }
  return needsValue(r.op) ? `${name} ${r.op} ${r.value}` : `${name} ${r.op}`;
}

export function sortLabel(sort: SortKey[], header: string[]): string {
  return sort.map(s => `${s.dir === 'asc' ? '↑' : '↓'} ${header[s.col]}`).join(' then ');
}

/**
 * What is ticked in a column dropdown. `base` is the state of every value not in `toggled`.
 * Typing a search resets to "all matching the search ticked", like Excel.
 */
export interface ValueSelection { search: string; base: 'all' | 'none'; toggled: Set<string> }

export function selectionFromRule(r?: Rule): ValueSelection {
  if (!r) return { search: '', base: 'all', toggled: new Set() };
  if (r.include) return { search: '', base: 'none', toggled: new Set(r.include) };
  return { search: r.like ?? '', base: 'all', toggled: new Set(r.exclude ?? []) };
}

export const isChecked = (s: ValueSelection, v: string) => (s.base === 'all' ? !s.toggled.has(v) : s.toggled.has(v));

/** The rule a dropdown selection means: a Rule, null for "no filter", undefined when nothing is ticked. */
export function valuesRuleFrom(col: number, s: ValueSelection): Rule | null | undefined {
  if (s.base === 'none') return s.toggled.size ? { col, op: 'values', value: '', include: [...s.toggled] } : undefined;
  const like = s.search.trim();
  if (!like && s.toggled.size === 0) return null;
  const r: Rule = { col, op: 'values', value: '' };
  if (like) r.like = like;
  if (s.toggled.size) r.exclude = [...s.toggled];
  return r;
}

/** Selected rows as inclusive [start, end] ranges of view positions, plus the Shift+click anchor. */
export interface RowSelection { ranges: [number, number][]; anchor: number }

export const noRows = (): RowSelection => ({ ranges: [], anchor: -1 });

/** Click = just this row, Shift = range from the anchor, Ctrl/⌘ = toggle this row. */
export function selectRow(sel: RowSelection, k: number, mod: { shift?: boolean; toggle?: boolean }): RowSelection {
  if (mod.shift && sel.anchor >= 0) return { ranges: [[Math.min(sel.anchor, k), Math.max(sel.anchor, k)]], anchor: sel.anchor };
  if (mod.toggle) {
    if (!isRowSelected(sel, k)) return { ranges: [...sel.ranges, [k, k]], anchor: k };
    const ranges: [number, number][] = [];
    for (const [a, b] of sel.ranges) {
      if (k < a || k > b) ranges.push([a, b]);
      else {
        if (a < k) ranges.push([a, k - 1]);
        if (k < b) ranges.push([k + 1, b]);
      }
    }
    return { ranges, anchor: k };
  }
  return { ranges: [[k, k]], anchor: k };
}

export const isRowSelected = (sel: RowSelection, k: number) => sel.ranges.some(([a, b]) => k >= a && k <= b);

export const selectedCount = (sel: RowSelection) => sel.ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
