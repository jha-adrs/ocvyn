import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonlSource } from '../src/engine/jsonlSource.ts';
import { distinctValues, runQuery } from '../src/engine/query.ts';

const LINES = [
  '{"id":1,"name":"Ann","tags":["a","b"],"meta":{"x":1}}',
  '',
  '{"id":2,"name":"Bob","active":true,"score":9.5}',
  '  {"id":3,"name":null,"score":"7"}',
  'not json',
  '42',
];

test('keys become columns in order of first appearance; nested values show as JSON', () => {
  const src = new JsonlSource(Buffer.from('﻿' + LINES.join('\n') + '\n'));
  src.indexAll();
  assert.deepEqual(src.header, ['id', 'name', 'tags', 'meta', 'active', 'score', 'value']);
  assert.equal(src.rowCount, 5); // the blank line is skipped
  assert.deepEqual(src.getRow(0), ['1', 'Ann', '["a","b"]', '{"x":1}', '', '', '']);
  assert.deepEqual(src.getRow(1), ['2', 'Bob', '', '', 'true', '9.5', '']);
  assert.equal(src.getRow(2)[1], ''); // null is blank
  assert.deepEqual(src.getRow(3), ['', '', '', '', '', '', '']); // invalid line
  assert.equal(src.getRow(4)[6], '42'); // a bare value goes in `value`
  assert.equal(src.getCell(1, 5), '9.5');
  assert.equal(src.getCell(4, 6), '42');
  assert.equal(src.getCell(4, 0), '');
  assert.equal(src.columnTypes[0], 'number');
  assert.equal(src.columnTypes[1], 'text');
  assert.equal(src.badLines, 1);
});

test('CRLF, no trailing newline, and chunked indexing agree', () => {
  const text = LINES.filter(Boolean).join('\r\n');
  const whole = new JsonlSource(Buffer.from(text));
  whole.indexAll();
  const chunked = new JsonlSource(Buffer.from(text));
  while (!chunked.indexChunk(16));
  assert.equal(whole.rowCount, 5);
  assert.deepEqual(chunked.header, whole.header);
  for (let i = 0; i < whole.rowCount; i++) assert.deepEqual(chunked.getRow(i), whole.getRow(i));
});

test('filter, sort and distinct work on a JSONL source', async () => {
  const src = new JsonlSource(Buffer.from(LINES.join('\n')));
  src.indexAll();
  const q = { id: 1, filter: { mode: 'all' as const, rules: [{ col: 5, op: '>' as const, value: '8' }] }, search: '', sort: [] };
  assert.deepEqual([...(await runQuery(src, q, { isStale: () => false }))!], [1]);
  const sorted = await runQuery(src, { ...q, filter: { mode: 'all', rules: [] }, sort: [{ col: 0, dir: 'desc' }] }, { isStale: () => false });
  assert.deepEqual([...sorted!], [2, 1, 0, 3, 4]); // blanks last
  const d = await distinctValues(src, 1);
  assert.deepEqual(d.values, ['Ann', 'Bob', '']);
});
