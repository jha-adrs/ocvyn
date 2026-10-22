import type { ColumnType } from '../protocol.ts';

export interface RowSource {
  header: string[];
  columnTypes: ColumnType[];
  rowCount: number; // grows while CSV indexing is in progress
  getRow(i: number): string[];
  /** One cell; cheaper than getRow when a query only needs a few columns. */
  getCell(i: number, col: number): string;
  /** Raw text of row i, used as a cheap pre-check for search. */
  getRaw?(i: number): string;
}

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const GROUPED = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/; // 1,234,567.89 — but not 3,14 or 1,2,3

/** Parse a cell as a plain decimal number (optionally with thousands separators). NaN otherwise. */
export function parseNum(s: string): number {
  const t = s.trim();
  if (NUM.test(t)) return Number(t);
  if (GROUPED.test(t)) return Number(t.replace(/,/g, ''));
  return NaN;
}

/** A column is `number` if ≥ 95% of its non-empty sampled cells parse as numbers. */
export function detectTypes(rows: string[][], width: number): ColumnType[] {
  const types: ColumnType[] = [];
  for (let c = 0; c < width; c++) {
    let filled = 0, nums = 0;
    for (const r of rows) {
      const v = r[c] ?? '';
      if (v.trim() === '') continue;
      filled++;
      if (!Number.isNaN(parseNum(v))) nums++;
    }
    types.push(filled > 0 && nums / filled >= 0.95 ? 'number' : 'text');
  }
  return types;
}

/** Empty or duplicate header names become column_N (1-based). */
export function cleanHeader(raw: string[]): string[] {
  const seen = new Set<string>();
  return raw.map((h, i) => {
    let name = h.trim();
    if (name === '' || seen.has(name)) name = `column_${i + 1}`;
    for (let k = 2; seen.has(name); k++) name = `column_${i + 1}_${k}`; // the file may already have a column_N
    seen.add(name);
    return name;
  });
}

/** Pad or truncate a row to the header width. */
export function fitRow(cells: string[], width: number): string[] {
  if (cells.length === width) return cells;
  if (cells.length > width) return cells.slice(0, width);
  while (cells.length < width) cells.push('');
  return cells;
}
