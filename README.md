# Expandomatic

An Obsidian plugin that progressively expands the selection outward, modelled after VSCode's **Expand Selection** (`Alt+Shift+→`).

## Usage

You'll need to assign the keybindings to `Expand Selection` and `Shrink Selection` yourself.

Press **⌃⇧⌘→** (Control+Shift+Command+Right Arrow) repeatedly to grow the selection one unit at a time. Each press wraps the current selection in the next larger syntactic unit. Moving the cursor or changing the selection manually resets the expansion.

Press **⌃⇧⌘←** (Control+Shift+Command+Left Arrow) to shrink back through the expansion history one step at a time. Shrink only works while the selection exactly matches the last expanded selection — any manual change to the cursor or selection clears the history.

## Expansion levels

### Prose (default)

| Press | Selects |
|-------|---------|
| 1st | Word under cursor |
| 2nd | Full URL (if cursor is inside one), otherwise sentence |
| 3rd | Sentence |
| 4th | Paragraph (blank-line bounded) |
| 5th+ | Innermost section (heading + content), then parent sections outward |
| Last | Entire document |

Sentence detection uses punctuation heuristics (`.` `!` `?` followed by a capital letter or end of text). It avoids splitting common titles such as `Dr.` and `Prof.`, plus single-letter abbreviations; it is deliberately heuristic rather than a full natural-language parser.

### Inside a table

| Press | Selects |
|-------|---------|
| 1st | Word |
| 2nd | Cell content (between `|` delimiters, including surrounding spaces) |
| 3rd | Entire row |
| 4th | Entire table |

### Inside a fenced code block

| Press | Selects |
|-------|---------|
| 1st | Word |
| 2nd | Entire line |
| 3rd | Entire fenced block (from ` ``` ` to ` ``` `) |

### Inside a math block (`$$...$$` or inline `$...$`)

**Inline** `$...$`:

| Press | Selects |
|-------|---------|
| 1st | Word/token |
| 2nd | Term (operator-bounded: `+ - * / = ^ , ( ) [ ] { }`) |
| 3rd | Entire `$...$` (including delimiters) |
| 4th | Entire line |

**Block** `$$...$$`:

| Press | Selects |
|-------|---------|
| 1st | Word/token |
| 2nd | Term |
| 3rd | Entire line |
| 4th | Entire `$$` block |

## Multi-cursor behavior

Each cursor expands independently. If multiple cursors expand to the same enclosing unit, the editor may merge those identical selections. Shrinking restores the separate selections from before the merge.

## Installation

1. Build: `npm ci && npm run build`
2. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/expandomatic/`
3. Enable the plugin in **Settings → Community Plugins**

Assign hotkeys under **Settings → Hotkeys** by searching for "Expand Selection" and "Shrink Selection". Suggested macOS bindings are **⌃⇧⌘→** (expand) and **⌃⇧⌘←** (shrink); the plugin does not claim these automatically.

## Development

```bash
npm install
npm run dev   # watch mode, rebuilds on save
npm run build # production build
```
