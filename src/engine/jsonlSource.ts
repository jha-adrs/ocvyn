import type { ColumnType } from '../protocol.ts';
import { MAX_COLUMNS, MAX_ROWS } from './csvSource.ts';
import { cleanHeader, detectTypes, type RowSource } from './types.ts';

const LF = 10, CR = 13, SPACE = 32, TAB = 9;
const SAMPLE = 1000;
export const VALUE_COL = 'value'; // column for lines that are not objects (numbers, strings, arrays)

/**
 * JSON Lines / NDJSON: one JSON value per line. Lines are indexed by byte offset like CSV records and
 * parsed on demand. Columns are the object keys seen in the first 1000 rows, in order of first appearance;
 * keys that first appear later are not shown. Nested values display as JSON text.
 */
export class JsonlSource implements RowSource {
  header: string[] = [];
  columnTypes: ColumnType[] = [];
  rowCount = 0;
  done = false;
  badLines = 0; // lines in the sample that are not valid JSON; such lines show as empty rows
  readonly buf: Buffer;

  private keys: string[] = [];
  private offsets = new Uint32Array(1 << 16);
  private n = 0;
  private pos: number;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.pos = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  }

  /** Index roughly maxBytes more of the file. Returns true when the whole file is indexed. */
  indexChunk(maxBytes: number): boolean {
    const buf = this.buf, len = buf.length, stop = Math.min(len, this.pos + maxBytes);
    let pos = this.pos;
    while (pos < stop) {
      let nl = buf.indexOf(LF, pos);
      if (nl === -1) nl = len;
      let p = pos;
      while (p < nl && (buf[p] === SPACE || buf[p] === TAB || buf[p] === CR)) p++;
      if (p < nl) this.push(pos); // skip blank lines
      pos = nl + 1;
    }
    this.pos = pos;
    this.rowCount = this.n;
    if (pos >= len) this.done = true;

    if (this.header.length === 0 && this.n > 0 && (this.n >= SAMPLE || this.done)) {
      const seen = new Set<string>();
      const sample: string[][] = [];
      const objs: unknown[] = [];
      for (let i = 0; i < Math.min(SAMPLE, this.n); i++) {
        const o = this.parse(i);
        if (o === undefined) this.badLines++;
        objs.push(o);
        if (isObject(o)) { for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); this.keys.push(k); } }
        else if (!seen.has(VALUE_COL)) { seen.add(VALUE_COL); this.keys.push(VALUE_COL); }
      }
      if (this.keys.length > MAX_COLUMNS) throw new Error(`the file has ${this.keys.length.toLocaleString('en-US')} keys; OCVYN opens up to ${MAX_COLUMNS.toLocaleString('en-US')}`);
      this.header = cleanHeader(this.keys);
      for (const o of objs) sample.push(this.toRow(o));
      this.columnTypes = detectTypes(sample, this.header.length);
    }
    return this.done;
  }

  indexAll(): void { while (!this.indexChunk(1 << 30)); }

  getRow(i: number): string[] { return this.toRow(this.parse(i)); }

  getCell(i: number, col: number): string {
    const o = this.parse(i);
    const k = this.keys[col];
    if (k === undefined) return '';
    if (isObject(o)) return cell(o[k]);
    return k === VALUE_COL ? cell(o) : '';
  }

  private lastR = -1;
  private lastObj: unknown;

  /** Parsed value of line r (cached, since queries read several cells per row). Invalid JSON → undefined. */
  private parse(r: number): unknown {
    if (r === this.lastR) return this.lastObj;
    const end = r + 1 < this.n ? this.offsets[r + 1] : this.pos;
    const text = this.buf.toString('utf8', this.offsets[r], end);
    this.lastR = r;
    try { return (this.lastObj = JSON.parse(text)); }
    catch { return (this.lastObj = undefined); }
  }

  private toRow(o: unknown): string[] {
    if (isObject(o)) return this.keys.map(k => cell(o[k]));
    const row = new Array<string>(this.keys.length).fill('');
    const v = this.keys.indexOf(VALUE_COL);
    if (v >= 0 && o !== undefined) row[v] = cell(o);
    return row;
  }

  private push(off: number) {
    if (this.n === MAX_ROWS) throw new Error(`the file has more than ${MAX_ROWS.toLocaleString('en-US')} lines`);
    if (this.n === this.offsets.length) {
      const next = new Uint32Array(this.offsets.length * 2);
      next.set(this.offsets);
      this.offsets = next;
    }
    this.offsets[this.n++] = off;
  }
}

const isObject = (o: unknown): o is Record<string, unknown> => o !== null && typeof o === 'object' && !Array.isArray(o);

/** How a JSON value shows in a cell: strings as-is, null/undefined blank, anything else as JSON text. */
function cell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
