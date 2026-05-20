import { Plugin, MarkdownView, Notice, Platform, setIcon } from "obsidian";

interface PositionMapEntry {
  sourceStart: number;
  sourceEnd: number;
  renderedPos: number;
  isInLink: boolean;
  linkType: string | null;
}

interface PositionMap {
  renderedText: string;
  map: PositionMapEntry[];
}

interface FormattingMatch {
  content: string;
  startOffset: number;
  fullLength: number;
}

interface SourcePosRange {
  start: number;
  end: number;
}

interface SelectionSnapshot {
  text: string;
  viewPath: string | null;
  paragraphStart: number | null;
  paragraphEnd: number | null;
}

type NullablePair = [number | null, number | null];

export default class ReadingHighlighterPlugin extends Plugin {
  floatingButtonEl: HTMLButtonElement | null = null;
  selectionSnapshot: SelectionSnapshot | null = null;

  onload(): void {
    /*── Command palette ──*/
    this.addCommand({
      id: "highlight-selection-reading",
      name: "Highlight selection in reading mode",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== "preview") return false;
        if (checking) return true;
        this.highlightSelection(view);
        return true;
      },
    });

    /*── Ribbon icon (mobile only) ──*/
    if (Platform.isMobile) {
      this.addRibbonIcon("highlighter", "Highlight selection", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.getMode() === "preview") {
          this.highlightSelection(view);
        } else {
          new Notice("Open the note in reading mode first.");
        }
      });
    }

    /*── Floating button ──*/
    this.createFloatingButton();
    this.registerDomEvent(document, "selectionchange", () =>
      this.handleSelectionChange()
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        // Different file/view → any cached selection is stale
        this.selectionSnapshot = null;
        this.handleSelectionChange();
      })
    );
    // Initial check in case a selection exists when the plugin loads
    this.handleSelectionChange();
  }

  onunload(): void {
    if (this.floatingButtonEl) {
      this.floatingButtonEl.remove();
      this.floatingButtonEl = null;
    }
    this.selectionSnapshot = null;
  }

  createFloatingButton(): void {
    if (this.floatingButtonEl) return;

    this.floatingButtonEl = document.createElement("button");
    setIcon(this.floatingButtonEl, "highlighter");
    this.floatingButtonEl.setAttribute("aria-label", "Highlight selection");
    this.floatingButtonEl.setAttribute("type", "button");
    this.floatingButtonEl.addClass("reading-highlighter-float-btn");

    // mousedown default = focus the button, which collapses the text
    // selection in most browsers. Preventing it keeps the selection alive
    // until the click handler reads it.
    this.registerDomEvent(this.floatingButtonEl, "mousedown", (e: MouseEvent) => {
      e.preventDefault();
    });

    this.registerDomEvent(this.floatingButtonEl, "click", (e: MouseEvent) => {
      e.preventDefault();
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.getMode() === "preview") {
        this.highlightSelection(view);
      }
      this.hideFloatingButton();
    });

    document.body.appendChild(this.floatingButtonEl);
  }

  handleSelectionChange(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "preview") {
      this.hideFloatingButton();
      return;
    }

    const sel = document.getSelection();
    const snippet = sel?.toString() ?? "";

    if (snippet.trim() && sel && !sel.isCollapsed) {
      const anchorNode = sel.anchorNode;
      const focusNode = sel.focusNode;
      const previewEl = this.getPreviewEl(view);
      if (
        previewEl &&
        anchorNode &&
        previewEl.contains(anchorNode) &&
        focusNode &&
        previewEl.contains(focusNode)
      ) {
        const anchorRange = this.sourcePosRangeForNode(anchorNode);
        const focusRange = this.sourcePosRangeForNode(focusNode);
        let paragraphStart: number | null = null;
        let paragraphEnd: number | null = null;
        if (anchorRange && focusRange) {
          paragraphStart = Math.min(anchorRange.start, focusRange.start);
          paragraphEnd = Math.max(anchorRange.end, focusRange.end);
        }
        this.selectionSnapshot = {
          text: snippet,
          viewPath: view.file?.path ?? null,
          paragraphStart,
          paragraphEnd,
        };
        this.showFloatingButton();
        return;
      }
    }

    // Selection is collapsed / empty / outside the preview. Hide the button,
    // but keep the most recent snapshot: tapping a button can collapse the
    // selection as a side effect and we still want that tap to succeed.
    this.hideFloatingButton();
  }

  showFloatingButton(): void {
    this.floatingButtonEl?.addClass("is-visible");
  }

  hideFloatingButton(): void {
    this.floatingButtonEl?.removeClass("is-visible");
  }

  /*───────────────── Main logic ─────────────────*/
  async highlightSelection(view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!file) return;

    /* 1. Pick a selection: live if it's still there, otherwise the snapshot */
    const sel = document.getSelection();
    const liveSnippet = sel?.toString() ?? "";
    const previewEl = this.getPreviewEl(view);
    const liveValid =
      liveSnippet.trim().length > 0 &&
      sel != null &&
      !sel.isCollapsed &&
      previewEl != null &&
      sel.anchorNode != null &&
      previewEl.contains(sel.anchorNode) &&
      sel.focusNode != null &&
      previewEl.contains(sel.focusNode);

    let snippet: string;
    let paragraphStart: number | null = null;
    let paragraphEnd: number | null = null;

    if (liveValid && sel) {
      snippet = liveSnippet;
      const anchorRange = this.sourcePosRangeForNode(sel.anchorNode);
      const focusRange = this.sourcePosRangeForNode(sel.focusNode);
      if (anchorRange && focusRange) {
        paragraphStart = Math.min(anchorRange.start, focusRange.start);
        paragraphEnd = Math.max(anchorRange.end, focusRange.end);
      }
    } else if (
      this.selectionSnapshot &&
      this.selectionSnapshot.viewPath === (file.path ?? null)
    ) {
      snippet = this.selectionSnapshot.text;
      paragraphStart = this.selectionSnapshot.paragraphStart;
      paragraphEnd = this.selectionSnapshot.paragraphEnd;
    } else {
      new Notice("Select text first — nothing selected.");
      return;
    }

    if (!snippet.trim()) {
      new Notice("Select text first — nothing selected.");
      return;
    }

    /* 2. Save scroll position */
    const scrollBefore = this.getScroll(view);

    /* 3. Atomically read + modify the file */
    let found = true;

    await this.app.vault.process(file, (raw: string): string => {
      let a_orig: number | null = null;
      let b_orig: number | null = null;

      // When we know which paragraph(s) the selection is in, search *only*
      // inside that window. This is both more accurate (the right occurrence
      // of a repeated phrase) and faster.
      if (
        paragraphStart != null &&
        paragraphEnd != null &&
        paragraphStart >= 0 &&
        paragraphEnd <= raw.length &&
        paragraphStart < paragraphEnd
      ) {
        const windowText = raw.slice(paragraphStart, paragraphEnd);
        const windowMatch = this.findMatchWithLinks(windowText, snippet);
        if (windowMatch[0] != null && windowMatch[1] != null) {
          a_orig = paragraphStart + windowMatch[0];
          b_orig = paragraphStart + windowMatch[1];
        }
      }

      // Fall back to searching the whole document.
      if (a_orig == null || b_orig == null) {
        const pos_fallback = this.findMatchWithLinks(raw, snippet);
        if (pos_fallback[0] == null || pos_fallback[1] == null) {
          found = false;
          return raw;
        }
        [a_orig, b_orig] = pos_fallback as [number, number];
      }

      let currentA = a_orig;
      let currentB = b_orig;
      const textBeforeSelection = raw.slice(0, currentA);
      const textAfterSelection = raw.slice(currentB);

      // If the selection falls inside an inline formatting span but didn't
      // include the delimiters, extend it so the resulting markdown stays
      // valid. Longer delimiters first so e.g. `***` isn't matched as `*`.
      const inlineDelimiters = ["***", "___", "**", "__", "~~", "*", "_", "`"];
      for (const delim of inlineDelimiters) {
        if (
          textBeforeSelection.endsWith(delim) &&
          textAfterSelection.startsWith(delim)
        ) {
          currentA -= delim.length;
          currentB += delim.length;
          break;
        }
      }

      const textToHighlight = raw.slice(currentA, currentB);
      const updatedText = this.addHighlightsByParagraph(textToHighlight);

      return raw.slice(0, currentA) + updatedText + raw.slice(currentB);
    });

    if (!found) {
      new Notice("Unable to locate the selection in the file.");
      return;
    }

    /* 4. Restore scroll — two passes because rendering can finish late */
    const restore = () => this.applyScroll(view, scrollBefore);
    requestAnimationFrame(() => {
      restore();
      setTimeout(restore, 50);
    });

    /* 5. Clean up selection + cache */
    sel?.removeAllRanges();
    this.selectionSnapshot = null;
    this.hideFloatingButton();
  }

  /*────────── Add highlights by paragraph ──────────*/
  addHighlightsByParagraph(text: string): string {
    // Split into paragraphs while preserving the exact separators (blank
    // lines may contain whitespace) so the file content isn't silently
    // modified. parts alternates: [content, sep, content, sep, …]
    const parts = text.split(/(\n\s*\n)/);

    if (parts.length === 1) {
      const lines = text.split("\n");
      if (lines.length === 1) {
        return this.addHighlightToLine(text);
      }
      return lines
        .map((line) => (line.trim() ? this.addHighlightToLine(line) : line))
        .join("\n");
    }

    return parts
      .map((part, index) => {
        if (index % 2 === 1) return part; // separator
        if (!part.trim()) return part;

        const lines = part.split("\n");
        return lines
          .map((line) => (line.trim() ? this.addHighlightToLine(line) : line))
          .join("\n");
      })
      .join("");
  }

  /*────────── Add highlight to a single line ──────────*/
  addHighlightToLine(line: string): string {
    const leadingMatch = line.match(/^(\s*)/);
    const leadingSpaces = leadingMatch ? leadingMatch[1] : "";
    const trailingMatch = line.match(/(\s*)$/);
    const trailingSpaces = trailingMatch ? trailingMatch[1] : "";
    const core = line.slice(
      leadingSpaces.length,
      line.length - trailingSpaces.length
    );

    if (!core.trim()) return line;

    // Block-level prefixes: == must go AFTER these markers
    const blockPrefixPatterns: RegExp[] = [
      /^(#{1,6}\s+)(.*)$/, // Headers
      /^(>\s+)(.*)$/, // Blockquotes
      /^([-*+]\s+)(.*)$/, // Unordered list
      /^(\d+\.\s+)(.*)$/, // Ordered list
    ];

    for (const pattern of blockPrefixPatterns) {
      const match = core.match(pattern);
      if (match) {
        const prefix = match[1];
        const content = match[2];
        return leadingSpaces + prefix + "==" + content + "==" + trailingSpaces;
      }
    }

    return leadingSpaces + "==" + core + "==" + trailingSpaces;
  }

  /*────────── DOM helpers ──────────*/
  getPreviewEl(view: MarkdownView): Element | null {
    return (
      view.containerEl.querySelector(".markdown-reading-view") ??
      view.containerEl.querySelector(".markdown-preview-view")
    );
  }

  /*────────── Scroll helpers ──────────*/
  getScroll(view: MarkdownView): number | { x: number; y: number } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const preview = (view as any).previewMode;
    return typeof preview?.getScroll === "function"
      ? preview.getScroll()
      : this.getFallbackScroll(view);
  }

  applyScroll(view: MarkdownView, pos: number | { x: number; y: number }): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const preview = (view as any).previewMode;
    if (typeof preview?.applyScroll === "function") preview.applyScroll(pos);
    else this.setFallbackScroll(view, pos as { x: number; y: number });
  }

  getFallbackScroll(view: MarkdownView): { x: number; y: number } {
    const el = this.getPreviewEl(view);
    return { x: 0, y: el?.scrollTop ?? 0 };
  }

  setFallbackScroll(view: MarkdownView, { y }: { x?: number; y: number }): void {
    const el = this.getPreviewEl(view);
    if (el) el.scrollTop = y;
  }

  /*────────── Position helpers ──────────*/
  /**
   * Resolve the source-markdown byte range for the markdown block
   * (paragraph / heading / list item / …) containing `node`. Obsidian
   * annotates blocks with `data-sourcepos="line:col-line:col"` (1-indexed,
   * end column is the last character). Returns null if no ancestor within
   * 10 levels carries sourcepos metadata.
   */
  sourcePosRangeForNode(node: Node | null): SourcePosRange | null {
    if (!node) return null;
    let el: HTMLElement | null =
      node.nodeType === Node.TEXT_NODE
        ? (node as Text).parentElement
        : (node as HTMLElement);
    let count = 0;
    while (el && !el.getAttribute("data-sourcepos") && count < 10) {
      el = el.parentElement;
      count++;
    }
    if (!el) return null;
    const attr = el.getAttribute("data-sourcepos");
    if (!attr) return null;

    const [startStr, endStr] = attr.split("-");
    if (!startStr || !endStr) return null;

    const viewData = this.app.workspace
      .getActiveViewOfType(MarkdownView)
      ?.getViewData();
    if (!viewData) return null;
    const lines = viewData.split("\n");

    const startOffset = this.lineColToOffset(lines, startStr);
    if (startOffset == null) return null;
    const endOffset = this.lineColToOffset(lines, endStr);
    if (endOffset == null) return null;

    // sourcepos end column points at the last character — bump by 1 so the
    // slice is exclusive-end and includes that character. Clamp to length.
    const end = Math.min(viewData.length, endOffset + 1);
    if (end <= startOffset) return null;

    return { start: startOffset, end };
  }

  lineColToOffset(lines: string[], lineCol: string): number | null {
    const [lStr, cStr] = lineCol.split(":");
    const line = parseInt(lStr, 10);
    const col = parseInt(cStr, 10);
    if (isNaN(line) || isNaN(col) || line < 1) return null;

    let off = 0;
    for (let i = 0; i < line - 1; i++) {
      if (lines[i] === undefined) return null;
      off += lines[i].length + 1; // +1 for the newline
    }
    if (lines[line - 1] === undefined) return null;
    return off + Math.max(0, col - 1);
  }

  /*────────── Enhanced search with link handling ──────────*/
  findMatchWithLinks(source: string, snippet: string): NullablePair {
    /* A. Unique direct match */
    const direct = this.uniqueDirectMatch(source, snippet);
    if (direct[0] != null) return direct;

    // Typography: selections made in reading mode carry the rendered form
    // (smart quotes, en/em-dash, ellipsis), which won't appear verbatim in
    // the markdown source. Denormalize the snippet and retry as needed.
    const denormSnippet = this.typographyDenormalize(snippet);
    const snippetChanged = denormSnippet !== snippet;

    if (snippetChanged) {
      const denormDirect = this.uniqueDirectMatch(source, denormSnippet);
      if (denormDirect[0] != null) return denormDirect;
    }

    /* B. Position map + search in rendered text */
    const positionMap = this.createPositionMap(source);
    const rendered = positionMap.renderedText;

    const renderedMatch = this.findBestMatch(rendered, snippet);
    if (renderedMatch[0] != null) {
      return this.mapRenderedPositionsToSource(positionMap, renderedMatch);
    }
    if (snippetChanged) {
      const renderedDenorm = this.findBestMatch(rendered, denormSnippet);
      if (renderedDenorm[0] != null) {
        return this.mapRenderedPositionsToSource(positionMap, renderedDenorm);
      }
    }

    /* C. Flexible fallback */
    const flex = this.findFlexibleMatch(source, snippet);
    if (flex[0] != null) return flex;
    if (snippetChanged) {
      const flexDenorm = this.findFlexibleMatch(source, denormSnippet);
      if (flexDenorm[0] != null) return flexDenorm;
    }

    return [null, null];
  }

  /**
   * Map typography-rendered characters back to their markdown source
   * equivalents: smart quotes → straight, en/em-dash → --/---, ellipsis
   * → ..., non-breaking space → space.
   */
  typographyDenormalize(s: string): string {
    let out = "";
    for (const c of s) {
      switch (c) {
        case "\u2018":
        case "\u2019":
          out += "'";
          break;
        case "\u201C":
        case "\u201D":
          out += '"';
          break;
        case "\u2013":
          out += "--";
          break;
        case "\u2014":
          out += "---";
          break;
        case "\u2026":
          out += "...";
          break;
        case "\u00A0":
          out += " ";
          break;
        default:
          out += c;
      }
    }
    return out;
  }

  /*────────── Create position map ──────────*/
  createPositionMap(source: string): PositionMap {
    const map: PositionMapEntry[] = [];
    let renderedText = "";
    let sourcePos = 0;

    while (sourcePos < source.length) {
      const char = source[sourcePos];

      // Backslash escapes \X → X (for markdown punctuation). Obsidian
      // strips the backslash when rendering, so the DOM selection contains
      // just X. We map the full two-char escape to a single rendered char.
      if (
        char === "\\" &&
        sourcePos + 1 < source.length &&
        this.isMarkdownEscapable(source[sourcePos + 1])
      ) {
        map.push({
          sourceStart: sourcePos,
          sourceEnd: sourcePos + 2,
          renderedPos: renderedText.length,
          isInLink: false,
          linkType: null,
        });
        renderedText += source[sourcePos + 1];
        sourcePos += 2;
        continue;
      }

      // Markdown links [text](url)
      if (char === "[") {
        const mdLinkMatch = source
          .slice(sourcePos)
          .match(/^\[([^\]]+)\]\([^)]*\)/);
        if (mdLinkMatch) {
          const fullMatch = mdLinkMatch[0];
          const linkText = mdLinkMatch[1];

          for (let i = 0; i < linkText.length; i++) {
            map.push({
              sourceStart: sourcePos,
              sourceEnd: sourcePos + fullMatch.length,
              renderedPos: renderedText.length + i,
              isInLink: true,
              linkType: "markdown",
            });
          }

          renderedText += linkText;
          sourcePos += fullMatch.length;
          continue;
        }

        // Wikilinks [[link|text]] or [[link]]
        const wikiLinkMatch = source
          .slice(sourcePos)
          .match(/^\[\[([^\]|]*?)(?:\|([^\]]*?))?\]\]/);
        if (wikiLinkMatch) {
          const fullMatch = wikiLinkMatch[0];
          const displayText = wikiLinkMatch[2] || wikiLinkMatch[1];

          for (let i = 0; i < displayText.length; i++) {
            map.push({
              sourceStart: sourcePos,
              sourceEnd: sourcePos + fullMatch.length,
              renderedPos: renderedText.length + i,
              isInLink: true,
              linkType: "wiki",
            });
          }

          renderedText += displayText;
          sourcePos += fullMatch.length;
          continue;
        }
      }

      // Inline markdown formatting
      if (
        char === "*" ||
        char === "_" ||
        char === "=" ||
        char === "`" ||
        char === "~"
      ) {
        const formatting = this.detectFormatting(source, sourcePos);
        if (formatting) {
          const spanStart = sourcePos;
          const spanEnd = sourcePos + formatting.fullLength;
          const rawContent = formatting.content;
          let ci = 0;
          // Every rendered char inside the span points at the FULL span
          // (delimiters included), mirroring how links are handled. This
          // means a selection that begins inside `**foo**` will include
          // the `**` delimiters in the highlighted range — otherwise the
          // resulting markdown becomes `**==foo==**` and nests badly.
          while (ci < rawContent.length) {
            if (
              rawContent[ci] === "\\" &&
              ci + 1 < rawContent.length &&
              this.isMarkdownEscapable(rawContent[ci + 1])
            ) {
              map.push({
                sourceStart: spanStart,
                sourceEnd: spanEnd,
                renderedPos: renderedText.length,
                isInLink: false,
                linkType: null,
              });
              renderedText += rawContent[ci + 1];
              ci += 2;
            } else {
              map.push({
                sourceStart: spanStart,
                sourceEnd: spanEnd,
                renderedPos: renderedText.length,
                isInLink: false,
                linkType: null,
              });
              renderedText += rawContent[ci];
              ci++;
            }
          }

          sourcePos += formatting.fullLength;
          continue;
        }
      }

      // Normal character
      map.push({
        sourceStart: sourcePos,
        sourceEnd: sourcePos + 1,
        renderedPos: renderedText.length,
        isInLink: false,
        linkType: null,
      });

      renderedText += char;
      sourcePos++;
    }

    return { renderedText, map };
  }

  /**
   * ASCII-punctuation characters that become literal when preceded by `\`
   * in CommonMark / Obsidian. Used to strip `\` from the rendered form
   * without consuming backslashes that aren't acting as escapes.
   */
  isMarkdownEscapable(ch: string): boolean {
    return /[\\`*_{}[\]()#+\-.!|<>~"']/.test(ch);
  }

  /*────────── Detect markdown formatting ──────────*/
  detectFormatting(source: string, pos: number): FormattingMatch | null {
    const remaining = source.slice(pos);

    // Order matters: longer delimiters first.
    const patterns: Array<{ regex: RegExp; offset: number }> = [
      { regex: /^\*\*\*(.*?)\*\*\*/, offset: 3 },
      { regex: /^___(.*?)___/, offset: 3 },
      { regex: /^\*\*(.*?)\*\*/, offset: 2 },
      { regex: /^__(.*?)__/, offset: 2 },
      { regex: /^~~(.*?)~~/, offset: 2 },
      { regex: /^\*(.*?)\*/, offset: 1 },
      { regex: /^_(.*?)_/, offset: 1 },
      { regex: /^==(.*?)==/, offset: 2 },
      { regex: /^`([^`]+)`/, offset: 1 },
    ];

    for (const { regex, offset } of patterns) {
      const match = remaining.match(regex);
      if (match) {
        return {
          content: match[1],
          startOffset: offset,
          fullLength: match[0].length,
        };
      }
    }

    return null;
  }

  /*────────── Find best match ──────────*/
  findBestMatch(text: string, snippet: string): NullablePair {
    const normalizedSnippet = snippet.trim();

    const exactMatch = this.uniqueDirectMatch(text, normalizedSnippet);
    if (exactMatch[0] != null) return exactMatch;

    // Try again with collapsed whitespace
    const normalizedText = text.replace(/\s+/g, " ");
    const normalizedSnippetSpaces = normalizedSnippet.replace(/\s+/g, " ");

    let pos = 0;
    const matches: Array<[number, number]> = [];

    while (
      (pos = normalizedText.indexOf(normalizedSnippetSpaces, pos)) !== -1
    ) {
      matches.push([pos, pos + normalizedSnippetSpaces.length]);
      pos++;
    }

    if (matches.length === 1) {
      return this.mapNormalizedToOriginal(text, normalizedText, matches[0]);
    }

    return [null, null];
  }

  /*────────── Map normalized text → original ──────────*/
  mapNormalizedToOriginal(
    originalText: string,
    normalizedText: string,
    [normalizedStart, normalizedEnd]: [number, number]
  ): NullablePair {
    let originalPos = 0;
    let normalizedPos = 0;
    let originalStart: number | null = null;
    let originalEnd: number | null = null;

    while (
      originalPos < originalText.length &&
      normalizedPos <= normalizedEnd
    ) {
      if (normalizedPos === normalizedStart && originalStart === null) {
        originalStart = originalPos;
      }

      const originalChar = originalText[originalPos];
      const normalizedChar = normalizedText[normalizedPos];

      if (originalChar === normalizedChar) {
        originalPos++;
        normalizedPos++;
      } else if (/\s/.test(originalChar)) {
        // Multiple spaces in original = one space in normalized
        originalPos++;
        while (
          originalPos < originalText.length &&
          /\s/.test(originalText[originalPos])
        ) {
          originalPos++;
        }
        normalizedPos++;
      } else {
        originalPos++;
      }

      if (normalizedPos === normalizedEnd && originalEnd === null) {
        originalEnd = originalPos;
      }
    }

    return [originalStart, originalEnd];
  }

  /*────────── Map rendered positions → source ──────────*/
  mapRenderedPositionsToSource(
    positionMap: PositionMap,
    [renderedStart, renderedEnd]: [number | null, number | null]
  ): NullablePair {
    const { map } = positionMap;

    let startEntry: PositionMapEntry | null = null;
    let endEntry: PositionMapEntry | null = null;

    for (const entry of map) {
      if (entry.renderedPos === renderedStart && startEntry === null) {
        startEntry = entry;
      }
      if (renderedEnd != null && entry.renderedPos === renderedEnd - 1) {
        endEntry = entry;
      }
    }

    if (!startEntry || !endEntry) return [null, null];

    // If both endpoints fall inside the SAME containing span (link, inline
    // formatting, or multi-char escape sequence), return that span's full
    // range. Every character inside such a span shares the same
    // sourceStart/sourceEnd, so that's what we check.
    if (
      startEntry.sourceStart === endEntry.sourceStart &&
      startEntry.sourceEnd === endEntry.sourceEnd
    ) {
      return [startEntry.sourceStart, startEntry.sourceEnd];
    }

    return [startEntry.sourceStart, endEntry.sourceEnd];
  }

  /*────────── Flexible search ──────────*/
  findFlexibleMatch(source: string, snippet: string): NullablePair {
    const words = snippet.trim().split(/\s+/);
    if (words.length < 2) return [null, null];

    const firstWord = this.escapeForRegex(words[0]);
    const lastWord = this.escapeForRegex(words[words.length - 1]);

    try {
      const regex = new RegExp(`${firstWord}[\\s\\S]*?${lastWord}`, "gi");
      const matches = [...source.matchAll(regex)];

      const validMatches = matches.filter(
        (match) => match[0].length <= snippet.length * 3
      );

      if (validMatches.length === 1) {
        const match = validMatches[0];
        return [match.index!, match.index! + match[0].length];
      }
    } catch {
      // Regex failed — give up
    }

    return [null, null];
  }

  /*────────── Helper methods ──────────*/
  uniqueDirectMatch(src: string, text: string): NullablePair {
    if (!text) return [null, null];
    const idx = src.indexOf(text);
    if (idx === -1) return [null, null];
    // Check for any other occurrence, including overlapping ones (e.g.
    // "aa" inside "aaa" would otherwise be falsely reported as unique).
    if (src.indexOf(text, idx + 1) !== -1) return [null, null];
    return [idx, idx + text.length];
  }

  escapeForRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
