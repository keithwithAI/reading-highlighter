/**
 * Pure helpers for reading and editing `==highlights==` and the footnotes
 * that hold their notes. Nothing here touches Obsidian, so it is unit tested
 * directly (see highlights.test.ts).
 *
 * A note is stored as a footnote whose label is `hl<number>`:
 *
 *     Some ==quoted text==[^hl3] here.
 *
 *     [^hl3]: The note. Extra lines are
 *         indented by four spaces.
 *
 * Only `hl<number>` labels are treated as ours; other footnotes are left alone.
 */

export interface HighlightSpan {
  /** Offset of the opening `==`. */
  start: number;
  /** Offset just past the closing `==`. */
  end: number;
  inner: string;
  /** `hl<n>` when a plugin footnote ref directly follows the span. */
  footnoteLabel: string | null;
  /** Offset just past the footnote ref, or `end` when there is none. */
  refEnd: number;
}

const HIGHLIGHT_RE = /==([^=](?:.*?[^=])??)==/g;
const PLUGIN_REF_RE = /^\[\^(hl\d+)\]/;
const CONTINUATION_RE = /^( {4}|\t)/;
const NOTE_INDENT = "    ";

export function findHighlightSpans(raw: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  const lines = raw.split("\n");
  let offset = 0;
  let fence: string | null = null;
  let inFrontmatter = lines[0] === "---";

  lines.forEach((line, index) => {
    const lineStart = offset;
    offset += line.length + 1;

    if (inFrontmatter) {
      if (index > 0 && (line === "---" || line === "...")) inFrontmatter = false;
      return;
    }

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1].startsWith(fence)) fence = null;
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return;
    }

    // Blank out inline code so `==x==` inside backticks is ignored, while
    // keeping offsets identical to the original line.
    const masked = line.replace(/(`+)[^`]*?\1/g, (m) => " ".repeat(m.length));

    for (const match of masked.matchAll(HIGHLIGHT_RE)) {
      const start = lineStart + (match.index ?? 0);
      const end = start + match[0].length;
      const inner = raw.slice(start + 2, end - 2);
      const after = masked.slice(end - lineStart);
      const ref = after.match(PLUGIN_REF_RE);
      spans.push({
        start,
        end,
        inner,
        footnoteLabel: ref ? ref[1] : null,
        refEnd: ref ? end + ref[0].length : end,
      });
    }
  });

  return spans;
}

export function nextFootnoteLabel(raw: string): string {
  let max = 0;
  for (const match of raw.matchAll(/\[\^hl(\d+)\]/g)) {
    max = Math.max(max, parseInt(match[1], 10));
  }
  return `hl${max + 1}`;
}

/** Put `[^label]` right after the last closing `==` of a highlighted run. */
export function insertFootnoteRef(highlighted: string, label: string): string {
  const idx = highlighted.lastIndexOf("==");
  if (idx === -1) return highlighted + `[^${label}]`;
  return highlighted.slice(0, idx + 2) + `[^${label}]` + highlighted.slice(idx + 2);
}

function formatDefinition(label: string, note: string): string[] {
  const [first, ...rest] = note.split("\n");
  return [`[^${label}]: ${first}`, ...rest.map((l) => NOTE_INDENT + l)];
}

/** Locate a definition as [first line, line after its last continuation]. */
function findDefinitionLines(lines: string[], label: string): [number, number] | null {
  const head = `[^${label}]:`;
  const i = lines.findIndex((l) => l.startsWith(head));
  if (i === -1) return null;
  let j = i + 1;
  while (j < lines.length && CONTINUATION_RE.test(lines[j])) j++;
  return [i, j];
}

export function appendFootnoteDefinition(raw: string, label: string, note: string): string {
  const def = formatDefinition(label, note).join("\n");
  const body = raw.replace(/\s+$/, "");
  if (!body) return def + "\n";

  const lastBlock = body.slice(body.lastIndexOf("\n\n") + 1).replace(/^\n/, "");
  const joinsFootnotes = /^\[\^[^\]\s]+\]:/.test(lastBlock);
  return body + (joinsFootnotes ? "\n" : "\n\n") + def + "\n";
}

export function getFootnoteDefinition(raw: string, label: string): string | null {
  const lines = raw.split("\n");
  const found = findDefinitionLines(lines, label);
  if (!found) return null;
  const [i, j] = found;
  const first = lines[i].slice(`[^${label}]:`.length).replace(/^[ \t]/, "");
  const rest = lines.slice(i + 1, j).map((l) => l.replace(CONTINUATION_RE, ""));
  return [first, ...rest].join("\n");
}

export function replaceFootnoteDefinition(raw: string, label: string, note: string): string {
  const lines = raw.split("\n");
  const found = findDefinitionLines(lines, label);
  if (!found) return appendFootnoteDefinition(raw, label, note);
  const [i, j] = found;
  lines.splice(i, j - i, ...formatDefinition(label, note));
  return lines.join("\n");
}

export function removeFootnoteDefinition(raw: string, label: string): string {
  const lines = raw.split("\n");
  const found = findDefinitionLines(lines, label);
  if (!found) return raw;
  const [i, j] = found;
  const atEnd = lines.slice(j).every((l) => !l.trim());
  lines.splice(i, j - i);
  const out = lines.join("\n");
  // Drop the blank line that appendFootnoteDefinition added, if this was the
  // last thing in the file.
  return atEnd ? out.replace(/\n+$/, "\n") : out;
}

/** Unwrap `==inner==`, and drop its plugin footnote when nothing else uses it. */
export function removeHighlightSpan(raw: string, span: HighlightSpan): string {
  const out = raw.slice(0, span.start) + span.inner + raw.slice(span.refEnd);
  if (!span.footnoteLabel) return out;
  const stillReferenced = new RegExp(`\\[\\^${span.footnoteLabel}\\](?!:)`).test(out);
  return stillReferenced ? out : removeFootnoteDefinition(out, span.footnoteLabel);
}

/**
 * Find where `text` now starts in `raw`: at the recorded `start` if it is
 * still there, otherwise at its only occurrence. Null when gone or ambiguous.
 */
export function locateSpan(raw: string, span: { start: number; text: string }): number | null {
  if (raw.slice(span.start, span.start + span.text.length) === span.text) {
    return span.start;
  }
  const idx = raw.indexOf(span.text);
  if (idx === -1 || raw.indexOf(span.text, idx + 1) !== -1) return null;
  return idx;
}

export function lineOfOffset(raw: string, offset: number): number {
  return raw.slice(0, offset).split("\n").length - 1;
}

export interface MarkLocation {
  /** The tapped mark's rendered text. */
  text: string;
  /** Position of the mark among the marks of its block element. */
  indexInBlock: number;
  /** Source range of the mark's block (from data-sourcepos), if known. */
  window: { start: number; end: number } | null;
}

/**
 * Work out which source span a rendered `<mark>` came from. Tries the n-th
 * span of the mark's block first, then a unique text match in the block,
 * then a unique text match in the whole file.
 */
export function matchMarkToSpan(
  spans: HighlightSpan[],
  mark: MarkLocation,
  render: (inner: string) => string
): HighlightSpan | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = norm(mark.text);
  const matches = (span: HighlightSpan) => norm(render(span.inner)) === target;
  const only = (list: HighlightSpan[]) => (list.length === 1 ? list[0] : null);

  if (mark.window) {
    const { start, end } = mark.window;
    const inBlock = spans.filter((s) => s.start >= start && s.end <= end);
    const nth = inBlock[mark.indexInBlock];
    if (nth && matches(nth)) return nth;
    const inBlockMatch = only(inBlock.filter(matches));
    if (inBlockMatch) return inBlockMatch;
  }
  return only(spans.filter(matches));
}

/**
 * Set, replace or clear the note on a highlight. Empty text removes the note
 * (ref and definition) but keeps the highlight.
 */
export function setSpanNote(raw: string, span: HighlightSpan, note: string): string {
  const text = note.trim();
  if (span.footnoteLabel) {
    if (text) return replaceFootnoteDefinition(raw, span.footnoteLabel, text);
    const withoutRef = raw.slice(0, span.end) + raw.slice(span.refEnd);
    return removeFootnoteDefinition(withoutRef, span.footnoteLabel);
  }
  if (!text) return raw;
  const label = nextFootnoteLabel(raw);
  const withRef = raw.slice(0, span.end) + `[^${label}]` + raw.slice(span.end);
  return appendFootnoteDefinition(withRef, label, text);
}

/**
 * Source offsets covered by one reading-view section, given every section's
 * line count in order. Sections tile the file, so a section starts on the
 * line after the previous one ends.
 */
export function sectionRange(
  raw: string,
  lineCounts: number[],
  index: number
): { start: number; end: number } | null {
  if (index < 0 || index >= lineCounts.length || lineCounts[index] <= 0) return null;
  const startLine = lineCounts.slice(0, index).reduce((a, b) => a + b, 0);
  const endLine = startLine + lineCounts[index];

  const lineOffset = (line: number): number => {
    let off = 0;
    for (let i = 0; i < line; i++) {
      const nl = raw.indexOf("\n", off);
      if (nl === -1) return raw.length;
      off = nl + 1;
    }
    return off;
  };

  const start = lineOffset(startLine);
  const end = lineOffset(endLine);
  return end > start ? { start, end } : null;
}
