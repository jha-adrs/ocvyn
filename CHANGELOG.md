# Changelog

## Unreleased (data-viewer branch)
- Opens JSON Lines / NDJSON files (`.jsonl`, `.ndjson`): keys become columns, nested values show as JSON.

## 0.3.1
Fixes from a security and code review.
- A stray `"` inside a field (e.g. `5" pipe`) no longer swallows the rest of the file.
- Search finds cells that contain a `"`.
- A LIKE pattern with many `%` can no longer hang the engine.
- `3,14` and `1,2,3` are text, not numbers. Only `1,234.56`-style thousands separators are parsed.
- Old Mac files with CR-only line endings open correctly.
- Switching sheets while a query is running no longer shows the old sheet's result; the frozen columns and scroll position reset.
- Esc in a popover no longer also clears the selection; Enter on Cancel cancels; shortcuts work with Caps Lock on.
- Files opened from git history or other non-disk sources fall back to the text editor instead of an error.
- Hardening: limits of 10,000 columns, 50 million rows and 10,000 characters per displayed cell; the engine has a memory cap and validates messages.

## 0.3.0
- Right-click any column header or cell for a column menu: sort, add a sort level, filter, freeze, copy column values.
- Click a header to select the whole column; ⌘C / Ctrl+C copies its values.
- Frozen columns are easier to see: tinted, with a thick edge and a "Frozen" pill to unfreeze.
- Fixed: selecting text in a cell no longer disappears after the click.

## 0.2.0
- Row selection: click a row number, Shift+click for a range, Ctrl/⌘+click to add or remove. ⌘C / Ctrl+C copies rows as tab-separated text.
- Clicking a cell highlights its whole row.
- Freeze columns from the column filter menu.
- Fixed: row hover highlight now follows the mouse while scrolling.

## 0.1.0
- First release: read-only grid for CSV, TSV, XLSX and XLS; Excel-style value filters with LIKE search; filter rules; multi-level sort; per-column colours; files up to 500 MB.
