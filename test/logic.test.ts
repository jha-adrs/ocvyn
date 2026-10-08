import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextSort, ruleIsValid, ruleLabel, sortLabel } from '../webview/logic.ts';

test('header click: asc → desc → off, replaces other levels', () => {
  let s = nextSort([], 2, false);
  assert.deepEqual(s, [{ col: 2, dir: 'asc' }]);
  s = nextSort(s, 2, false);
  assert.deepEqual(s, [{ col: 2, dir: 'desc' }]);
  assert.deepEqual(nextSort(s, 2, false), []);
  assert.deepEqual(nextSort([{ col: 1, dir: 'asc' }, { col: 2, dir: 'desc' }], 2, false), [{ col: 2, dir: 'asc' }]);
});

test('shift+click: adds the next level and cycles it in place', () => {
  let s = nextSort([{ col: 1, dir: 'asc' }], 3, true);
  assert.deepEqual(s, [{ col: 1, dir: 'asc' }, { col: 3, dir: 'asc' }]);
  s = nextSort(s, 3, true);
  assert.deepEqual(s, [{ col: 1, dir: 'asc' }, { col: 3, dir: 'desc' }]);
  assert.deepEqual(nextSort(s, 3, true), [{ col: 1, dir: 'asc' }]);
});

test('labels and validity', () => {
  const header = ['status', 'amount', 'city'];
  assert.equal(ruleLabel({ col: 0, op: 'is', value: 'paid' }, header), 'status is paid');
  assert.equal(ruleLabel({ col: 0, op: 'is empty', value: '' }, header), 'status is empty');
  assert.equal(sortLabel([{ col: 2, dir: 'asc' }, { col: 1, dir: 'desc' }], header), '↑ city then ↓ amount');
  assert.equal(ruleIsValid({ col: 1, op: '>', value: 'x' }), false);
  assert.equal(ruleIsValid({ col: 1, op: '>', value: '1,000' }), true);
});

test('column dropdown: selection → rule → selection round trip', async () => {
  const { selectionFromRule, valuesRuleFrom, isChecked } = await import('../webview/logic.ts');
  const s = selectionFromRule();
  assert.equal(valuesRuleFrom(2, s), null); // everything ticked = no filter
  s.toggled.add('x');
  assert.deepEqual(valuesRuleFrom(2, s), { col: 2, op: 'values', value: '', exclude: ['x'] });
  s.search = 'pa%';
  assert.deepEqual(valuesRuleFrom(2, s), { col: 2, op: 'values', value: '', like: 'pa%', exclude: ['x'] });
  const none = { search: '', base: 'none' as const, toggled: new Set<string>() };
  assert.equal(valuesRuleFrom(2, none), undefined); // nothing ticked: can't apply
  none.toggled.add('a');
  const r = valuesRuleFrom(2, none)!;
  assert.deepEqual(r, { col: 2, op: 'values', value: '', include: ['a'] });
  const back = selectionFromRule(r);
  assert.equal(isChecked(back, 'a'), true);
  assert.equal(isChecked(back, 'b'), false);
  assert.equal(ruleLabel(r, ['p', 'q', 'status']), 'status: a');
  assert.equal(ruleLabel({ col: 2, op: 'values', value: '', include: ['', 'b', 'c', 'd'] }, ['p', 'q', 's']), 's: (Blanks), b +2');
  assert.equal(ruleLabel({ col: 2, op: 'values', value: '', like: 'pa%', exclude: ['x'] }, ['p', 'q', 's']), 's like pa% except x');
});

test('row selection: click, shift range, ctrl toggle', async () => {
  const { noRows, selectRow, isRowSelected, selectedCount } = await import('../webview/logic.ts');
  let s = selectRow(noRows(), 5, {});
  assert.deepEqual(s.ranges, [[5, 5]]);
  s = selectRow(s, 2, { shift: true });
  assert.deepEqual(s.ranges, [[2, 5]]);
  assert.equal(selectedCount(s), 4);
  s = selectRow(s, 3, { toggle: true }); // punch a hole
  assert.deepEqual(s.ranges, [[2, 2], [4, 5]]);
  assert.equal(isRowSelected(s, 3), false);
  s = selectRow(s, 9, { toggle: true });
  assert.equal(isRowSelected(s, 9), true);
  assert.equal(selectedCount(s), 4);
  s = selectRow(s, 1, {});
  assert.deepEqual(s.ranges, [[1, 1]]);
});
