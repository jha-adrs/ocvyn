// Engine worker: owns one file, builds the row index, runs queries, serves row windows.
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { Meta, Query, ToEngine, ToWebview } from '../protocol.ts';
import { CsvSource, MAX_COLUMNS, MAX_CSV_BYTES } from './csvSource.ts';
import { JsonlSource } from './jsonlSource.ts';
import { distinctValues, likeMatcher, runQuery, type Distinct } from './query.ts';
import type { RowSource } from './types.ts';
import { MAX_XLSX_BYTES, readWorkbook, SheetSource } from './xlsxSource.ts';

const port = parentPort!;
const send = (m: ToWebview) => port.postMessage(m);
const yieldNow = () => new Promise<void>(r => setImmediate(r));

const path: string = workerData.path;
const ext = extname(path).toLowerCase();
const isExcel = ext === '.xlsx' || ext === '.xls';
const isJsonl = ext === '.jsonl' || ext === '.ndjson';
const DELIM_NAMES: Record<number, string> = { 44: 'comma', 9: 'tab', 59: 'semicolon', 124: 'pipe' };

let src: RowSource | undefined;
let baseMeta: Meta | undefined;
let view: Uint32Array | null = null; // null = every row, in file order
let viewId = 0; // bumped whenever `view` or `src` changes
let latestQuery = 0;
let workbook: ReturnType<typeof readWorkbook> | undefined;
let distinctCache = new Map<number, Promise<Distinct>>(); // per column, for the dropdown
let lastSearch: { col: number; search: string; idx: number[] } | undefined;
let markIndexed!: () => void;
const indexed = new Promise<void>(r => (markIndexed = r));

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

function sendMeta() {
  if (src!.header.length > MAX_COLUMNS) throw new Error(`the sheet has ${src!.header.length.toLocaleString('en-US')} columns; OCVYN opens up to ${MAX_COLUMNS.toLocaleString('en-US')}`);
  send({ type: 'meta', viewId, meta: { ...baseMeta!, header: src!.header, columnTypes: src!.columnTypes } });
}

async function start() {
  const size = statSync(path).size;
  const limit = isExcel ? MAX_XLSX_BYTES : MAX_CSV_BYTES;
  if (size > limit) {
    send({ type: 'error', fatal: true, message: `${basename(path)} is ${mb(size)}. OCVYN opens ${isExcel ? 'Excel' : 'CSV'} files up to ${mb(limit)}.` });
    return;
  }
  const buf = readFileSync(path);
  baseMeta = { fileName: basename(path), sizeBytes: size, header: [], columnTypes: [] };
  const t0 = performance.now();

  if (isExcel) {
    workbook = readWorkbook(buf);
    baseMeta.sheets = workbook.SheetNames;
    loadSheet(workbook.SheetNames[0]);
    markIndexed();
    send({ type: 'progress', phase: 'indexing', rowsDone: src!.rowCount, done: true, ms: performance.now() - t0 });
    return;
  }

  // Line-oriented files are indexed in chunks so the first rows show while the rest loads.
  const lines = isJsonl ? new JsonlSource(buf) : new CsvSource(buf, ext === '.tsv');
  src = lines;
  if (lines instanceof CsvSource) baseMeta.delimiter = DELIM_NAMES[lines.delimiter];
  let sentMeta = false;
  while (!lines.indexChunk(8 << 20)) {
    if (!sentMeta && lines.columnTypes.length > 0) { sendMeta(); sentMeta = true; }
    send({ type: 'progress', phase: 'indexing', rowsDone: lines.rowCount, done: false });
    await yieldNow(); // let row requests through while indexing
  }
  if (!sentMeta) sendMeta();
  markIndexed();
  const warning = lines instanceof CsvSource
    ? (lines.unclosedQuote ? 'unclosed quote — last cell runs to end of file' : undefined)
    : (lines.badLines ? `${lines.badLines.toLocaleString('en-US')} of the first 1,000 lines ${lines.badLines === 1 ? 'is' : 'are'} not valid JSON; such lines show empty` : undefined);
  send({ type: 'progress', phase: 'indexing', rowsDone: lines.rowCount, done: true, ms: performance.now() - t0, warning });
}

function loadSheet(name: string) {
  src = new SheetSource(workbook!, name);
  baseMeta!.sheet = name;
  distinctCache = new Map();
  lastSearch = undefined;
  view = null;
  viewId++;
  latestQuery = -1; // a query still running belongs to the old sheet
  sendMeta();
  send({ type: 'progress', phase: 'indexing', rowsDone: src.rowCount, done: true });
}

async function onQuery(q: Query) {
  latestQuery = q.id;
  await indexed;
  if (q.id !== latestQuery) return;
  const t0 = performance.now();
  const s = src!;
  const total = s.rowCount;
  const result = await runQuery(s, q, {
    isStale: () => q.id !== latestQuery,
    onProgress: rowsDone => send({ type: 'progress', phase: 'query', rowsDone, done: false }),
  });
  if (result === undefined || s !== src) return; // superseded, or the sheet changed meanwhile
  view = result;
  viewId++;
  const ms = performance.now() - t0;
  send({ type: 'queryResult', id: q.id, viewId, matchCount: view ? view.length : total, totalRows: total, ms });
  send({ type: 'progress', phase: 'query', rowsDone: total, done: true });
}

const MAX_CELL_CHARS = 10_000; // a multi-MB cell would freeze the grid; copy still gets the full value
const clip = (c: string) => (c.length > MAX_CELL_CHARS ? c.slice(0, MAX_CELL_CHARS) + '…' : c);

function onRows(start: number, count: number) {
  if (!src) return;
  const n = view ? view.length : src.rowCount;
  const end = Math.min(n, start + Math.min(count, 1000));
  const rows = [];
  for (let k = Math.max(0, start); k < end; k++) {
    const i = view ? view[k] : k;
    rows.push({ line: i + 1, cells: src.getRow(i).map(clip) });
  }
  send({ type: 'rowsResult', viewId, start, rows });
}

/** One page of a column's distinct values, narrowed by the dropdown's search / LIKE box. */
async function onDistinct(m: Extract<ToEngine, { type: 'distinct' }>) {
  await indexed;
  const s = src!;
  let d = distinctCache.get(m.col);
  if (!d) distinctCache.set(m.col, (d = distinctValues(s, m.col)));
  const { values, counts, truncated } = await d;
  if (s !== src) return; // sheet changed meanwhile
  const search = m.search.trim();
  let idx: number[] | undefined;
  if (search) {
    if (lastSearch?.col === m.col && lastSearch.search === search) idx = lastSearch.idx;
    else {
      const match = likeMatcher(search);
      idx = [];
      for (let k = 0; k < values.length; k++) if (values[k] !== '' && match(values[k])) idx.push(k);
      lastSearch = { col: m.col, search, idx };
    }
  }
  const total = idx ? idx.length : values.length;
  const page = [];
  for (let j = m.offset; j < Math.min(total, m.offset + m.limit); j++) {
    const k = idx ? idx[j] : j;
    page.push({ v: values[k], n: counts[k] });
  }
  send({ type: 'distinctResult', reqId: m.reqId, offset: m.offset, values: page, total, truncated });
}

const MAX_COPY_ROWS = 100_000;
const tsvCell = (c: string) => (/[\t\n\r"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

/** Selected rows (view positions) as tab-separated text, ready to paste into a spreadsheet. */
function onCopyRows(ranges: [number, number][], cols?: number[]) {
  if (!src) return;
  const n = view ? view.length : src.rowCount;
  const lines: string[] = [];
  let truncated = false;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    for (let k = Math.max(0, a); k <= Math.min(b, n - 1); k++) {
      if (lines.length >= MAX_COPY_ROWS) { truncated = true; break; }
      const cells = src.getRow(view ? view[k] : k);
      lines.push((cols ? cols.map(c => cells[c] ?? '') : cells).map(tsvCell).join('\t'));
    }
  }
  send({ type: 'copyText', text: lines.join('\n'), rows: lines.length, truncated });
}

const fatal = (e: unknown) => send({ type: 'error', fatal: true, message: String((e as Error)?.message ?? e) });
const ints = (...v: unknown[]) => v.every(x => Number.isInteger(x));
const intPairs = (v: unknown): v is [number, number][] => Array.isArray(v) && v.every(p => Array.isArray(p) && p.length === 2 && ints(...p));

// Messages come from our own webview, but a malformed one must not take the worker down.
port.on('message', (m: ToEngine) => {
  try {
    if (m.type === 'query' && m.query?.filter?.rules && m.query.sort) onQuery(m.query).catch(fatal);
    else if (m.type === 'rows' && ints(m.start, m.count)) onRows(m.start, m.count);
    else if (m.type === 'selectSheet' && workbook && workbook.SheetNames.includes(m.name)) loadSheet(m.name);
    else if (m.type === 'distinct' && ints(m.reqId, m.col, m.offset, m.limit) && typeof m.search === 'string') onDistinct({ ...m, limit: Math.min(m.limit, 1000) }).catch(fatal);
    else if (m.type === 'copyRows' && intPairs(m.ranges) && (m.cols === undefined || (ints(...m.cols) && m.cols.length <= MAX_COLUMNS))) onCopyRows(m.ranges, m.cols);
  } catch (e) { fatal(e); }
});

start().catch(fatal);
