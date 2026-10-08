import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from 'xlsx';
import { readWorkbook, SheetSource } from '../src/engine/xlsxSource.ts';

test('two-sheet workbook: sheet list, header, rows, types', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'qty'], ['pen', 3], ['ink', 12.5]]), 'Stock');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['city', ''], ['Pune', 'x', 'extra']]), 'Places');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const book = readWorkbook(buf);
  assert.deepEqual(book.SheetNames, ['Stock', 'Places']);

  const stock = new SheetSource(book, 'Stock');
  assert.deepEqual(stock.header, ['name', 'qty']);
  assert.equal(stock.rowCount, 2);
  assert.deepEqual(stock.getRow(1), ['ink', '12.5']);
  assert.deepEqual(stock.columnTypes, ['text', 'number']);

  const places = new SheetSource(book, 'Places');
  assert.deepEqual(places.header, ['city', 'column_2', 'column_3']);
  assert.deepEqual(places.getRow(0), ['Pune', 'x', 'extra']);
});
