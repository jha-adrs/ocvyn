// Shared message types: webview <-> extension host <-> engine worker.

export type ColumnType = 'number' | 'text';

export type Op =
  | 'is' | 'is not'
  | 'contains' | 'not contains' | 'starts with' | 'like'
  | '>' | '<' | '≥' | '≤'
  | 'is empty' | 'is not empty'
  | 'values'; // column dropdown, see the Rule fields below

export const NUMERIC_OPS: Op[] = ['>', '<', '≥', '≤'];
export const NO_VALUE_OPS: Op[] = ['is empty', 'is not empty'];

export interface Rule {
  col: number;
  op: Op;
  value: string;
  // op 'values' only. Matches when the cell is in `include` (if given), else matches `like` (if given);
  // and is never in `exclude`. Values are compared trimmed and exactly.
  include?: string[];
  like?: string;
  exclude?: string[];
}
export interface SortKey { col: number; dir: 'asc' | 'desc' }

export interface Query {
  id: number;
  filter: { mode: 'all' | 'any'; rules: Rule[] };
  search: string;
  sort: SortKey[];
}

export interface Meta {
  fileName: string;
  sizeBytes: number;
  delimiter?: string;
  header: string[];
  columnTypes: ColumnType[];
  sheets?: string[];
  sheet?: string;
}

export interface RowOut { line: number; cells: string[] }

export type ToEngine =
  | { type: 'query'; query: Query }
  | { type: 'rows'; start: number; count: number }
  | { type: 'selectSheet'; name: string }
  | { type: 'distinct'; reqId: number; col: number; search: string; offset: number; limit: number }
  | { type: 'copyRows'; ranges: [number, number][]; cols?: number[] }; // cols omitted = every column

export type FromWebview = ToEngine | { type: 'ready' } | { type: 'copy'; text: string } | { type: 'reload' };

export type ToWebview =
  | { type: 'meta'; meta: Meta; viewId: number }
  | { type: 'progress'; phase: 'indexing' | 'query'; rowsDone: number; done: boolean; ms?: number; warning?: string }
  | { type: 'queryResult'; id: number; viewId: number; matchCount: number; totalRows: number; ms: number }
  | { type: 'rowsResult'; viewId: number; start: number; rows: RowOut[] }
  | { type: 'distinctResult'; reqId: number; offset: number; values: { v: string; n: number }[]; total: number; truncated: boolean }
  | { type: 'copyText'; text: string; rows: number; truncated: boolean }
  | { type: 'error'; message: string; fatal: boolean };
