import * as XLSX from 'xlsx';
import type { ColumnType } from '../protocol.ts';
import { cleanHeader, detectTypes, fitRow, type RowSource } from './types.ts';

export const MAX_XLSX_BYTES = 50 * 1024 * 1024;

export function readWorkbook(buf: Buffer): XLSX.WorkBook {
  return XLSX.read(buf, { type: 'buffer', dense: true });
}

/** One sheet of a workbook, converted to strings and held in memory. */
export class SheetSource implements RowSource {
  header: string[];
  columnTypes: ColumnType[];
  rowCount: number;
  private rows: string[][];

  constructor(wb: XLSX.WorkBook, sheet: string) {
    const all = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, raw: false, defval: '', blankrows: false });
    const str = all.map(r => r.map(v => (v == null ? '' : String(v))));
    const width = str.reduce((w, r) => Math.max(w, r.length), 0);
    this.header = cleanHeader(fitRow(str[0] ?? [], width));
    this.rows = str.slice(1).map(r => fitRow(r, width));
    this.rowCount = this.rows.length;
    this.columnTypes = detectTypes(this.rows.slice(0, 1000), width);
  }

  getRow(i: number): string[] { return this.rows[i]; }
  getCell(i: number, col: number): string { return this.rows[i][col] ?? ''; }
}
