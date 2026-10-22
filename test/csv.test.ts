import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CsvSource, detectDelimiter } from '../src/engine/csvSource.ts';
import { cleanHeader, detectTypes, parseNum } from '../src/engine/types.ts';

const load = (text: string | Buffer, tsv = false) => {
  const s = new CsvSource(Buffer.isBuffer(text) ? text : Buffer.from(text), tsv);
  s.indexAll();
  return s;
};
const rows = (s: CsvSource) => Array.from({ length: s.rowCount }, (_, i) => s.getRow(i));

test('basic rows, LF and CRLF', () => {
  for (const nl of ['\n', '\r\n']) {
    const s = load(['a,b', '1,2', '3,4', ''].join(nl));
    assert.deepEqual(s.header, ['a', 'b']);
    assert.deepEqual(rows(s), [['1', '2'], ['3', '4']]);
  }
});

test('quoted delimiter, "" escape, newline inside quotes', () => {
  const s = load('a,b\n"x,y","say ""hi"""\n"line1\nline2",z\n');
  assert.deepEqual(rows(s), [['x,y', 'say "hi"'], ['line1\nline2', 'z']]);
});

test('quoted field followed by CRLF', () => {
  const s = load('a,b\r\n1,"q"\r\n2,3\r\n');
  assert.deepEqual(rows(s), [['1', 'q'], ['2', '3']]);
});

test('BOM is stripped', () => {
  const s = load(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name,age\nann,3\n')]));
  assert.deepEqual(s.header, ['name', 'age']);
});

test('ragged rows are padded and truncated', () => {
  const s = load('a,b,c\n1\n1,2,3,4\n');
  assert.deepEqual(rows(s), [['1', '', ''], ['1', '2', '3']]);
});

test('empty and duplicate headers become column_N', () => {
  const s = load('id,,id\n1,2,3\n');
  assert.deepEqual(s.header, ['id', 'column_2', 'column_3']);
});

test('blank lines are skipped, no trailing newline is fine', () => {
  const s = load('a\n1\n\n\r\n2');
  assert.deepEqual(rows(s), [['1'], ['2']]);
});

test('unclosed quote runs to end of file and is flagged', () => {
  const s = load('a,b\n1,"oops\n2,3\n');
  assert.equal(s.unclosedQuote, true);
  assert.deepEqual(rows(s), [['1', 'oops\n2,3']]);
});

test('header only and empty file', () => {
  assert.equal(load('a,b\n').rowCount, 0);
  const e = load('');
  assert.equal(e.rowCount, 0);
  assert.deepEqual(e.header, []);
});

test('delimiter detection', () => {
  const det = (t: string) => String.fromCharCode(detectDelimiter(Buffer.from(t), 0));
  assert.equal(det('a,b,c\n1,2,3\n'), ',');
  assert.equal(det('a\tb\n1\t2\n'), '\t');
  assert.equal(det('a;b;c\n1,5;2;3\n'), ';');
  assert.equal(det('a|b\n1|2\n'), '|');
  assert.equal(det('"x;y",b\n"1;2",3\n'), ',');
  assert.equal(load('a,b\tc\n1,2\t3\n', true).getRow(0).length, 2); // .tsv forces tab
});

test('incremental indexing exposes rows before done', () => {
  const text = 'n\n' + Array.from({ length: 5000 }, (_, i) => i).join('\n') + '\n';
  const s = new CsvSource(Buffer.from(text));
  assert.equal(s.indexChunk(5000), false);
  assert.ok(s.rowCount > 0 && s.rowCount < 5000);
  assert.deepEqual(s.getRow(10), ['10']);
  while (!s.indexChunk(5000));
  assert.equal(s.rowCount, 5000);
  assert.deepEqual(s.getRow(4999), ['4999']);
});

test('getCell picks one column, getRaw returns the record text', () => {
  const s = load('a,b,c\n1,2,3\r\n4,5\n');
  assert.deepEqual([0, 1, 2].map(c => s.getCell(0, c)), ['1', '2', '3']);
  assert.deepEqual([0, 1, 2].map(c => s.getCell(1, c)), ['4', '5', '']);
  assert.deepEqual(load('a,b\n"x,1","y"\n').getCell(0, 1), 'y');
  assert.equal(s.getRaw(0), '1,2,3\r\n');
});

test('type detection', () => {
  assert.equal(parseNum('1,234.5'), 1234.5);
  assert.ok(Number.isNaN(parseNum('abc')));
  assert.ok(Number.isNaN(parseNum('  ')));
  const types = detectTypes(
    [['1', 'x', '1,000', '', '2024-01-01'], ['2.5', '3', '-4', '', '2024-01-02'], ['', 'y', '7', '5', '2024-01-03']],
    5,
  );
  assert.deepEqual(types, ['number', 'text', 'number', 'number', 'text']);
  assert.deepEqual(detectTypes([[''], ['']], 1), ['text']); // all empty
});

test('a stray quote inside a field does not swallow the rest of the file', () => {
  const src = new CsvSource(Buffer.from('name\tsize\nA\t5" pipe\nB\t6\nC\t7\n'), true);
  src.indexAll();
  assert.equal(src.rowCount, 3);
  assert.equal(src.unclosedQuote, false);
  assert.deepEqual(src.getRow(0), ['A', '5" pipe']);
  assert.deepEqual(src.getRow(2), ['C', '7']);
});

test('CR-only line endings', () => {
  const src = new CsvSource(Buffer.from('a,b\r1,2\r3,4\r'));
  src.indexAll();
  assert.deepEqual(src.header, ['a', 'b']);
  assert.equal(src.rowCount, 2);
  assert.deepEqual(src.getRow(1), ['3', '4']);
});

test('parseNum rejects decimal commas, lists and hex', () => {
  assert.equal(parseNum('1,000'), 1000);
  assert.equal(parseNum(' 42 '), 42);
  assert.equal(parseNum('1e5'), 100000);
  assert.equal(parseNum('-.5'), -0.5);
  for (const bad of ['3,14', '1,2,3', '0x1A', '0b11', 'Infinity', '-', '']) assert.ok(Number.isNaN(parseNum(bad)), bad);
});

test('cleanHeader never produces duplicate names', () => {
  assert.deepEqual(cleanHeader(['column_3', 'b', '']), ['column_3', 'b', 'column_3_2']);
});
