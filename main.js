/* eslint-disable no-undef */
const { Plugin, MarkdownView, Notice, Platform, setIcon } = require("obsidian");

class ReadingHighlighterPlugin extends Plugin {
  floatingButtonEl = null;
  boundHandleSelectionChange = null;

  onload() {
    /*── Command palette ──*/
    this.addCommand({
      id: "highlight-selection-reading",
      name: "Highlight selection in reading mode",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== "preview") return false;
        if (checking) return true;
        this.highlightSelection(view);
        return true;
      },
    });

    /*── Desktop shortcut ──*/
    this.registerDomEvent(document, "keydown", (evt) => {
      if (evt.shiftKey && evt.key === "H") {
        // Don't trigger when typing in inputs, textareas, or contenteditable elements
        const tag = evt.target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || evt.target?.isContentEditable) return;

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.getMode() === "preview") {
          this.highlightSelection(view);
          evt.preventDefault();
        }
      }
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

  onunload() {
    // Obsidian automatically unregisters registerDomEvent and registerEvent listeners
    if (this.floatingButtonEl) {
      this.floatingButtonEl.remove();
      this.floatingButtonEl = null;
    }
  }

  createFloatingButton() {
    if (this.floatingButtonEl) return;

    this.floatingButtonEl = document.createElement("button");
    setIcon(this.floatingButtonEl, "highlighter");
    this.floatingButtonEl.setAttribute("aria-label", "Highlight selection");
    this.floatingButtonEl.addClass("reading-highlighter-float-btn");

    // Basic styles (consider moving to styles.css for better maintainability)
    this.floatingButtonEl.style.position = "fixed";
    this.floatingButtonEl.style.bottom = "30px";
    this.floatingButtonEl.style.left = "50%";
    this.floatingButtonEl.style.transform = "translateX(-50%)";
    this.floatingButtonEl.style.zIndex = "1000";
    this.floatingButtonEl.style.padding = "10px 15px";
    this.floatingButtonEl.style.border = "none";
    this.floatingButtonEl.style.borderRadius = "8px";
    this.floatingButtonEl.style.cursor = "pointer";
    this.floatingButtonEl.style.boxShadow = "0 4px 8px rgba(0,0,0,0.2)";
    this.floatingButtonEl.style.backgroundColor = "var(--interactive-accent)";
    this.floatingButtonEl.style.color = "var(--text-on-accent)";
    this.floatingButtonEl.style.display = "none"; // Initially hidden

    this.registerDomEvent(this.floatingButtonEl, "click", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.getMode() === "preview") {
        this.highlightSelection(view);
      }
      this.hideFloatingButton(); // Hide after click
    });

    document.body.appendChild(this.floatingButtonEl);
  }

  handleSelectionChange() {
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

  showFloatingButton() {
    if (this.floatingButtonEl) {
      this.floatingButtonEl.style.display = "block";
    }
  }

  hideFloatingButton() {
    if (this.floatingButtonEl) {
      this.floatingButtonEl.style.display = "none";
    }
  }

  /*───────────────── Main logic ─────────────────*/
  async highlightSelection(view) {
    const sel = document.getSelection();
    const snippet = sel?.toString() ?? "";
    if (!snippet.trim()) {
      new Notice("Select text first — nothing selected.");
      return;
    }

    /* 1. Save scroll position */
    const scrollBefore = this.getScroll(view);

    /* 2. Read file */
    const file = view.file;
    const raw = await this.app.vault.read(file);

    /* 3. Locate the selection */
    let a_orig, b_orig; // Use temporary variables for original positions
    const a1 = this.posViaSourcePos(sel?.anchorNode);
    const b1 = this.posViaSourcePos(sel?.focusNode);

    if (a1 != null && b1 != null) {
      [a_orig, b_orig] = [Math.min(a1, b1), Math.max(a1, b1)];
    } else {
      const pos_fallback = this.findMatchWithLinks(raw, snippet);
      if (pos_fallback[0] == null || pos_fallback[1] == null) {
        new Notice("Unable to locate the selection in the file.");
        return;
      }
      [a_orig, b_orig] = pos_fallback;
    }

    if (a_orig == null || b_orig == null) {
      new Notice("Unable to locate the selection in the file.");
      return;
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

    /* 4. Process the selected text by paragraphs */
    // Use the potentially modified textToHighlight
    const updatedText = this.addHighlightsByParagraph(textToHighlight);

    /* 5. Replace in file */
    // Use the adjusted 'currentA' and original 'currentB' (or b_orig)
    const updated = raw.slice(0, currentA) + updatedText + raw.slice(currentB);
    await this.app.vault.modify(file, updated);

    /* 6. Restore scroll (double pass) */
    const restore = () => this.applyScroll(view, scrollBefore);
    requestAnimationFrame(() => {
      restore();
      setTimeout(restore, 50);
    });

    sel?.removeAllRanges();
  }

  /*────────── Add highlights by paragraph ──────────*/
  addHighlightsByParagraph(text) {
    // Split into paragraphs while preserving the exact separators (blank lines
    // may contain whitespace) so the file content isn't silently modified.
    const parts = text.split(/(\n\s*\n)/);
    // parts alternates: [content, separator, content, separator, ...]

    if (parts.length === 1) {
      // Single paragraph — process line by line
      const lines = text.split('\n');
      if (lines.length === 1) {
        return this.addHighlightToLine(text);
      }
      return lines.map(line => {
        return line.trim() ? this.addHighlightToLine(line) : line;
      }).join('\n');
    }

    // Multiple paragraphs — highlight content parts, keep separators intact
    return parts.map((part, index) => {
      // Odd indices are separators — return as-is
      if (index % 2 === 1) return part;

      if (!part.trim()) return part;

      const lines = part.split('\n');
      return lines.map(line => {
        return line.trim() ? this.addHighlightToLine(line) : line;
      }).join('\n');
    }).join('');
  }

  /*────────── Add highlight to a single line ──────────*/
  addHighlightToLine(line) {
    // Preserve leading whitespace
    const leadingSpaces = line.match(/^(\s*)/)[1];
    const trimmedLine = line.trim();

    if (!trimmedLine) return line;

    // Block-level prefixes: == must go AFTER these markers
    const blockPrefixPatterns = [
      /^(#{1,6}\s+)(.*)$/,      // Headers: # ## ### etc.
      /^(>\s+)(.*)$/,            // Blockquotes: >
      /^([-*+]\s+)(.*)$/,       // Unordered list: - * +
      /^(\d+\.\s+)(.*)$/,       // Ordered list: 1. 2. etc.
    ];

    for (const pattern of blockPrefixPatterns) {
      const match = trimmedLine.match(pattern);
      if (match) {
        const prefix = match[1];
        const content = match[2];
        return leadingSpaces + prefix + '==' + content + '==';
      }
    }

    // No block-level prefix: wrap the whole line
    return leadingSpaces + '==' + trimmedLine + '==';
  }

  /*────────── Scroll helpers ──────────*/
  getScroll(view) {
    return typeof view.previewMode?.getScroll === "function"
      ? view.previewMode.getScroll()
      : this.getFallbackScroll(view);
  }
  applyScroll(view, pos) {
    if (typeof view.previewMode?.applyScroll === "function")
      view.previewMode.applyScroll(pos);
    else this.setFallbackScroll(view, pos);
  }
  getFallbackScroll(view) {
    const el =
      view.containerEl.querySelector(".markdown-reading-view") ??
      view.containerEl.querySelector(".markdown-preview-view");
    return { x: 0, y: el?.scrollTop ?? 0 };
  }
  setFallbackScroll(view, { y }) {
    const el =
      view.containerEl.querySelector(".markdown-reading-view") ??
      view.containerEl.querySelector(".markdown-preview-view");
    if (el) el.scrollTop = y;
  }

  /*────────── Position helpers ──────────*/
  posViaSourcePos(node) {
    if (!node) return null;
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    // Traverse up to 5 levels, should be enough for most cases and prevents infinite loops.
    let count = 0;
    while (el && !el.getAttribute("data-sourcepos") && count < 5) {
        el = el.parentElement;
        count++;
    }
    if (!el || !el.getAttribute("data-sourcepos")) return null; // If not found or el is null
    const sourcePosAttr = el.getAttribute("data-sourcepos");
    if (!sourcePosAttr) return null; // Ensure attribute exists

    const [start] = sourcePosAttr.split("-");
    const [lStr, cStr] = start.split(":");

    // Ensure lStr and cStr are valid numbers before parsing
    const l = parseInt(lStr, 10);
    const c = parseInt(cStr, 10);

    if (isNaN(l) || isNaN(c)) return null; // Invalid position data

    const viewData = this.app.workspace
      .getActiveViewOfType(MarkdownView)
      ?.getViewData(); // Add optional chaining

    if (!viewData) return null; // Ensure viewData is available

    const lines = viewData.split("\n");
    let off = 0;
    // l-1 because sourcepos is 1-indexed
    for (let i = 0; i < l - 1; i++) {
        if (lines[i] === undefined) return null; // Safety check for out of bounds
        off += lines[i].length + 1; // +1 for newline character
    }
    // c-1 because sourcepos is 1-indexed
    return off + (c - 1);
  }


  /*────────── Enhanced search with link handling ──────────*/
  findMatchWithLinks(source, snippet) {
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
  createPositionMap(source) {
    const map = [];
    let renderedText = '';
    let sourcePos = 0;

    while (sourcePos < source.length) {
      const char = source[sourcePos];

      // Detect markdown links [text](url)
      if (char === '[') {
        const mdLinkMatch = source.slice(sourcePos).match(/^\[([^\]]+)\]\([^)]*\)/);
        if (mdLinkMatch) {
          const fullMatch = mdLinkMatch[0];
          const linkText = mdLinkMatch[1];

          // Map each character of the link text
          for (let i = 0; i < linkText.length; i++) {
            map.push({
              sourceStart: sourcePos,
              sourceEnd: sourcePos + fullMatch.length,
              renderedPos: renderedText.length + i,
              isInLink: true,
              linkType: 'markdown'
            });
          }

          renderedText += linkText;
          sourcePos += fullMatch.length;
          continue;
        }

        // Detect wikilinks [[link|text]] or [[link]]
        const wikiLinkMatch = source.slice(sourcePos).match(/^\[\[([^\]|]*?)(?:\|([^\]]*?))?\]\]/);
        if (wikiLinkMatch) {
          const fullMatch = wikiLinkMatch[0];
          const displayText = wikiLinkMatch[2] || wikiLinkMatch[1];

          // Map each character of the display text
          for (let i = 0; i < displayText.length; i++) {
            map.push({
              sourceStart: sourcePos,
              sourceEnd: sourcePos + fullMatch.length,
              renderedPos: renderedText.length + i,
              isInLink: true,
              linkType: 'wiki'
            });
          }

          renderedText += displayText;
          sourcePos += fullMatch.length;
          continue;
        }
      }

      // Detect other common markdown formatting
      if (char === '*' || char === '_' || char === '=' || char === '`' || char === '~') {
        const formatting = this.detectFormatting(source, sourcePos);
        if (formatting) {
          // Map the content without formatting delimiters
          for (let i = 0; i < formatting.content.length; i++) {
            map.push({
              sourceStart: sourcePos + formatting.startOffset,
              sourceEnd: sourcePos + formatting.startOffset + formatting.content.length,
              renderedPos: renderedText.length + i,
              isInLink: false,
              linkType: null
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
        linkType: null
      });

      renderedText += char;
      sourcePos++;
    }

    return { renderedText, map };
  }

  /*────────── Detect markdown formatting ──────────*/
  detectFormatting(source, pos) {
    const remaining = source.slice(pos);

    // Order matters: check longer delimiters before shorter ones.

    // Bold Italic ***text*** or ___text___
    const boldItalicAst = remaining.match(/^\*\*\*(.*?)\*\*\*/);
    if (boldItalicAst) {
      return { content: boldItalicAst[1], startOffset: 3, fullLength: boldItalicAst[0].length };
    }
    const boldItalicUnd = remaining.match(/^___(.*?)___/);
    if (boldItalicUnd) {
      return { content: boldItalicUnd[1], startOffset: 3, fullLength: boldItalicUnd[0].length };
    }

    // Bold **text** or __text__
    const boldAst = remaining.match(/^\*\*(.*?)\*\*/);
    if (boldAst) {
      return { content: boldAst[1], startOffset: 2, fullLength: boldAst[0].length };
    }
    const boldUnd = remaining.match(/^__(.*?)__/);
    if (boldUnd) {
      return { content: boldUnd[1], startOffset: 2, fullLength: boldUnd[0].length };
    }

    // Strikethrough ~~text~~
    const strikeMatch = remaining.match(/^~~(.*?)~~/);
    if (strikeMatch) {
      return { content: strikeMatch[1], startOffset: 2, fullLength: strikeMatch[0].length };
    }

    // Italic *text* or _text_
    const italicAst = remaining.match(/^\*(.*?)\*/);
    if (italicAst) {
      return { content: italicAst[1], startOffset: 1, fullLength: italicAst[0].length };
    }
    const italicUnd = remaining.match(/^_(.*?)_/);
    if (italicUnd) {
      return { content: italicUnd[1], startOffset: 1, fullLength: italicUnd[0].length };
    }

    // Highlight ==text==
    const highlightMatch = remaining.match(/^==(.*?)==/);
    if (highlightMatch) {
      return { content: highlightMatch[1], startOffset: 2, fullLength: highlightMatch[0].length };
    }

    // Inline code `text`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      return { content: codeMatch[1], startOffset: 1, fullLength: codeMatch[0].length };
    }

    return null;
  }

  /*────────── Find best match ──────────*/
  findBestMatch(text, snippet) {
    const normalizedSnippet = snippet.trim();

    // Search for exact match
    const exactMatch = this.uniqueDirectMatch(text, normalizedSnippet);
    if (exactMatch[0] != null) return exactMatch;

    // Search with normalized whitespace
    const normalizedText = text.replace(/\s+/g, ' ');
    const normalizedSnippetSpaces = normalizedSnippet.replace(/\s+/g, ' ');

    let pos = 0;
    const matches = [];

    while ((pos = normalizedText.indexOf(normalizedSnippetSpaces, pos)) !== -1) {
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
  mapNormalizedToOriginal(originalText, normalizedText, [normalizedStart, normalizedEnd]) {
    let originalPos = 0;
    let normalizedPos = 0;
    let originalStart = null;
    let originalEnd = null;

    while (originalPos < originalText.length && normalizedPos <= normalizedEnd) {
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
        while (originalPos < originalText.length && /\s/.test(originalText[originalPos])) {
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
  mapRenderedPositionsToSource(positionMap, [renderedStart, renderedEnd]) {
    const { map } = positionMap;

    // Find the first entry that corresponds to the start
    let startEntry = null;
    let endEntry = null;

    for (const entry of map) {
      if (entry.renderedPos === renderedStart && startEntry === null) {
        startEntry = entry;
      }
      if (entry.renderedPos === renderedEnd - 1) {
        endEntry = entry;
      }
    }

    if (!startEntry || !endEntry) {
      return [null, null];
    }

    // If both are in the same link, use the full link span
    if (startEntry.isInLink && endEntry.isInLink &&
        startEntry.sourceStart === endEntry.sourceStart) {
      return [startEntry.sourceStart, startEntry.sourceEnd];
    }

    return [startEntry.sourceStart, endEntry.sourceEnd];
  }

  /*────────── Flexible search ──────────*/
  findFlexibleMatch(source, snippet) {
    const words = snippet.trim().split(/\s+/);
    if (words.length < 2) return [null, null];

    const firstWord = this.escapeForRegex(words[0]);
    const lastWord = this.escapeForRegex(words[words.length - 1]);

    try {
      const regex = new RegExp(`${firstWord}[\\s\\S]*?${lastWord}`, 'gi');
      const matches = [...source.matchAll(regex)];

      const validMatches = matches.filter(match =>
        match[0].length <= snippet.length * 3
      );

      if (validMatches.length === 1) {
        const match = validMatches[0];
        return [match.index, match.index + match[0].length];
      }
    } catch (e) {
      // Regex failed
    }

    return [null, null];
  }

  /*────────── Helper methods ──────────*/
  uniqueDirectMatch(src, text) {
    const idx = src.indexOf(text);
    if (idx === -1) return [null, null];
    if (src.indexOf(text, idx + text.length) !== -1) return [null, null];
    return [idx, idx + text.length];
  }

  escapeForRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

module.exports = ReadingHighlighterPlugin;
module.exports.default = ReadingHighlighterPlugin;