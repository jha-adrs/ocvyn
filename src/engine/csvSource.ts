import type { ColumnType } from '../protocol.ts';
import { cleanHeader, detectTypes, fitRow, type RowSource } from './types.ts';

export const MAX_CSV_BYTES = 500 * 1024 * 1024;
export const MAX_COLUMNS = 10_000;
export const MAX_ROWS = 50_000_000; // keeps the offset index and query arrays under ~1 GB

const LF = 10, CR = 13, QUOTE = 34;
const CANDIDATES = [44, 9, 59, 124]; // , \t ; |

/** A quote only opens a quoted field at the start of a field (RFC 4180); `5" pipe` is plain text. */
const fieldStart = (prev: number) => prev === LF || prev === CR || CANDIDATES.includes(prev);

/** Pick the delimiter whose per-line count is most consistent over the first 64 KB. */
export function detectDelimiter(buf: Buffer, start: number, nl = LF): number {
  const end = Math.min(buf.length, start + 65536);
  const lines: Map<number, number>[] = [];
  let cur = new Map<number, number>();
  let inQuote = false;
  for (let i = start; i < end && lines.length < 50; i++) {
    const b = buf[i];
    if (b === QUOTE) { if (inQuote || i === start || fieldStart(buf[i - 1])) inQuote = !inQuote; }
    else if (!inQuote && b === nl) { lines.push(cur); cur = new Map(); }
    else if (!inQuote && CANDIDATES.includes(b)) cur.set(b, (cur.get(b) ?? 0) + 1);
  }
  if (end === buf.length) lines.push(cur); // last line is complete only if we reached EOF
  let best = 44, bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map(l => l.get(d) ?? 0);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter(c => c === first).length / counts.length;
    const score = consistent * 1000 + Math.min(first, 999);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

export class CsvSource implements RowSource {
  header: string[] = [];
  columnTypes: ColumnType[] = [];
  rowCount = 0;
  done = false;
  unclosedQuote = false;
  readonly delimiter: number;
  readonly buf: Buffer;
  private readonly delimChar: string;
  private readonly nl: number; // record terminator byte: LF, or CR for old Mac files with no LF at all

  private offsets = new Uint32Array(1 << 16); // start byte of each record, header included
  private nRecords = 0;
  private pos: number;
  private nq: number; // position of next quote at or after pos, or -1

  constructor(buf: Buffer, isTsv = false) {
    this.buf = buf;
    const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
    this.pos = start;
    this.nq = buf.indexOf(QUOTE, start);
    this.nl = buf.indexOf(LF, start) === -1 && buf.indexOf(CR, start) !== -1 ? CR : LF;
    this.delimiter = isTsv ? 9 : detectDelimiter(buf, start, this.nl);
    this.delimChar = String.fromCharCode(this.delimiter);
  }

  /** Index roughly maxBytes more of the file. Returns true when the whole file is indexed. */
  indexChunk(maxBytes: number): boolean {
    const buf = this.buf, len = buf.length, stop = Math.min(len, this.pos + maxBytes);
    const NL = this.nl, delim = this.delimiter;
    let pos = this.pos, nq = this.nq, nl = -1;
    while (pos < stop) {
      const b = buf[pos];
      if (b === NL) { pos++; continue; } // skip blank lines
      if (b === CR && buf[pos + 1] === LF) { pos += 2; continue; }
      const rec = pos;
      this.push(pos);
      // Walk to the end of this record: the first newline that is not inside quotes.
      for (;;) {
        if (nq !== -1 && nq < pos) nq = buf.indexOf(QUOTE, pos);
        if (nl < pos) { nl = buf.indexOf(NL, pos); if (nl === -1) nl = len; }
        if (nq !== -1 && nq < nl) {
          if (nq !== rec && buf[nq - 1] !== delim) { nq = buf.indexOf(QUOTE, nq + 1); continue; } // stray quote inside a field
          let q = nq + 1, close: number;
          for (;;) {
            close = buf.indexOf(QUOTE, q);
            if (close !== -1 && buf[close + 1] === QUOTE) { q = close + 2; continue; }
            break;
          }
          if (close === -1) { this.unclosedQuote = true; pos = len; break; }
          pos = close + 1;
          nq = buf.indexOf(QUOTE, pos);
          continue;
        }
        pos = nl + 1;
        break;
      }
    }
    this.pos = pos;
    this.nq = nq;
    if (pos >= len) this.done = true;

    if (this.header.length === 0 && this.nRecords > 0) {
      this.header = cleanHeader(this.record(0));
      if (this.header.length > MAX_COLUMNS) throw new Error(`the file has ${this.header.length.toLocaleString('en-US')} columns; OCVYN opens up to ${MAX_COLUMNS.toLocaleString('en-US')}`);
    }
    this.rowCount = Math.max(0, this.nRecords - 1);
    if (this.columnTypes.length === 0 && this.header.length > 0 && (this.rowCount >= 1000 || this.done)) {
      const sample: string[][] = [];
      for (let i = 0; i < Math.min(1000, this.rowCount); i++) sample.push(this.getRow(i));
      this.columnTypes = detectTypes(sample, this.header.length);
    }
    return this.done;
  }

  indexAll(): void { while (!this.indexChunk(1 << 30)); }

  getRow(i: number): string[] {
    return fitRow(this.record(i + 1), this.header.length);
  }

  getCell(i: number, col: number): string {
    const raw = this.rawRecord(i + 1);
    const d = this.delimChar;
    if (raw.indexOf('"') !== -1) return parseQuoted(trimNewlines(raw), d, col)[col] ?? '';
    let p = 0;
    for (let c = 0; c < col; c++) {
      p = raw.indexOf(d, p) + 1;
      if (p === 0) return '';
    }
    const e = raw.indexOf(d, p);
    return e === -1 ? trimNewlines(raw.slice(p)) : raw.slice(p, e);
  }

  /** Raw text of row i, up to (and including) the newlines before the next record. */
  getRaw(i: number): string {
    return this.rawRecord(i + 1);
  }

  private lastR = -1;
  private lastRaw = '';

  /** Decoded text of record r. The last one is cached, since queries read several cells per row. */
  private rawRecord(r: number): string {
    if (r === this.lastR) return this.lastRaw;
    const end = r + 1 < this.nRecords ? this.offsets[r + 1] : this.pos;
    this.lastR = r;
    return (this.lastRaw = this.buf.toString('utf8', this.offsets[r], end));
  }

  private record(r: number): string[] {
    const raw = trimNewlines(this.rawRecord(r));
    return raw.indexOf('"') === -1 ? raw.split(this.delimChar) : parseQuoted(raw, this.delimChar, Infinity);
  }

  private push(off: number) {
    if (this.nRecords === MAX_ROWS) throw new Error(`the file has more than ${MAX_ROWS.toLocaleString('en-US')} rows`);
    if (this.nRecords === this.offsets.length) {
      const next = new Uint32Array(this.offsets.length * 2);
      next.set(this.offsets);
      this.offsets = next;
    }
    this.offsets[this.nRecords++] = off;
  }
}

function trimNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charCodeAt(end - 1) === LF || s.charCodeAt(end - 1) === CR)) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** RFC 4180 parse of one record's text (quoted delimiters, "" escapes, newlines inside quotes). */
function parseQuoted(raw: string, d: string, maxCol: number): string[] {
  const out: string[] = [];
  const len = raw.length;
  let p = 0;
  for (;;) {
    let s: string;
    if (raw.charCodeAt(p) === QUOTE) {
      let q = p + 1;
      s = '';
      for (;;) {
        const c = raw.indexOf('"', q);
        if (c === -1) { s += raw.slice(q); p = len; break; } // unclosed quote
        if (raw.charCodeAt(c + 1) === QUOTE) { s += raw.slice(q, c + 1); q = c + 2; continue; }
        s += raw.slice(q, c);
        p = c + 1;
        break;
      }
      const nd = raw.indexOf(d, p); // skip any junk after the closing quote
      p = nd === -1 ? len : nd;
    } else {
      const nd = raw.indexOf(d, p);
      const e = nd === -1 ? len : nd;
      s = raw.slice(p, e);
      p = e;
    }
    out.push(s);
    if (out.length > maxCol || p >= len) return out;
    p++; // skip delimiter
  }
}
