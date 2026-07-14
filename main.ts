import { Editor, Plugin, EditorPosition } from 'obsidian';

type Range = { anchor: EditorPosition; head: EditorPosition };
type SelectionSet = Range[];
type EditorState = { stack: SelectionSet[]; lastSet: SelectionSet | null };
type Heading = { line: number; level: number };
type Fence = { character: '`' | '~'; length: number };

// ─── Pure helpers ────────────────────────────────────────────────────────────

function mk(line: number, ch: number): EditorPosition { return { line, ch }; }
function rng(sl: number, sc: number, el: number, ec: number): Range {
  return { anchor: mk(sl, sc), head: mk(el, ec) };
}
function posLt(a: EditorPosition, b: EditorPosition): boolean {
  return a.line < b.line || (a.line === b.line && a.ch < b.ch);
}
function posEq(a: EditorPosition, b: EditorPosition): boolean {
  return a.line === b.line && a.ch === b.ch;
}
function posMin(a: EditorPosition, b: EditorPosition): EditorPosition {
  return posLt(a, b) ? a : b;
}
function posMax(a: EditorPosition, b: EditorPosition): EditorPosition {
  return posLt(a, b) ? b : a;
}

// Does candidate strictly contain [from, to]?
function strictlyContains(candidate: Range, from: EditorPosition, to: EditorPosition): boolean {
  const cf = posMin(candidate.anchor, candidate.head);
  const ct = posMax(candidate.anchor, candidate.head);
  const fge = !posLt(from, cf);  // from >= cf
  const tle = !posLt(ct, to);    // to <= ct
  const wider = posLt(cf, from) || posLt(to, ct);
  return fge && tle && wider;
}

function headingLevel(line: string): number {
  const m = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)/);
  return m ? m[1].length : 0;
}

function bulletMatch(line: string): RegExpMatchArray | null {
  return line.match(/^(\s*)([-*+]|\d+\.)\s+/);
}

function bulletIndentLevel(line: string): number {
  const m = bulletMatch(line);
  return m ? m[1].length : -1;
}

function bulletContentOffset(line: string): number {
  const m = bulletMatch(line);
  return m ? m[0].length : -1;
}

// ─── Sentence parsing ────────────────────────────────────────────────────────

function findSentenceBoundaries(text: string): number[] {
  // Returns array of offsets where sentences start (first is 0, last is text.length).
  const boundaries: number[] = [0];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '.' || ch === '!' || ch === '?') {
      // Absorb runs of terminal punctuation (e.g. "..." or "!!")
      let j = i + 1;
      while (j < text.length && '.!?'.includes(text[j])) j++;
      // Absorb closing delimiters
      while (j < text.length && /["'\)\]>]/.test(text[j])) j++;

      // Must be followed by whitespace or end of string
      if (j >= text.length || /[ \t\n]/.test(text[j])) {
        // Skip horizontal whitespace (stay on same boundary if newline)
        let k = j;
        while (k < text.length && text[k] === ' ') k++;

        // The next non-space character should signal a new sentence:
        // uppercase letter, or end of text, or a markdown structural character.
        const next = k < text.length ? text[k] : '';
        if (next === '' || /[A-Z]/.test(next) || /[-*#\[>!]/.test(next)) {
          // Heuristic: ignore common titles and single-letter abbreviations.
          const wordBefore = text.slice(0, i).match(/\S+$/)?.[0] ?? '';
          const abbreviation = wordBefore.replace(/\.+$/, '').toLowerCase();
          if (ch === '.' && (/^[a-z]$/.test(abbreviation) ||
              /^(dr|mr|mrs|ms|prof|sr|jr)$/.test(abbreviation))) {
            i++;
            continue;
          }
          if (k > 0) boundaries.push(k);
          i = k;
          continue;
        }
      }
    }

    i++;
  }

  if (boundaries[boundaries.length - 1] !== text.length) {
    boundaries.push(text.length);
  }
  return boundaries;
}

function findSentence(
  text: string,
  fromOff: number,
  toOff: number,
): { start: number; end: number } | null {
  const bounds = findSentenceBoundaries(text);
  if (bounds.length < 2) return null;

  // Find first sentence that starts at or before fromOff and ends at or after toOff.
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i] <= fromOff && bounds[i + 1] >= toOff) {
      return { start: bounds[i], end: bounds[i + 1] };
    }
  }

  // Selection spans multiple sentences — merge them.
  let start = -1, end = -1;
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] > fromOff && bounds[i] < toOff) {
      if (start < 0) start = bounds[i];
      end = bounds[i + 1];
    }
  }
  if (start >= 0) return { start, end };
  return null;
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class Expandomatic extends Plugin {
  // History belongs to an editor, not the plugin process. This prevents a
  // Shrink command in one pane from replaying ranges saved in another pane.
  private editorStates = new WeakMap<Editor, EditorState>();

  async onload() {
    this.addCommand({
      id: 'expand-selection',
      name: 'Expand Selection',
      editorCallback: (editor: Editor) => this.expand(editor),
    });
    this.addCommand({
      id: 'shrink-selection',
      name: 'Shrink Selection',
      editorCallback: (editor: Editor) => this.shrink(editor),
    });
  }

  onunload() { }

  private rangeEq(a: Range, b: Range): boolean {
    return posEq(posMin(a.anchor, a.head), posMin(b.anchor, b.head)) &&
      posEq(posMax(a.anchor, a.head), posMax(b.anchor, b.head));
  }

  private selectionSetEq(a: SelectionSet, b: SelectionSet): boolean {
    return a.length === b.length && a.every((range, index) => this.rangeEq(range, b[index]));
  }

  private stateFor(editor: Editor): EditorState {
    let state = this.editorStates.get(editor);
    if (!state) {
      state = { stack: [], lastSet: null };
      this.editorStates.set(editor, state);
    }
    return state;
  }

  private currentSelections(editor: Editor): SelectionSet {
    return editor.listSelections().map((selection) => ({
      anchor: selection.anchor,
      head: selection.head,
    }));
  }

  private expand(editor: Editor) {
    const current = this.currentSelections(editor);
    if (!current.length) return;
    const state = this.stateFor(editor);

    // Reset stack if the user moved the cursor or changed the selection manually.
    if (state.lastSet !== null && !this.selectionSetEq(current, state.lastSet)) {
      state.stack = [];
      state.lastSet = null;
    }

    const expanded = current.map((selection) => this.expandOne(editor, selection));
    if (!this.selectionSetEq(current, expanded)) {
      state.stack.push(current);
      editor.setSelections(expanded);
      // CodeMirror may merge identical or overlapping selections. Track the
      // normalized selection set so Shrink can still recognize its history.
      state.lastSet = this.currentSelections(editor);
    }
  }

  private expandOne(editor: Editor, current: Range): Range {
    const from = posMin(current.anchor, current.head);
    const to = posMax(current.anchor, current.head);

    // No selection → select nearest word, or nearest section if no word nearby.
    if (posEq(from, to)) {
      return this.nearestWord(editor, from) ?? this.nearestSection(editor, from) ?? current;
    }

    const ctx = this.context(editor, from, to);
    const candidates = this.expansions(editor, ctx, from, to);

    for (const candidate of candidates) {
      if (candidate != null && strictlyContains(candidate, from, to)) {
        return candidate;
      }
    }
    return current;
  }

  private shrink(editor: Editor) {
    const current = this.currentSelections(editor);
    if (!current.length) return;
    const state = this.stateFor(editor);

    // Only shrink if the selection is exactly what we last set and there's history.
    if (state.lastSet === null || !this.selectionSetEq(current, state.lastSet) || state.stack.length === 0) {
      state.stack = [];
      state.lastSet = null;
      return;
    }

    const previous = state.stack.pop()!;
    editor.setSelections(previous);
    state.lastSet = this.currentSelections(editor);
  }

  // ── Context detection ───────────────────────────────────────────────────

  private context(editor: Editor, from: EditorPosition, to: EditorPosition): string {
    const line = editor.getLine(from.line);
    if (this.tableBounds(editor, from.line)) return 'table';
    if (this.inFencedCode(editor, from)) return 'code';
    if (this.inEquation(editor, from)) return 'equation';
    // from may be sitting on the opening $ delimiter; check one char inside.
    if (!posEq(from, to) && from.line === to.line) {
      const inside = mk(from.line, from.ch + 1);
      if (inside.ch <= to.ch && this.inEquation(editor, inside)) return 'equation';
    }
    if (bulletMatch(line)) return 'list';
    return 'prose';
  }

  private inFencedCode(editor: Editor, pos: EditorPosition): boolean {
    let open: Fence | null = null;
    for (let i = 0; i < pos.line; i++) {
      const fence = this.fenceAt(editor.getLine(i));
      if (!fence) continue;
      if (!open) open = fence;
      else if (fence.character === open.character && fence.length >= open.length) open = null;
    }
    return open !== null;
  }

  private fenceAt(line: string): Fence | null {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) return null;
    return { character: match[1][0] as '`' | '~', length: match[1].length };
  }

  private fenceBounds(editor: Editor, line: number): { start: number; end: number } | null {
    let start = line;
    let opener: Fence | null = null;
    while (start >= 0) {
      const candidate = this.fenceAt(editor.getLine(start));
      if (candidate) { opener = candidate; break; }
      start--;
    }
    if (!opener) return null;

    let end = start + 1;
    while (end < editor.lineCount()) {
      const candidate = this.fenceAt(editor.getLine(end));
      if (candidate && candidate.character === opener.character && candidate.length >= opener.length) {
        return { start, end };
      }
      end++;
    }
    return null;
  }

  private headings(): Heading[] {
    const file = this.app.workspace.getActiveFile();
    const cache = file ? this.app.metadataCache.getFileCache(file) : null;
    return cache?.headings?.map((heading) => ({
      line: heading.position.start.line,
      level: heading.level,
    })) ?? [];
  }

  private inBlockEquation(editor: Editor, pos: EditorPosition): boolean {
    let open = false;
    for (let i = 0; i < pos.line; i++) {
      if (editor.getLine(i).trim() === '$$') open = !open;
    }
    return open;
  }

  private inEquation(editor: Editor, pos: EditorPosition): boolean {
    if (this.inBlockEquation(editor, pos)) return true;
    const line = editor.getLine(pos.line);
    let count = 0;
    for (let i = 0; i < pos.ch; i++) {
      if (line[i] === '$' && (i === 0 || line[i - 1] !== '$') && (i + 1 >= line.length || line[i + 1] !== '$')) count++;
    }
    return count % 2 === 1;
  }

  // ── Expansion lists ─────────────────────────────────────────────────────

  private expansions(
    editor: Editor,
    ctx: string,
    from: EditorPosition,
    to: EditorPosition,
  ): Array<Range | null> {
    switch (ctx) {
      case 'table':
        return [
          this.wordAt(editor, from),
          this.tableCell(editor, from),
          this.tableRow(editor, from),
          this.tableAll(editor, from),
          this.wholeDoc(editor),
        ];
      case 'code':
        return [
          this.wordAt(editor, from),
          this.codeLine(editor, from),
          this.codeBlock(editor, from),
          this.wholeDoc(editor),
        ];
      case 'equation':
        if (this.inBlockEquation(editor, from)) {
          return [
            this.wordAt(editor, from),
            this.eqTerm(editor, from),
            this.eqLine(editor, from),
            this.eqBlock(editor, from),
            this.wholeDoc(editor),
          ];
        }
        return [
          this.wordAt(editor, from),
          this.eqTerm(editor, from),
          this.inlineEqBlock(editor, from),
          this.eqLine(editor, from),
          this.wholeDoc(editor),
        ];
      case 'list': {
        const ancestors = this.bulletAncestorExpansions(editor, from.line);
        return [
          this.wordAt(editor, from),
          this.urlAt(editor, from, to),
          this.bulletSentence(editor, from, to),
          this.bulletContent(editor, from),
          this.bulletWithChildren(editor, from.line),
          ...ancestors,
          this.paragraph(editor, from),
          this.section(editor, from, to),
          this.wholeDoc(editor),
        ];
      }
      default:
        return [
          this.wordAt(editor, from),
          this.urlAt(editor, from, to),
          this.sentence(editor, from, to),
          this.paragraph(editor, from),
          this.section(editor, from, to),
          this.wholeDoc(editor),
        ];
    }
  }

  // ── Atomic expansion methods ────────────────────────────────────────────

  private wordAt(editor: Editor, pos: EditorPosition): Range | null {
    const r = editor.wordAt(pos);
    return r ? { anchor: r.from, head: r.to } : null;
  }

  private nearestWord(editor: Editor, pos: EditorPosition): Range | null {
    const w = editor.wordAt(pos);
    if (w) return { anchor: w.from, head: w.to };
    const line = editor.getLine(pos.line);
    for (let d = 1; d <= line.length; d++) {
      const li = pos.ch - d;
      if (li >= 0 && /\w/.test(line[li])) {
        const hit = editor.wordAt(mk(pos.line, li));
        if (hit) return { anchor: hit.from, head: hit.to };
      }
      const ri = pos.ch + d;
      if (ri < line.length && /\w/.test(line[ri])) {
        const hit = editor.wordAt(mk(pos.line, ri));
        if (hit) return { anchor: hit.from, head: hit.to };
      }
    }
    return null;
  }

  private nearestSection(editor: Editor, pos: EditorPosition): Range | null {
    const lineCount = editor.lineCount();
    const headings = this.headings();
    if (headings.length === 0) return null;

    // Pick the heading closest to pos.line; ties go to the earlier one.
    let nearestIdx = 0;
    let nearestDist = Math.abs(headings[0].line - pos.line);
    for (let i = 1; i < headings.length; i++) {
      const d = Math.abs(headings[i].line - pos.line);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    }

    const h = headings[nearestIdx];
    let endLine = lineCount - 1;
    for (let hj = nearestIdx + 1; hj < headings.length; hj++) {
      if (headings[hj].level <= h.level) { endLine = headings[hj].line - 1; break; }
    }
    while (endLine > h.line && editor.getLine(endLine).trim() === '') endLine--;

    return rng(h.line, 0, endLine, editor.getLine(endLine).length);
  }

  // Prose: URL
  private urlAt(editor: Editor, from: EditorPosition, to: EditorPosition): Range | null {
    const line = editor.getLine(from.line);
    const re = /https?:\/\/[^\s)\]>"'`]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const s = m.index, e = s + m[0].length;
      if (s <= from.ch && e >= to.ch && !(s === from.ch && e === to.ch)) {
        return rng(from.line, s, from.line, e);
      }
    }
    return null;
  }

  // Prose: sentence
  private sentence(editor: Editor, from: EditorPosition, to: EditorPosition): Range | null {
    const pr = this.paragraphBounds(editor, from.line);
    const base = mk(pr.start, 0);
    const text = editor.getRange(base, mk(pr.end, editor.getLine(pr.end).length));

    const fromOff = this.toOffset(editor, from, pr.start);
    const toOff = this.toOffset(editor, to, pr.start);
    const sent = findSentence(text, fromOff, toOff);
    if (!sent) return null;

    const anchor = this.fromOffset(editor, sent.start, pr.start);
    const head = this.fromOffset(editor, sent.end, pr.start);
    // If the sentence range equals the current selection, bail (caller will try paragraph).
    if (posEq(anchor, from) && posEq(head, to)) return null;
    return { anchor, head };
  }

  // Prose: paragraph (blank-line bounded)
  private paragraph(editor: Editor, from: EditorPosition): Range {
    const pr = this.paragraphBounds(editor, from.line);
    return rng(pr.start, 0, pr.end, editor.getLine(pr.end).length);
  }

  // Prose: smallest section that strictly contains [from, to], then next larger, etc.
  // Because strictlyContains is checked by the caller, a single method suffices —
  // each call will naturally find the next larger section.
  private section(editor: Editor, from: EditorPosition, to: EditorPosition): Range | null {
    const lineCount = editor.lineCount();
    const headings = this.headings();
    if (headings.length === 0) return null;

    let best: Range | null = null;
    let bestSize = Infinity;

    for (let hi = 0; hi < headings.length; hi++) {
      const h = headings[hi];
      // Section ends just before the next heading at same/higher level.
      let endLine = lineCount - 1;
      for (let hj = hi + 1; hj < headings.length; hj++) {
        if (headings[hj].level <= h.level) {
          endLine = headings[hj].line - 1;
          break;
        }
      }
      // Trim trailing blank lines from the section.
      while (endLine > h.line && editor.getLine(endLine).trim() === '') endLine--;

      const candidate = rng(h.line, 0, endLine, editor.getLine(endLine).length);
      if (strictlyContains(candidate, from, to)) {
        const size = (endLine - h.line) * 10000 + editor.getLine(endLine).length;
        if (size < bestSize) {
          best = candidate;
          bestSize = size;
        }
      }
    }

    return best;
  }

  // ── List / bullet ───────────────────────────────────────────────────────

  private bulletSentence(editor: Editor, from: EditorPosition, to: EditorPosition): Range | null {
    const line = editor.getLine(from.line);
    const offset = bulletContentOffset(line);
    if (offset < 0) return null;
    const text = line.slice(offset);
    const fromOff = Math.max(0, from.ch - offset);
    const toOff = to.line === from.line ? Math.max(0, to.ch - offset) : text.length;
    const sent = findSentence(text, fromOff, toOff);
    if (!sent) return null;
    const anchor = mk(from.line, offset + sent.start);
    const head = mk(from.line, offset + sent.end);
    if (posEq(anchor, from) && posEq(head, to)) return null;
    return { anchor, head };
  }

  private bulletContent(editor: Editor, pos: EditorPosition): Range | null {
    const line = editor.getLine(pos.line);
    const offset = bulletContentOffset(line);
    if (offset < 0) return null;
    return rng(pos.line, offset, pos.line, line.length);
  }

  private bulletWithChildren(editor: Editor, bulletLine: number): Range | null {
    const lc = editor.lineCount();
    const line = editor.getLine(bulletLine);
    const myIndent = bulletIndentLevel(line);
    if (myIndent < 0) return null;
    let end = bulletLine;
    for (let i = bulletLine + 1; i < lc; i++) {
      const l = editor.getLine(i);
      if (l.trim() === '') break;
      const lineIndent = l.match(/^(\s*)/)?.[1].length ?? 0;
      const bIndent = bulletIndentLevel(l);
      if (bIndent >= 0 && bIndent <= myIndent) break;
      if (bIndent < 0 && lineIndent <= myIndent) break;
      end = i;
    }
    return rng(bulletLine, 0, end, editor.getLine(end).length);
  }

  private bulletAncestorExpansions(editor: Editor, bulletLine: number): Array<Range | null> {
    const line = editor.getLine(bulletLine);
    let myIndent = bulletIndentLevel(line);
    if (myIndent < 0) return [];
    const results: Array<Range | null> = [];
    for (let i = bulletLine - 1; i >= 0; i--) {
      const l = editor.getLine(i);
      if (l.trim() === '') break;
      const bIndent = bulletIndentLevel(l);
      if (bIndent >= 0 && bIndent < myIndent) {
        results.push(this.bulletWithChildren(editor, i));
        myIndent = bIndent;
        if (myIndent === 0) break;
      }
    }
    return results;
  }

  private wholeDoc(editor: Editor): Range {
    const last = editor.lineCount() - 1;
    return rng(0, 0, last, editor.getLine(last).length);
  }

  // ── Table ───────────────────────────────────────────────────────────────

  private tableCell(editor: Editor, pos: EditorPosition): Range | null {
    const line = editor.getLine(pos.line);
    let s = pos.ch, e = pos.ch;
    while (s > 0 && line[s - 1] !== '|') s--;
    while (e < line.length && line[e] !== '|') e++;
    return rng(pos.line, s, pos.line, e);
  }

  private tableRow(editor: Editor, pos: EditorPosition): Range {
    return rng(pos.line, 0, pos.line, editor.getLine(pos.line).length);
  }

  private isTableRow(editor: Editor, line: number): boolean {
    return editor.getLine(line).includes('|');
  }

  private isTableDivider(editor: Editor, line: number): boolean {
    return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(editor.getLine(line));
  }

  private tableBounds(editor: Editor, line: number): { start: number; end: number } | null {
    if (!this.isTableRow(editor, line)) return null;
    let start = line, end = line;
    while (start > 0 && this.isTableRow(editor, start - 1)) start--;
    while (end < editor.lineCount() - 1 && this.isTableRow(editor, end + 1)) end++;
    for (let i = start; i <= end; i++) {
      if (this.isTableDivider(editor, i)) return { start, end };
    }
    return null;
  }

  private tableAll(editor: Editor, pos: EditorPosition): Range | null {
    const bounds = this.tableBounds(editor, pos.line);
    if (!bounds) return null;
    return rng(bounds.start, 0, bounds.end, editor.getLine(bounds.end).length);
  }

  // ── Code block ──────────────────────────────────────────────────────────

  private codeLine(editor: Editor, pos: EditorPosition): Range {
    return rng(pos.line, 0, pos.line, editor.getLine(pos.line).length);
  }

  private codeBlock(editor: Editor, pos: EditorPosition): Range | null {
    const bounds = this.fenceBounds(editor, pos.line);
    return bounds ? rng(bounds.start, 0, bounds.end, editor.getLine(bounds.end).length) : null;
  }

  // ── Equation ────────────────────────────────────────────────────────────

  private inlineEqBlock(editor: Editor, pos: EditorPosition): Range | null {
    const line = editor.getLine(pos.line);
    const isSingle = (i: number) =>
      line[i] === '$' &&
      (i === 0 || line[i - 1] !== '$') &&
      (i + 1 >= line.length || line[i + 1] !== '$');
    let s = pos.ch - 1;
    while (s >= 0 && !isSingle(s)) s--;
    if (s < 0) return null;
    let e = pos.ch;
    while (e < line.length && !isSingle(e)) e++;
    if (e >= line.length) return null;
    return rng(pos.line, s, pos.line, e + 1);
  }

  private eqTerm(editor: Editor, pos: EditorPosition): Range {
    const line = editor.getLine(pos.line);
    // Operators / delimiters that bound a term.
    const op = /[+\-*/=^,\s()\[\]{}\\$&|]/;
    let s = pos.ch, e = pos.ch;
    while (s > 0 && !op.test(line[s - 1])) s--;
    while (e < line.length && !op.test(line[e])) e++;
    return rng(pos.line, s, pos.line, e);
  }

  private eqLine(editor: Editor, pos: EditorPosition): Range {
    return rng(pos.line, 0, pos.line, editor.getLine(pos.line).length);
  }

  private eqBlock(editor: Editor, pos: EditorPosition): Range | null {
    const lc = editor.lineCount();
    const isDelim = (l: number) => editor.getLine(l).trim() === '$$';
    let s = pos.line, e = pos.line;
    while (s > 0 && !isDelim(s)) s--;
    while (e < lc - 1 && !isDelim(e)) e++;
    return rng(s, 0, e, editor.getLine(e).length);
  }

  // ── Paragraph / offset helpers ───────────────────────────────────────────

  private paragraphBounds(editor: Editor, line: number): { start: number; end: number } {
    const lc = editor.lineCount();
    // A heading line is its own paragraph.
    if (headingLevel(editor.getLine(line)) > 0) return { start: line, end: line };
    let s = line, e = line;
    while (s > 0 && editor.getLine(s - 1).trim() !== '' && headingLevel(editor.getLine(s - 1)) === 0) s--;
    while (e < lc - 1 && editor.getLine(e + 1).trim() !== '' && headingLevel(editor.getLine(e + 1)) === 0) e++;
    return { start: s, end: e };
  }

  private toOffset(editor: Editor, pos: EditorPosition, startLine: number): number {
    let off = 0;
    for (let i = startLine; i < pos.line; i++) off += editor.getLine(i).length + 1;
    return off + pos.ch;
  }

  private fromOffset(editor: Editor, offset: number, startLine: number): EditorPosition {
    let rem = offset, line = startLine;
    while (true) {
      const len = editor.getLine(line).length;
      if (rem <= len) return mk(line, rem);
      rem -= len + 1;
      line++;
    }
  }
}
