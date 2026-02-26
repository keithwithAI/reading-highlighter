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

type NullablePair = [number | null, number | null];

export default class ReadingHighlighterPlugin extends Plugin {
  floatingButtonEl: HTMLButtonElement | null = null;
  boundHandleSelectionChange: (() => void) | null = null;

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
      const btn = this.addRibbonIcon("highlighter", "Highlight selection", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.getMode() === "preview") this.highlightSelection(view);
        else new Notice("Open the note in reading mode first.");
      });
      this.register(() => btn.remove());
    }

    /*── Floating button logic ──*/
    this.createFloatingButton();
    this.boundHandleSelectionChange = this.handleSelectionChange.bind(this);
    this.registerDomEvent(document, "selectionchange", this.boundHandleSelectionChange);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        // Update button state when the active leaf changes
        this.handleSelectionChange();
      })
    );
    // Initial check in case a selection exists when the plugin loads
    this.handleSelectionChange();
  }

  onunload(): void {
    // Obsidian automatically unregisters registerDomEvent and registerEvent listeners
    if (this.floatingButtonEl) {
      this.floatingButtonEl.remove();
      this.floatingButtonEl = null;
    }
  }

  createFloatingButton(): void {
    if (this.floatingButtonEl) return;

    this.floatingButtonEl = document.createElement("button");
    setIcon(this.floatingButtonEl, "highlighter");
    this.floatingButtonEl.setAttribute("aria-label", "Highlight selection");
    this.floatingButtonEl.addClass("reading-highlighter-float-btn");

    this.registerDomEvent(this.floatingButtonEl, "click", () => {
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
      // Verify the selection is actually within the reading view content
      const anchorNode = sel.anchorNode;
      const previewEl = view.containerEl.querySelector(".markdown-reading-view") ??
                        view.containerEl.querySelector(".markdown-preview-view");
      if (previewEl && anchorNode && previewEl.contains(anchorNode)) {
        this.showFloatingButton();
      } else {
        this.hideFloatingButton();
      }
    } else {
      this.hideFloatingButton();
    }
  }

  showFloatingButton(): void {
    if (this.floatingButtonEl) {
      this.floatingButtonEl.style.display = "block";
    }
  }

  hideFloatingButton(): void {
    if (this.floatingButtonEl) {
      this.floatingButtonEl.style.display = "none";
    }
  }

  /*───────────────── Main logic ─────────────────*/
  async highlightSelection(view: MarkdownView): Promise<void> {
    const sel = document.getSelection();
    const snippet = sel?.toString() ?? "";
    if (!snippet.trim()) {
      new Notice("Select text first — nothing selected.");
      return;
    }

    /* 1. Save scroll position */
    const scrollBefore = this.getScroll(view);

    /* 2. Get file reference */
    const file = view.file;
    if (!file) return;

    /* 3. Pre-compute DOM-based positions before entering process() */
    const a1 = this.posViaSourcePos(sel?.anchorNode ?? null);
    const b1 = this.posViaSourcePos(sel?.focusNode ?? null);

    /* 4. Atomically read + modify the file */
    let found = true;

    await this.app.vault.process(file, (raw: string): string => {
      let a_orig: number | undefined;
      let b_orig: number | undefined;

      if (a1 != null && b1 != null) {
        [a_orig, b_orig] = [Math.min(a1, b1), Math.max(a1, b1)];
      }

      const invalidSourcePos =
        a_orig == null ||
        b_orig == null ||
        b_orig <= a_orig ||
        a_orig < 0 ||
        b_orig > raw.length;

      if (invalidSourcePos) {
        const pos_fallback = this.findMatchWithLinks(raw, snippet);
        if (pos_fallback[0] == null || pos_fallback[1] == null) {
          found = false;
          return raw;
        }
        [a_orig, b_orig] = pos_fallback as [number, number];
      }

      let currentA = a_orig;
      let currentB = b_orig;
      let textToHighlight = raw.slice(currentA, currentB);
      const textBeforeSelection = raw.slice(0, currentA);

      // Inline formatting delimiters to check, from longest to shortest.
      // If the selection falls inside a formatting span, expand to include
      // both the opening AND closing delimiters so the result is valid markdown.
      const inlineDelimiters = ["***", "___", "**", "__", "~~", "*", "_", "`"];
      const textAfterSelection = raw.slice(currentB);

      for (const delim of inlineDelimiters) {
        if (textBeforeSelection.endsWith(delim) && textAfterSelection.startsWith(delim)) {
          textToHighlight = delim + textToHighlight + delim;
          currentA -= delim.length;
          currentB += delim.length;
          break;
        }
      }

      /* Process the selected text by paragraphs */
      const updatedText = this.addHighlightsByParagraph(textToHighlight);

      return raw.slice(0, currentA) + updatedText + raw.slice(currentB);
    });

    if (!found) {
      new Notice("Unable to locate the selection in the file.");
      return;
    }

    /* 5. Restore scroll (double pass) */
    const restore = () => this.applyScroll(view, scrollBefore);
    requestAnimationFrame(() => {
      restore();
      setTimeout(restore, 50);
    });

    sel?.removeAllRanges();
  }

  /*────────── Add highlights by paragraph ──────────*/
  addHighlightsByParagraph(text: string): string {
    // Split into paragraphs while preserving the exact separators (blank lines
    // may contain whitespace) so the file content isn't silently modified.
    const parts = text.split(/(\n\s*\n)/);
    // parts alternates: [content, separator, content, separator, ...]

    if (parts.length === 1) {
      // Single paragraph — process line by line
      const lines = text.split("\n");
      if (lines.length === 1) {
        return this.addHighlightToLine(text);
      }
      return lines
        .map((line) => (line.trim() ? this.addHighlightToLine(line) : line))
        .join("\n");
    }

    // Multiple paragraphs — highlight content parts, keep separators intact
    return parts
      .map((part, index) => {
        // Odd indices are separators — return as-is
        if (index % 2 === 1) return part;
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
    // Preserve leading whitespace
    const leadingMatch = line.match(/^(\s*)/);
    const leadingSpaces = leadingMatch ? leadingMatch[1] : "";
    const trailingMatch = line.match(/(\s*)$/);
    const trailingSpaces = trailingMatch ? trailingMatch[1] : "";
    const core = line.slice(leadingSpaces.length, line.length - trailingSpaces.length);

    if (!core.trim()) return line;

    // Block-level prefixes: == must go AFTER these markers
    const blockPrefixPatterns: RegExp[] = [
      /^(#{1,6}\s+)(.*)$/, // Headers: # ## ### etc.
      /^(>\s+)(.*)$/, // Blockquotes: >
      /^([-*+]\s+)(.*)$/, // Unordered list: - * +
      /^(\d+\.\s+)(.*)$/, // Ordered list: 1. 2. etc.
    ];

    for (const pattern of blockPrefixPatterns) {
      const match = core.match(pattern);
      if (match) {
        const prefix = match[1];
        const content = match[2];
        return leadingSpaces + prefix + "==" + content + "==" + trailingSpaces;
      }
    }

    // No block-level prefix: wrap the whole line
    return leadingSpaces + "==" + core + "==" + trailingSpaces;
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
    const el =
      view.containerEl.querySelector(".markdown-reading-view") ??
      view.containerEl.querySelector(".markdown-preview-view");
    return { x: 0, y: el?.scrollTop ?? 0 };
  }

  setFallbackScroll(view: MarkdownView, { y }: { x?: number; y: number }): void {
    const el =
      view.containerEl.querySelector(".markdown-reading-view") ??
      view.containerEl.querySelector(".markdown-preview-view");
    if (el) el.scrollTop = y;
  }

  /*────────── Position helpers ──────────*/
  posViaSourcePos(node: Node | null): number | null {
    if (!node) return null;
    let el: HTMLElement | null =
      node.nodeType === Node.TEXT_NODE ? (node as Text).parentElement : (node as HTMLElement);
    // Traverse up to 5 levels
    let count = 0;
    while (el && !el.getAttribute("data-sourcepos") && count < 5) {
      el = el.parentElement;
      count++;
    }
    if (!el || !el.getAttribute("data-sourcepos")) return null;
    const sourcePosAttr = el.getAttribute("data-sourcepos");
    if (!sourcePosAttr) return null;

    const [start] = sourcePosAttr.split("-");
    const [lStr, cStr] = start.split(":");

    const l = parseInt(lStr, 10);
    const c = parseInt(cStr, 10);
    if (isNaN(l) || isNaN(c)) return null;

    const viewData = this.app.workspace
      .getActiveViewOfType(MarkdownView)
      ?.getViewData();
    if (!viewData) return null;

    const lines = viewData.split("\n");
    let off = 0;
    // l-1 because sourcepos is 1-indexed
    for (let i = 0; i < l - 1; i++) {
      if (lines[i] === undefined) return null;
      off += lines[i].length + 1;
    }
    // c-1 because sourcepos is 1-indexed
    return off + (c - 1);
  }

  /*────────── Enhanced search with link handling ──────────*/
  findMatchWithLinks(source: string, snippet: string): NullablePair {
    /* A. Find unique direct match */
    const direct = this.uniqueDirectMatch(source, snippet);
    if (direct[0] != null) return direct;

    /* B. Create position map and search in rendered text */
    const positionMap = this.createPositionMap(source);
    const rendered = positionMap.renderedText;

    // Search in rendered text
    const renderedMatch = this.findBestMatch(rendered, snippet);
    if (renderedMatch[0] != null) {
      // Convert rendered text positions back to markdown source
      return this.mapRenderedPositionsToSource(positionMap, renderedMatch);
    }

    /* C. Flexible search as fallback */
    return this.findFlexibleMatch(source, snippet);
  }

  /*────────── Create position map ──────────*/
  createPositionMap(source: string): PositionMap {
    const map: PositionMapEntry[] = [];
    let renderedText = "";
    let sourcePos = 0;

    while (sourcePos < source.length) {
      const char = source[sourcePos];

      // Detect markdown links [text](url)
      if (char === "[") {
        const mdLinkMatch = source.slice(sourcePos).match(/^\[([^\]]+)\]\([^)]*\)/);
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

        // Detect wikilinks [[link|text]] or [[link]]
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

      // Detect other common markdown formatting
      if (
        char === "*" ||
        char === "_" ||
        char === "=" ||
        char === "`" ||
        char === "~"
      ) {
        const formatting = this.detectFormatting(source, sourcePos);
        if (formatting) {
          for (let i = 0; i < formatting.content.length; i++) {
            map.push({
              sourceStart: sourcePos + formatting.startOffset,
              sourceEnd:
                sourcePos + formatting.startOffset + formatting.content.length,
              renderedPos: renderedText.length + i,
              isInLink: false,
              linkType: null,
            });
          }

          renderedText += formatting.content;
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

  /*────────── Detect markdown formatting ──────────*/
  detectFormatting(source: string, pos: number): FormattingMatch | null {
    const remaining = source.slice(pos);

    // Order matters: check longer delimiters before shorter ones.
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

    // Search for exact match
    const exactMatch = this.uniqueDirectMatch(text, normalizedSnippet);
    if (exactMatch[0] != null) return exactMatch;

    // Search with normalized whitespace
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
      // Map back to original text
      return this.mapNormalizedToOriginal(text, normalizedText, matches[0]);
    }

    return [null, null];
  }

  /*────────── Map normalized text to original ──────────*/
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
      if (normalizedPos === normalizedStart) {
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

      if (normalizedPos === normalizedEnd) {
        originalEnd = originalPos;
      }
    }

    return [originalStart, originalEnd];
  }

  /*────────── Map rendered positions to source ──────────*/
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

    if (!startEntry || !endEntry) {
      return [null, null];
    }

    // If both are in the same link, use the full link span
    if (
      startEntry.isInLink &&
      endEntry.isInLink &&
      startEntry.sourceStart === endEntry.sourceStart
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
      const regex = new RegExp(
        `${firstWord}[\\s\\S]*?${lastWord}`,
        "gi"
      );
      const matches = [...source.matchAll(regex)];

      const validMatches = matches.filter(
        (match) => match[0].length <= snippet.length * 3
      );

      if (validMatches.length === 1) {
        const match = validMatches[0];
        return [match.index!, match.index! + match[0].length];
      }
    } catch {
      // Regex failed
    }

    return [null, null];
  }

  /*────────── Helper methods ──────────*/
  uniqueDirectMatch(src: string, text: string): NullablePair {
    const idx = src.indexOf(text);
    if (idx === -1) return [null, null];
    if (src.indexOf(text, idx + text.length) !== -1) return [null, null];
    return [idx, idx + text.length];
  }

  escapeForRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
