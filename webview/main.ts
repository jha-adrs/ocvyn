import type { FromWebview, Meta, Op, Rule, RowOut, SortKey, ToWebview } from '../src/protocol.ts';
import {
  isChecked, isRowSelected, needsValue, nextSort, noRows, ruleIsValid, ruleLabel, selectedCount, selectionFromRule, selectRow,
  sortLabel, valuesRuleFrom,
} from './logic.ts';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

const ROW_H = 22;
const HEAD_H = 30;
const LINE_W = 72;
const BLOCK = 100; // rows per request / cache entry
const MAX_CACHE = 60; // blocks
const MAX_SPACER = 10_000_000; // browsers cap element height; scale scrolling beyond this
const PALETTE = 8; // rainbow column colours, see .c0–.c7 in style.css
const PAGE = 200; // distinct values per dropdown page
const OPS: Op[] = ['is', 'is not', 'contains', 'not contains', 'starts with', 'like', '>', '<', '≥', '≤', 'is empty', 'is not empty'];

// ---- state ----
let meta: Meta | undefined;
let viewId = 0;
let count = 0; // rows in the current view
let totalRows = 0;
let identityView = true; // current view is "all rows, file order"
let indexingDone = false;
let indexMs = 0;
let warning = '';
let querying = false;
let rules: Rule[] = [];
let mode: 'all' | 'any' = 'all';
let search = '';
let sort: SortKey[] = [];
let queryId = 0;
let widths: number[] = [];
let sel: { k: number; col: number; line: number; value: string } | undefined;
let rowSel = noRows(); // highlighted rows (view positions)
let rowMode = false; // rows were picked via the row-number column, so ⌘C copies whole rows
let frozen = 0; // leading columns that stay put when scrolling sideways
let colSel: number | undefined; // selected column (header click)
let hoverY: number | undefined; // mouse position, so the hover highlight survives re-renders
let notice = '';
let copyWhat = 'row'; // what the pending copyRows request copies, for the footer message
const cache = new Map<number, RowOut[]>();
const pending = new Set<number>();

// ---- DOM ----
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const app = document.getElementById('app')!;
const top = h('div', 'top');
const bar = h('div', 'bar');
const progress = h('div', 'progress');
const scroller = h('div', 'scroller');
const inner = h('div', 'inner');
const head = h('div', 'head');
const body = h('div', 'body');
const footer = h('div', 'footer');
inner.append(head, body);
scroller.append(inner);
app.append(top, bar, progress, scroller, footer);

const searchBox = h('input', 'search') as HTMLInputElement;
searchBox.placeholder = 'Search all columns  ⌘F';
let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchBox.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { search = searchBox.value; sendQuery(); }, 250);
});

// ---- messages ----
window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'meta': {
      const sheetChanged = meta && meta.sheet !== m.meta.sheet;
      meta = m.meta;
      viewId = m.viewId;
      if (sheetChanged) {
        rules = []; sort = []; search = ''; searchBox.value = ''; identityView = true;
        queryId++; querying = false; // drop a query that was still running on the old sheet
        frozen = 0; scroller.scrollTop = 0;
      }
      widths = meta.header.map((name, c) => Math.min(320, Math.max(meta!.columnTypes[c] === 'number' ? 90 : 120, name.length * 8 + 64)));
      resetView();
      renderAll();
      break;
    }
    case 'progress': {
      const before = `${count}|${querying}|${indexingDone}`;
      if (m.phase === 'indexing') {
        totalRows = m.rowsDone;
        if (identityView) count = m.rowsDone;
        indexingDone = m.done;
        if (m.ms != null) indexMs = m.ms;
        if (m.warning) warning = m.warning;
      } else {
        querying = !m.done;
      }
      // Only redraw the grid when something it shows changed: a redraw wipes text the user is selecting.
      if (`${count}|${querying}|${indexingDone}` !== before) { renderBar(); renderBody(); }
      renderFooter();
      break;
    }
    case 'queryResult':
      if (m.id !== queryId) return;
      querying = false;
      viewId = m.viewId;
      count = m.matchCount;
      totalRows = m.totalRows;
      identityView = rules.length === 0 && !search.trim() && sort.length === 0;
      scroller.scrollTop = 0;
      resetView();
      renderAll();
      break;
    case 'rowsResult':
      if (m.viewId !== viewId) return;
      pending.delete(m.start / BLOCK);
      cache.set(m.start / BLOCK, m.rows);
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
      renderBody();
      break;
    case 'copyText':
      post({ type: 'copy', text: m.text });
      flash(`Copied ${m.rows.toLocaleString('en-US')} ${copyWhat}${m.rows === 1 ? '' : 's'}${m.truncated ? ' (limit is 100,000)' : ''}`);
      break;
    case 'distinctResult':
      onDistinct?.(m);
      break;
    case 'error':
      if (m.fatal) showFatal(m.message);
      else { warning = m.message; renderFooter(); }
      break;
  }
});

function resetView() {
  cache.clear();
  pending.clear();
  sel = undefined;
  rowSel = noRows();
  rowMode = false;
  colSel = undefined;
}

function sendQuery() {
  queryId++;
  querying = true;
  post({ type: 'query', query: { id: queryId, filter: { mode, rules }, search, sort } });
  renderBar();
  renderHead();
}

// ---- top row ----
function renderTop() {
  top.replaceChildren();
  if (!meta) return;
  const kb = meta.sizeBytes / 1024;
  const size = kb < 1024 ? `${Math.ceil(kb)} KB` : kb < 10240 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb / 1024)} MB`;
  top.append(
    h('span', 'name', meta.fileName),
    h('span', 'badge', 'read-only'),
    h('span', 'dim', `${size} · ${meta.header.length} columns`),
  );
  if (meta.sheets && meta.sheets.length > 1) {
    const pick = h('select', 'sheet') as HTMLSelectElement;
    for (const s of meta.sheets) pick.append(new Option(s, s, false, s === meta.sheet));
    pick.addEventListener('change', () => post({ type: 'selectSheet', name: pick.value }));
    top.append(pick);
  }
  top.append(h('span', 'grow'), searchBox);
}

// ---- filter bar ----
function renderBar() {
  bar.replaceChildren();
  progress.classList.toggle('on', !indexingDone || querying);
  if (!meta) return;
  rules.forEach((r, i) => {
    if (i > 0) bar.append(h('span', 'joiner', mode === 'all' ? 'and' : 'or'));
    const pill = h('span', ruleIsValid(r) ? 'pill' : 'pill bad');
    pill.append(h('span', '', ruleLabel(r, meta!.header)));
    const x = h('span', 'x', '×');
    x.addEventListener('click', e => { e.stopPropagation(); rules = rules.filter((_, j) => j !== i); sendQuery(); });
    pill.append(x);
    pill.addEventListener('click', e => {
      e.stopPropagation();
      if (r.op === 'values') openColumnFilter(r.col);
      else openPopover();
    });
    bar.append(pill);
  });
  const add = h('span', 'pill add', '+ Filter');
  add.addEventListener('click', () => openPopover(true));
  bar.append(add);
  if (sort.length > 0) {
    const pill = h('span', 'pill sort');
    pill.append(h('span', '', sortLabel(sort, meta.header)));
    const x = h('span', 'x', '×');
    x.addEventListener('click', () => { sort = []; sendQuery(); });
    pill.append(x);
    bar.append(pill);
  }
  if (frozen > 0) {
    const pill = h('span', 'pill frozen-pill');
    pill.append(h('span', '', `❄ Frozen: ${meta.header.slice(0, frozen).join(', ')}`));
    const x = h('span', 'x', '×');
    x.title = 'Unfreeze columns';
    x.addEventListener('click', () => setFrozen(0));
    pill.append(x);
    bar.append(pill);
  }
  bar.append(h('span', 'grow'));
  const n = (x: number) => x.toLocaleString('en-US');
  bar.append(h('span', 'count', identityView ? `${n(count)} rows` : `${n(count)} / ${n(totalRows)}`));
}

// ---- filter popover ----
let popover: HTMLElement | undefined;

function openPopover(addRow = false) {
  closePopover();
  if (!meta) return;
  const header = meta.header;
  let draftMode = mode;
  const kept = rules.filter(r => r.op === 'values'); // edited in the column dropdown, not here
  const draft: Rule[] = rules.filter(r => r.op !== 'values').map(r => ({ ...r }));
  if (addRow || draft.length === 0) draft.push({ col: 0, op: 'contains', value: '' });

  const pop = h('div', 'popover');
  popover = pop;
  const apply = () => {
    mode = draftMode;
    rules = [...kept, ...draft.filter(r => !needsValue(r.op) || r.value.trim() !== '')];
    closePopover();
    sendQuery();
  };

  const draw = () => {
    pop.replaceChildren();
    const title = h('div', 'pop-title');
    const modeSel = h('select') as HTMLSelectElement;
    modeSel.append(new Option('all', 'all', false, draftMode === 'all'), new Option('any', 'any', false, draftMode === 'any'));
    modeSel.addEventListener('change', () => { draftMode = modeSel.value as 'all' | 'any'; });
    title.append('Where ', modeSel, ' match');
    pop.append(title);
    draft.forEach((r, i) => {
      const row = h('div', 'pop-row');
      const colSel = h('select') as HTMLSelectElement;
      header.forEach((name, c) => colSel.append(new Option(name, String(c), false, c === r.col)));
      colSel.addEventListener('change', () => { r.col = Number(colSel.value); });
      const opSel = h('select') as HTMLSelectElement;
      OPS.forEach(op => opSel.append(new Option(op, op, false, op === r.op)));
      opSel.addEventListener('change', () => { r.op = opSel.value as Op; draw(); });
      const val = h('input') as HTMLInputElement;
      val.value = r.value;
      val.placeholder = 'value';
      val.addEventListener('input', () => { r.value = val.value; val.classList.toggle('bad', !ruleIsValid(r)); });
      val.classList.toggle('bad', !ruleIsValid(r));
      val.style.visibility = needsValue(r.op) ? 'visible' : 'hidden';
      const del = h('span', 'x', '×');
      del.addEventListener('click', () => { draft.splice(i, 1); draw(); });
      row.append(colSel, opSel, val, del);
      pop.append(row);
    });
    const actions = h('div', 'pop-actions');
    const addBtn = h('span', 'link', '+ Add rule');
    addBtn.addEventListener('click', () => { draft.push({ col: 0, op: 'contains', value: '' }); draw(); });
    const applyBtn = h('button', '', 'Apply');
    applyBtn.addEventListener('click', apply);
    actions.append(addBtn, h('span', 'grow'), applyBtn);
    pop.append(actions);
    const inputs = pop.querySelectorAll('input');
    (inputs[inputs.length - 1] as HTMLInputElement | undefined)?.focus();
  };

  pop.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); apply(); }
  });
  pop.addEventListener('mousedown', e => e.stopPropagation());
  draw();
  pop.style.top = `${bar.offsetTop + bar.offsetHeight + 2}px`;
  app.append(pop);
}

function closePopover() {
  popover?.remove();
  popover = undefined;
  onDistinct = undefined;
  clearTimeout(distinctTimer);
}

// ---- column dropdown (Excel-style value list + search / LIKE) ----
let onDistinct: ((m: Extract<ToWebview, { type: 'distinctResult' }>) => void) | undefined;
let distinctReq = 0;
let distinctTimer: ReturnType<typeof setTimeout> | undefined; // search-box debounce in the dropdown

function openColumnFilter(col: number) {
  closePopover();
  if (!meta) return;
  const anchor = head.children[col + 1] as HTMLElement | undefined;
  const existing = rules.find(r => r.col === col && r.op === 'values');
  const sel = selectionFromRule(existing);
  let items: { v: string; n: number }[] = [];
  let total = 0;
  let truncated = false;
  let reqId = 0;
  let loading = false;
  let loaded = false; // first page of values arrived

  const pop = h('div', 'popover colpop');
  popover = pop;
  const title = h('div', 'pop-title', meta.header[col]);
  const box = h('input', 'colsearch') as HTMLInputElement;
  box.placeholder = 'Search, or LIKE pattern: pa%  %ing  a_c%';
  box.value = sel.search;
  const allRow = h('label', 'vrow all');
  const allBox = h('input') as HTMLInputElement;
  allBox.type = 'checkbox';
  const allText = h('span', 'vtext');
  allRow.append(allBox, allText);
  const list = h('div', 'vlist');
  const status = h('div', 'pop-title');
  const actions = h('div', 'pop-actions');
  const clear = h('span', 'link', 'Clear filter');
  const cancel = h('button', 'secondary', 'Cancel');
  const applyBtn = h('button', '', 'Apply') as HTMLButtonElement;
  actions.append(existing ? clear : '', h('span', 'grow'), cancel, applyBtn);
  const freeze = h('div', 'pop-freeze');
  if (frozen !== col + 1) {
    const f = h('span', 'link', 'Freeze columns up to here');
    f.addEventListener('click', () => { closePopover(); setFrozen(col + 1); });
    freeze.append(f);
  }
  if (frozen > 0) {
    const u = h('span', 'link', 'Unfreeze columns');
    u.addEventListener('click', () => { closePopover(); setFrozen(0); });
    freeze.append(u);
  }
  pop.append(title, freeze, box, allRow, list, status, actions);

  const syncHeader = () => {
    allBox.checked = sel.base === 'all' && sel.toggled.size === 0;
    allBox.indeterminate = sel.toggled.size > 0;
    allText.textContent = sel.search.trim() ? 'Select all matching' : 'Select all';
    applyBtn.disabled = valuesRuleFrom(col, sel) === undefined;
    const n = total.toLocaleString('en-US');
    status.textContent = !loaded ? 'Loading values…'
      : `${n} value${total === 1 ? '' : 's'}${truncated ? ' · column has more than 500,000 distinct values; only those are listed' : ''}`;
  };
  const addItems = (page: { v: string; n: number }[]) => {
    for (const it of page) {
      const row = h('label', 'vrow');
      const cb = h('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = isChecked(sel, it.v);
      cb.addEventListener('change', () => {
        if (sel.toggled.has(it.v)) sel.toggled.delete(it.v); else sel.toggled.add(it.v);
        syncHeader();
      });
      row.append(cb, h('span', it.v === '' ? 'vtext dim' : 'vtext', it.v === '' ? '(Blanks)' : it.v), h('span', 'vcount', it.n.toLocaleString('en-US')));
      list.append(row);
    }
  };
  const load = (reset: boolean) => {
    if (reset) { items = []; list.replaceChildren(); list.scrollTop = 0; loading = false; }
    if (loading) return;
    loading = true;
    reqId = ++distinctReq;
    post({ type: 'distinct', reqId, col, search: sel.search, offset: items.length, limit: PAGE });
  };
  onDistinct = m => {
    if (m.reqId !== reqId || m.offset !== items.length) return;
    loading = false;
    loaded = true;
    items.push(...m.values);
    total = m.total;
    truncated = m.truncated;
    addItems(m.values);
    syncHeader();
  };
  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight > list.scrollHeight - 80 && items.length < total) load(false);
  });
  // Typing resets to "all matching ticked", like Excel. Apply/Enter inside the debounce must see the same state.
  const takeSearch = () => {
    clearTimeout(distinctTimer);
    if (sel.search === box.value) return false;
    sel.search = box.value; sel.base = 'all'; sel.toggled.clear();
    return true;
  };
  box.addEventListener('input', () => {
    clearTimeout(distinctTimer);
    distinctTimer = setTimeout(() => { if (takeSearch()) load(true); }, 200);
  });
  allBox.addEventListener('change', () => {
    sel.base = allBox.checked ? 'all' : 'none';
    sel.toggled.clear();
    for (const cb of list.querySelectorAll('input')) (cb as HTMLInputElement).checked = allBox.checked;
    syncHeader();
  });
  const apply = () => {
    takeSearch();
    const r = valuesRuleFrom(col, sel);
    if (r === undefined) return;
    rules = rules.filter(x => !(x.col === col && x.op === 'values'));
    if (r) rules.push(r);
    closePopover();
    sendQuery();
  };
  applyBtn.addEventListener('click', apply);
  cancel.addEventListener('click', () => closePopover());
  clear.addEventListener('click', () => { rules = rules.filter(x => x !== existing); closePopover(); sendQuery(); });
  pop.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); apply(); }
  });
  pop.addEventListener('mousedown', e => e.stopPropagation());

  app.append(pop);
  const a = anchor?.getBoundingClientRect();
  const left = a ? Math.min(Math.max(0, a.left), app.clientWidth - pop.offsetWidth - 8) : 12;
  pop.style.left = `${Math.max(0, left)}px`;
  pop.style.top = `${a ? a.bottom + 2 : bar.offsetTop + bar.offsetHeight + 2}px`;
  syncHeader();
  load(true);
  box.focus();
}
document.addEventListener('mousedown', () => closePopover());

// ---- grid ----
const totalWidth = () => LINE_W + widths.reduce((a, b) => a + b, 0);

/** Pin column c to the left if it is frozen. */
function applyFreeze(cell: HTMLElement, c: number) {
  if (c >= frozen) return;
  let left = LINE_W;
  for (let i = 0; i < c; i++) left += widths[i];
  cell.classList.add('frozen');
  if (c === frozen - 1) cell.classList.add('frozen-edge');
  cell.style.left = `${left}px`;
}

function renderHead() {
  head.replaceChildren();
  if (!meta) return;
  head.style.width = `${totalWidth()}px`;
  head.append(h('div', 'cell line', '#'));
  meta.header.forEach((name, c) => {
    const isNum = meta!.columnTypes[c] === 'number';
    const cell = h('div', `cell hcell c${c % PALETTE}${isNum ? ' num' : ''}`);
    cell.style.width = `${widths[c]}px`;
    applyFreeze(cell, c);
    cell.title = 'Click to select column · Right-click for sort, filter, freeze';
    cell.append(h('span', 'hname', name));
    const level = sort.findIndex(s => s.col === c);
    if (level >= 0) cell.append(h('span', 'sortmark', `${sort[level].dir === 'asc' ? '↑' : '↓'}${level + 1}`));
    if (rules.some(r => r.col === c)) cell.append(h('span', 'dot', '•'));
    cell.addEventListener('click', () => selectColumn(c));
    cell.addEventListener('contextmenu', e => { e.preventDefault(); selectColumn(c); openColumnMenu(c, e.clientX, e.clientY); });
    const fbtn = h('span', rules.some(r => r.col === c && r.op === 'values') ? 'fbtn on' : 'fbtn', '▾');
    fbtn.title = 'Filter by value';
    fbtn.addEventListener('click', e => { e.stopPropagation(); openColumnFilter(c); });
    fbtn.addEventListener('mousedown', e => e.stopPropagation());
    cell.append(fbtn);
    const grip = h('span', 'grip');
    grip.addEventListener('click', e => e.stopPropagation());
    grip.addEventListener('mousedown', e => startResize(e, c));
    cell.append(grip);
    head.append(cell);
  });
}

function startResize(e: MouseEvent, c: number) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX, w0 = widths[c];
  const move = (ev: MouseEvent) => { widths[c] = Math.max(40, w0 + ev.clientX - x0); renderHead(); renderBody(); };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function renderBody() {
  if (!meta) return;
  const real = count * ROW_H;
  const spacer = Math.min(real, MAX_SPACER);
  inner.style.height = `${HEAD_H + spacer}px`;
  inner.style.width = `${totalWidth()}px`;
  const viewH = Math.max(0, scroller.clientHeight - HEAD_H);
  const scale = real > MAX_SPACER ? (real - viewH) / Math.max(1, spacer - viewH) : 1;
  const st = scroller.scrollTop;
  const virtTop = st * scale;
  const first = Math.floor(virtTop / ROW_H);
  const offset = virtTop - first * ROW_H;
  const visible = Math.min(count - first, Math.ceil(viewH / ROW_H) + 1);
  body.style.top = `${HEAD_H + st - offset}px`;

  // fetch missing blocks (visible range plus one block either side)
  const b0 = Math.max(0, Math.floor(first / BLOCK) - 1);
  const b1 = Math.floor((first + Math.max(visible, 1)) / BLOCK) + 1;
  for (let b = b0; b <= b1 && b * BLOCK < count; b++) {
    const got = cache.get(b);
    const stale = got && got.length < BLOCK && b * BLOCK + got.length < count; // partial block, file still indexing
    if ((!got || stale) && !pending.has(b)) { pending.add(b); post({ type: 'rows', start: b * BLOCK, count: BLOCK }); }
  }

  const frag = document.createDocumentFragment();
  for (let r = 0; r < visible; r++) {
    const k = first + r;
    const block = cache.get(Math.floor(k / BLOCK));
    const row = block?.[k % BLOCK];
    const div = h('div', k % 2 ? 'row odd' : 'row');
    div.dataset.k = String(k);
    div.style.width = `${totalWidth()}px`;
    const line = h('div', 'cell line', row ? String(row.line) : '');
    line.title = 'Click to select row · Shift+click for a range · Ctrl/⌘+click to add';
    line.addEventListener('mousedown', e => { if (e.shiftKey) e.preventDefault(); }); // no text selection
    line.addEventListener('click', e => {
      rowSel = selectRow(rowSel, k, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
      rowMode = true;
      sel = undefined;
      colSel = undefined;
      applySelection();
      renderFooter();
    });
    div.append(line);
    meta.header.forEach((_, c) => {
      const isNum = meta!.columnTypes[c] === 'number';
      const cell = h('div', `cell c${c % PALETTE}${isNum ? ' num' : ''}`, row ? row.cells[c] : '');
      cell.style.width = `${widths[c]}px`;
      applyFreeze(cell, c);
      if (row) cell.addEventListener('click', () => {
        sel = { k, col: c, line: row.line, value: row.cells[c] };
        rowSel = selectRow(noRows(), k, {}); // highlight the cell's whole row
        rowMode = false;
        colSel = undefined;
        applySelection(); // update in place: rebuilding the DOM would wipe any text the user is selecting
        renderFooter();
      });
      cell.addEventListener('contextmenu', e => { e.preventDefault(); openColumnMenu(c, e.clientX, e.clientY); });
      div.append(cell);
    });
    frag.append(div);
  }
  body.replaceChildren(frag);
  shown = { first, offset };
  applySelection();
  applyHover();
}

/** Mark selected cell / rows / column on the existing elements (no rebuild). */
function applySelection() {
  for (const row of body.children as HTMLCollectionOf<HTMLElement>) {
    const k = Number(row.dataset.k);
    row.classList.toggle('selected', isRowSelected(rowSel, k));
    const cells = row.children;
    for (let i = 1; i < cells.length; i++) {
      cells[i].classList.toggle('sel', sel !== undefined && sel.k === k && sel.col === i - 1);
      cells[i].classList.toggle('colsel', colSel === i - 1);
    }
  }
  const hcells = head.children;
  for (let i = 1; i < hcells.length; i++) hcells[i].classList.toggle('colsel', colSel === i - 1);
}

function selectColumn(c: number) {
  colSel = c;
  sel = undefined;
  rowSel = noRows();
  rowMode = false;
  applySelection();
  renderFooter();
}

function setFrozen(n: number) {
  frozen = n;
  renderBar();
  renderHead();
  renderBody();
}

// ---- right-click column menu ----
function openColumnMenu(c: number, x: number, y: number) {
  closePopover();
  if (!meta) return;
  const menu = h('div', 'popover ctxmenu');
  popover = menu;
  const item = (label: string, run: () => void, hint = '') => {
    const it = h('div', 'mitem');
    it.append(h('span', '', label), h('span', 'mhint', hint));
    it.addEventListener('click', () => { closePopover(); run(); });
    menu.append(it);
  };
  const sep = () => menu.append(h('div', 'msep'));
  const isNum = meta.columnTypes[c] === 'number';
  const inSort = sort.findIndex(s => s.col === c);
  const others = sort.filter(s => s.col !== c);
  menu.append(h('div', 'mtitle', meta.header[c]));
  item(isNum ? 'Sort smallest → largest' : 'Sort A → Z', () => { sort = [{ col: c, dir: 'asc' }]; sendQuery(); }, '↑');
  item(isNum ? 'Sort largest → smallest' : 'Sort Z → A', () => { sort = [{ col: c, dir: 'desc' }]; sendQuery(); }, '↓');
  if (others.length > 0) {
    item('Then by this, ascending', () => { sort = [...others, { col: c, dir: 'asc' }]; sendQuery(); }, `↑${others.length + 1}`);
    item('Then by this, descending', () => { sort = [...others, { col: c, dir: 'desc' }]; sendQuery(); }, `↓${others.length + 1}`);
  }
  if (inSort >= 0) item('Remove from sort', () => { sort = others; sendQuery(); });
  sep();
  item('Filter values…', () => openColumnFilter(c), '▾');
  if (rules.some(r => r.col === c)) item('Clear filters on this column', () => { rules = rules.filter(r => r.col !== c); sendQuery(); });
  sep();
  if (frozen !== c + 1) item(`Freeze columns up to “${meta.header[c]}”`, () => setFrozen(c + 1), '❄');
  if (frozen > 0) item('Unfreeze columns', () => setFrozen(0));
  sep();
  item('Copy column values', () => { selectColumn(c); copyWhat = 'value'; post({ type: 'copyRows', ranges: [[0, count - 1]], cols: [c] }); }, '⌘C');
  menu.addEventListener('mousedown', e => e.stopPropagation());
  menu.addEventListener('contextmenu', e => e.preventDefault());
  app.append(menu);
  const r = app.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x - r.left, app.clientWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(y - r.top, app.clientHeight - menu.offsetHeight - 4))}px`;
}

// Hover is tracked by hand: rows are rebuilt on scroll, and CSS :hover only updates when the mouse moves.
let shown = { first: 0, offset: 0 };
function applyHover() {
  let hk = -1;
  if (hoverY !== undefined) {
    const rel = hoverY - scroller.getBoundingClientRect().top - HEAD_H;
    if (rel >= 0) hk = shown.first + Math.floor((rel + shown.offset) / ROW_H);
  }
  const rows = body.children;
  for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('hover', shown.first + i === hk);
}
scroller.addEventListener('mousemove', e => { hoverY = e.clientY; applyHover(); });
scroller.addEventListener('mouseleave', () => { hoverY = undefined; applyHover(); });

let rafPending = false;
scroller.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderBody(); });
});
window.addEventListener('resize', () => renderBody());

// ---- footer ----
function renderFooter() {
  footer.replaceChildren();
  if (!meta) return;
  const nSel = selectedCount(rowSel);
  if (notice) footer.append(h('span', 'note', notice));
  else if (colSel !== undefined) footer.append(h('span', 'dim', `Column “${meta.header[colSel]}” selected · ⌘C / Ctrl+C copies its ${count.toLocaleString('en-US')} values · right-click for sort, filter, freeze`));
  else if (rowMode && nSel > 0) footer.append(h('span', 'dim', `${nSel.toLocaleString('en-US')} row${nSel === 1 ? '' : 's'} selected · ⌘C / Ctrl+C copies them`));
  else if (sel) {
    footer.append(h('span', 'dim', `R ${sel.line.toLocaleString('en-US')} · ${meta.header[sel.col]}`), h('span', 'value', JSON.stringify(sel.value)));
  }
  footer.append(h('span', 'grow'));
  if (warning) footer.append(h('span', 'warn', `⚠ ${warning}`));
  const parts: string[] = [];
  if (meta.delimiter) parts.push('UTF-8', meta.delimiter);
  if (meta.sheet) parts.push(`sheet ${meta.sheet}`);
  parts.push(indexingDone ? `indexed ${(indexMs / 1000).toFixed(1)}s` : `indexing ${totalRows.toLocaleString('en-US')} rows…`);
  footer.append(h('span', 'dim', parts.join(' · ')));
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function flash(text: string) {
  notice = text;
  renderFooter();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice = ''; renderFooter(); }, 2500);
}

// ---- fatal error ----
function showFatal(message: string) {
  app.querySelector('.fatal')?.remove(); // a crash reports twice (error + exit); show one box
  const box = h('div', 'fatal');
  box.append(h('div', 'fatal-msg', message));
  const btn = h('button', '', 'Reload');
  btn.addEventListener('click', () => {
    box.remove();
    meta = undefined;
    count = totalRows = 0;
    identityView = true;
    indexingDone = false;
    warning = '';
    rules = [];
    sort = [];
    search = searchBox.value = '';
    resetView();
    renderAll();
    post({ type: 'reload' });
  });
  box.append(btn);
  app.append(box);
}

// ---- keys ----
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase(); // Caps Lock gives 'F' / 'C'
  if (mod && key === 'f') { e.preventDefault(); searchBox.focus(); searchBox.select(); }
  else if (mod && key === 'c' && !(e.target instanceof HTMLInputElement)) {
    if (window.getSelection()?.toString()) return; // the user selected text: let the normal copy happen
    if (colSel !== undefined) { e.preventDefault(); copyWhat = 'value'; post({ type: 'copyRows', ranges: [[0, count - 1]], cols: [colSel] }); }
    else if (rowMode && selectedCount(rowSel) > 0) { e.preventDefault(); copyWhat = 'row'; post({ type: 'copyRows', ranges: rowSel.ranges }); }
    else if (sel) { e.preventDefault(); post({ type: 'copy', text: sel.value }); flash('Copied cell'); }
  }
  else if (e.key === 'Escape' && popover) closePopover();
  else if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement) && (selectedCount(rowSel) > 0 || sel || colSel !== undefined)) {
    rowSel = noRows(); rowMode = false; sel = undefined; colSel = undefined; applySelection(); renderFooter();
  }
  else if (e.key === 'Escape' && document.activeElement === searchBox && searchBox.value) { clearTimeout(searchTimer); searchBox.value = ''; search = ''; sendQuery(); }
});

function renderAll() {
  renderTop();
  renderBar();
  renderHead();
  renderBody();
  renderFooter();
}

renderAll();
post({ type: 'ready' });
