import {
  Menu,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import {
  HighlightSpan,
  appendFootnoteDefinition,
  findHighlightSpans,
  getFootnoteDefinition,
  insertFootnoteRef,
  lineOfOffset,
  locateSpan,
  matchMarkToSpan,
  nextFootnoteLabel,
  removeFootnoteDefinition,
  removeHighlightSpan,
  sectionRange,
  setSpanNote,
} from "./highlights";
import { HIGHLIGHTS_VIEW_TYPE, HighlightsView } from "./highlights-view";
import { NoteModal } from "./note-modal";
import {
  DEFAULT_SETTINGS,
  ReadingHighlighterSettingTab,
  ReadingHighlighterSettings,
} from "./settings";

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

interface PreviewSection {
  el: HTMLElement;
  lines: number;
}

interface SelectionSnapshot {
  text: string;
  viewPath: string | null;
  paragraphStart: number | null;
  paragraphEnd: number | null;
}

interface ResolvedSelection {
  snippet: string;
  paragraphStart: number | null;
  paragraphEnd: number | null;
}

interface LastHighlightRecord {
  filePath: string;
  position: number;
  originalText: string;
  highlightedText: string;
  /** Set when the highlight was created with a note. */
  footnoteLabel: string | null;
}

/** Where a highlight was when it was read: its start and its source text. */
export interface SpanRef {
  start: number;
  text: string;
}

export interface HighlightEntry {
  ref: SpanRef;
  /** Rendered text, without markdown syntax. */
  text: string;
  note: string | null;
  /** Zero-based line of the highlight in the note. */
  line: number;
}

type NullablePair = [number | null, number | null];

export default class ReadingHighlighterPlugin extends Plugin {
  settings: ReadingHighlighterSettings = { ...DEFAULT_SETTINGS };
  toolbarEl: HTMLDivElement | null = null;
  bottomBarEl: HTMLDivElement | null = null;
  undoButtonEl: HTMLButtonElement | null = null;
  selectionSnapshot: SelectionSnapshot | null = null;
  lastHighlight: LastHighlightRecord | null = null;
  panelRefreshTimer: number | null = null;
  markClickTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ReadingHighlighterSettingTab(this.app, this));
    this.registerView(
      HIGHLIGHTS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new HighlightsView(leaf, this)
    );

    /*── Command palette ──*/
    this.addCommand({
      id: "highlight-selection-reading",
      name: "Highlight selection in reading mode",
      checkCallback: (checking: boolean) => {
        const view = this.getReadingView();
        if (!view) return false;
        if (checking) return true;
        void this.highlightSelection(view);
        return true;
      },
    });

    this.addCommand({
      id: "add-note-to-selection",
      name: "Highlight selection with a note",
      checkCallback: (checking: boolean) => {
        const view = this.getReadingView();
        if (!view) return false;
        if (checking) return true;
        this.noteSelection(view);
        return true;
      },
    });

    this.addCommand({
      id: "undo-last-highlight-reading",
      name: "Undo last highlight",
      checkCallback: (checking: boolean) => {
        const record = this.lastHighlight;
        if (!record) return false;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file?.path !== record.filePath) return false;
        if (checking) return true;
        void this.undoLastHighlight();
        return true;
      },
    });

    this.addCommand({
      id: "open-highlights-panel",
      name: "Open highlights panel",
      callback: () => void this.activatePanel(),
    });

    /*── Ribbon icon (mobile only) ──*/
    if (Platform.isMobile) {
      this.addRibbonIcon("highlighter", "Highlight selection", () => {
        const view = this.getReadingView();
        if (view) {
          void this.highlightSelection(view);
        } else {
          new Notice("Open the note in reading mode first.");
        }
      });
    }

    /*── Toolbar + bottom bar ──*/
    this.createBottomBar();
    this.createUndoButton();
    this.createToolbar();
    this.applyToolbarPlacement();
    this.registerDomEvent(activeDocument, "selectionchange", () =>
      this.handleSelectionChange()
    );
    // Keep the toolbar attached to the selection while the note scrolls.
    this.registerDomEvent(
      activeDocument,
      "scroll",
      () => {
        if (this.toolbarEl?.hasClass("is-visible")) this.handleSelectionChange();
      },
      { capture: true, passive: true }
    );
    this.registerDomEvent(activeDocument, "click", (evt: MouseEvent) =>
      this.handleReadingClick(evt)
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        // Different file/view → any cached selection is stale
        this.selectionSnapshot = null;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const path = view?.file?.path ?? null;
        if (this.lastHighlight && this.lastHighlight.filePath !== path) {
          this.lastHighlight = null;
          this.hideUndoButton();
        }
        this.handleSelectionChange();
        this.followActiveFile();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.followActiveFile())
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (this.getPanels().some((p) => p.showsFile(file.path))) {
          this.schedulePanelRefresh();
        }
      })
    );
    // Initial check in case a selection exists when the plugin loads
    this.handleSelectionChange();
  }

  onunload(): void {
    this.toolbarEl?.remove();
    this.toolbarEl = null;
    this.bottomBarEl?.remove();
    this.bottomBarEl = null;
    this.undoButtonEl = null;
    if (this.panelRefreshTimer != null) window.clearTimeout(this.panelRefreshTimer);
    if (this.markClickTimer != null) window.clearTimeout(this.markClickTimer);
    this.selectionSnapshot = null;
    this.lastHighlight = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<ReadingHighlighterSettings> | null
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getReadingView(): MarkdownView | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view && view.getMode() === "preview" ? view : null;
  }

  /*────────── Toolbar ──────────*/
  createBottomBar(): void {
    if (this.bottomBarEl) return;
    this.bottomBarEl = activeDocument.body.createDiv({
      cls: "reading-highlighter-bottom-bar",
    });
  }

  createToolbar(): void {
    if (this.toolbarEl) return;
    const bar = activeDocument.body.createDiv({ cls: "reading-highlighter-toolbar" });
    this.addToolbarButton(bar, "highlighter", "Highlight", () => {
      const view = this.getReadingView();
      if (view) void this.highlightSelection(view);
      this.hideToolbar();
    });
    this.addToolbarButton(bar, "message-square-plus", "Highlight with note", () => {
      const view = this.getReadingView();
      if (view) this.noteSelection(view);
      this.hideToolbar();
    });
    this.addToolbarButton(bar, "copy", "Copy", () => {
      const view = this.getReadingView();
      const resolved = view ? this.resolveSelection(view) : null;
      if (resolved) void this.copyText(resolved.snippet);
    });
    this.toolbarEl = bar;
  }

  addToolbarButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): void {
    const btn = parent.createEl("button", {
      cls: "reading-highlighter-toolbar-btn",
      attr: { type: "button", "aria-label": label },
    });
    setIcon(btn, icon);

    // mousedown default = focus the button, which collapses the text
    // selection in most browsers. Preventing it keeps the selection alive
    // until the click handler reads it.
    this.registerDomEvent(btn, "mousedown", (e: MouseEvent) => {
      e.preventDefault();
    });
    this.registerDomEvent(btn, "click", (e: MouseEvent) => {
      e.preventDefault();
      onClick();
    });
  }

  /** Dock the toolbar in the bottom bar, or float it next to the selection. */
  applyToolbarPlacement(): void {
    const bar = this.toolbarEl;
    if (!bar || !this.bottomBarEl) return;
    if (this.settings.toolbarPlacement === "bottom") {
      this.bottomBarEl.appendChild(bar);
      bar.addClass("is-docked");
    } else {
      activeDocument.body.appendChild(bar);
      bar.removeClass("is-docked");
    }
    this.handleSelectionChange();
  }

  handleSelectionChange(): void {
    const view = this.getReadingView();
    if (!view) {
      this.hideToolbar();
      return;
    }

    const sel = activeDocument.getSelection();
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
        this.showToolbar(sel.getRangeAt(0), previewEl);
        return;
      }
    }

    // Selection is collapsed / empty / outside the preview. Hide the toolbar,
    // but keep the most recent snapshot: tapping a button can collapse the
    // selection as a side effect and we still want that tap to succeed.
    this.hideToolbar();
  }

  showToolbar(range: Range, previewEl: Element): void {
    const bar = this.toolbarEl;
    if (!bar) return;
    bar.addClass("is-visible");
    if (this.settings.toolbarPlacement === "bottom") return;

    const rect = range.getBoundingClientRect();
    const bounds = previewEl.getBoundingClientRect();
    // Selection scrolled out of view: nothing to point at.
    if (rect.bottom < bounds.top || rect.top > bounds.bottom) {
      this.hideToolbar();
      return;
    }

    const margin = 8;
    // The iOS callout usually sits above the selection, so go below it, far
    // enough down to clear the selection's drag handle.
    const gap = Platform.isMobile ? 36 : 10;
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;

    let top = rect.bottom + gap;
    if (top + h > bounds.bottom - margin) top = rect.top - h - gap;
    top = Math.max(bounds.top + margin, Math.min(top, bounds.bottom - h - margin));

    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(bounds.left + margin, Math.min(left, bounds.right - w - margin));

    bar.setCssProps({
      "--reading-highlighter-toolbar-top": `${Math.round(top)}px`,
      "--reading-highlighter-toolbar-left": `${Math.round(left)}px`,
    });
  }

  hideToolbar(): void {
    this.toolbarEl?.removeClass("is-visible");
  }

  createUndoButton(): void {
    if (this.undoButtonEl || !this.bottomBarEl) return;

    this.undoButtonEl = this.bottomBarEl.createEl("button", {
      cls: "reading-highlighter-undo-btn",
      attr: { type: "button", "aria-label": "Undo last highlight" },
    });
    setIcon(this.undoButtonEl, "undo-2");

    this.registerDomEvent(this.undoButtonEl, "mousedown", (e: MouseEvent) => {
      e.preventDefault();
    });

    this.registerDomEvent(this.undoButtonEl, "click", (e: MouseEvent) => {
      e.preventDefault();
      void this.undoLastHighlight();
    });
  }

  showUndoButton(): void {
    this.undoButtonEl?.addClass("is-visible");
  }

  hideUndoButton(): void {
    this.undoButtonEl?.removeClass("is-visible");
  }

  async copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice("Copied.");
    } catch {
      new Notice("Couldn't copy to the clipboard.");
    }
  }

  /*───────────────── Main logic ─────────────────*/
  async highlightSelection(view: MarkdownView): Promise<void> {
    const resolved = this.resolveSelection(view);
    if (resolved) await this.applyHighlight(view, resolved);
  }

  /** Capture the selection, then ask for a note before highlighting. */
  noteSelection(view: MarkdownView): void {
    // Resolve now: opening the modal clears the selection on iOS.
    const resolved = this.resolveSelection(view);
    if (!resolved) return;
    this.hideToolbar();
    new NoteModal(this.app, {
      title: "Add note",
      quote: resolved.snippet.trim(),
      initialText: "",
      onSave: (text) => void this.applyHighlight(view, resolved, text),
    }).open();
  }

  /** Pick a selection: live if it's still there, otherwise the snapshot. */
  resolveSelection(view: MarkdownView): ResolvedSelection | null {
    const file = view.file;
    if (!file) return null;

    const sel = activeDocument.getSelection();
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
      return null;
    }

    if (!snippet.trim()) {
      new Notice("Select text first — nothing selected.");
      return null;
    }

    return { snippet, paragraphStart, paragraphEnd };
  }

  async applyHighlight(
    view: MarkdownView,
    resolved: ResolvedSelection,
    note?: string
  ): Promise<void> {
    const file = view.file;
    if (!file) return;
    const { snippet, paragraphStart, paragraphEnd } = resolved;
    const noteText = note?.trim() ?? "";

    /* 1. Save scroll position */
    const scrollBefore = this.getScroll(view);

    /* 2. Atomically read + modify the file */
    let found = true;
    let recordedPosition: number | null = null;
    let recordedOriginal: string | null = null;
    let recordedHighlighted: string | null = null;
    let recordedLabel: string | null = null;

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
        [a_orig, b_orig] = pos_fallback;
      }

      // Narrow a_orig/b_orig from `number | null` to `number` — by this point
      // either the window search set them, or the fallback above did. The
      // explicit guard is redundant logically but lets the type system see it.
      if (a_orig == null || b_orig == null) {
        found = false;
        return raw;
      }

      let currentA: number = a_orig;
      let currentB: number = b_orig;
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
      let updatedText = this.addHighlightsByParagraph(textToHighlight);
      const label = noteText ? nextFootnoteLabel(raw) : null;
      if (label) updatedText = insertFootnoteRef(updatedText, label);

      recordedPosition = currentA;
      recordedOriginal = textToHighlight;
      recordedHighlighted = updatedText;
      recordedLabel = label;

      const result = raw.slice(0, currentA) + updatedText + raw.slice(currentB);
      return label ? appendFootnoteDefinition(result, label, noteText) : result;
    });

    if (!found) {
      new Notice("Unable to locate the selection in the file.");
      return;
    }

    /* 3. Restore scroll */
    this.restoreScroll(view, scrollBefore);

    /* 4. Record for undo, then clean up selection + cache */
    if (
      recordedPosition != null &&
      recordedOriginal != null &&
      recordedHighlighted != null &&
      recordedOriginal !== recordedHighlighted
    ) {
      this.lastHighlight = {
        filePath: file.path,
        position: recordedPosition,
        originalText: recordedOriginal,
        highlightedText: recordedHighlighted,
        footnoteLabel: recordedLabel,
      };
      this.showUndoButton();
    }
    activeDocument.getSelection()?.removeAllRanges();
    this.selectionSnapshot = null;
    this.hideToolbar();
  }

  /*────────── Undo last highlight ──────────*/
  async undoLastHighlight(): Promise<void> {
    const record = this.lastHighlight;
    if (!record) {
      new Notice("Nothing to undo.");
      return;
    }

    const abstractFile = this.app.vault.getAbstractFileByPath(record.filePath);
    if (!(abstractFile instanceof TFile)) {
      new Notice("Cannot undo — file not found.");
      this.lastHighlight = null;
      this.hideUndoButton();
      return;
    }
    const file = abstractFile;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const scrollBefore =
      view && view.file?.path === record.filePath ? this.getScroll(view) : null;

    let undone = false;
    await this.app.vault.process(file, (raw: string): string => {
      const dropNote = (text: string) =>
        record.footnoteLabel
          ? removeFootnoteDefinition(text, record.footnoteLabel)
          : text;
      // Fast path: the highlighted span is still at the recorded position.
      const fastEnd = record.position + record.highlightedText.length;
      if (
        record.position >= 0 &&
        fastEnd <= raw.length &&
        raw.slice(record.position, fastEnd) === record.highlightedText
      ) {
        undone = true;
        return dropNote(
          raw.slice(0, record.position) +
            record.originalText +
            raw.slice(fastEnd)
        );
      }
      // Fallback: the file was edited and the position drifted. Only act if
      // the exact highlighted span appears once anywhere in the file.
      const [a, b] = this.uniqueDirectMatch(raw, record.highlightedText);
      if (a == null || b == null) return raw;
      undone = true;
      return dropNote(raw.slice(0, a) + record.originalText + raw.slice(b));
    });

    if (!undone) {
      new Notice("Cannot find that highlight — the file may have changed.");
      return;
    }

    this.lastHighlight = null;
    this.hideUndoButton();

    if (view && scrollBefore != null) this.restoreScroll(view, scrollBefore);

    new Notice("Highlight undone.");
  }

  /*────────── Existing highlights: tap menu + note editing ──────────*/
  handleReadingClick(evt: MouseEvent): void {
    const target = evt.target;
    if (!(target instanceof Element)) return;
    const mark = target.closest("mark");
    if (!mark || target.closest("a, sup")) return;

    const view = this.getReadingView();
    const file = view?.file;
    const previewEl = view ? this.getPreviewEl(view) : null;
    if (!view || !file || !previewEl?.contains(mark)) return;

    if (this.markClickTimer != null) {
      window.clearTimeout(this.markClickTimer);
      this.markClickTimer = null;
    }
    // Double/triple click selects words; leave that alone.
    if (evt.detail > 1) return;

    const open = () => {
      // A click that ends a drag-selection is not a tap on the highlight.
      const sel = activeDocument.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;

      const raw = view.getViewData();
      const span = this.spanForMark(raw, mark);
      if (!span) {
        new Notice("Couldn't match this highlight to the note's text.");
        return;
      }
      this.openHighlightMenu(file, this.entryForSpan(raw, span), evt);
    };

    // With a mouse, wait to see whether this click starts a double-click.
    if (Platform.isMobile) {
      open();
    } else {
      this.markClickTimer = window.setTimeout(() => {
        this.markClickTimer = null;
        open();
      }, 250);
    }
  }

  /** Map a rendered `<mark>` in the active reading view to its source span. */
  spanForMark(raw: string, mark: Element): HighlightSpan | null {
    const block = this.sourcePosElement(mark);
    const window = this.sourcePosRangeForNode(mark);
    let indexInBlock = 0;
    if (block) {
      const marks = Array.from(block.querySelectorAll("mark")).filter(
        (m) => this.sourcePosElement(m) === block
      );
      indexInBlock = Math.max(0, marks.indexOf(mark as HTMLElement));
    }
    return matchMarkToSpan(
      findHighlightSpans(raw),
      {
        text: this.typographyDenormalize(mark.textContent ?? ""),
        indexInBlock,
        window,
      },
      (inner) => this.renderInline(inner)
    );
  }

  renderInline(markdown: string): string {
    return this.typographyDenormalize(this.createPositionMap(markdown).renderedText);
  }

  entryForSpan(raw: string, span: HighlightSpan): HighlightEntry {
    return {
      ref: { start: span.start, text: raw.slice(span.start, span.refEnd) },
      text: this.renderInline(span.inner),
      note: span.footnoteLabel ? getFootnoteDefinition(raw, span.footnoteLabel) : null,
      line: lineOfOffset(raw, span.start),
    };
  }

  async getHighlightEntries(file: TFile): Promise<HighlightEntry[]> {
    const raw = await this.app.vault.cachedRead(file);
    return findHighlightSpans(raw).map((span) => this.entryForSpan(raw, span));
  }

  openHighlightMenu(file: TFile, entry: HighlightEntry, evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(entry.note != null ? "Edit note" : "Add note")
        .setIcon("message-square")
        .onClick(() => void this.editNote(file, entry))
    );
    menu.addItem((item) =>
      item
        .setTitle("Copy")
        .setIcon("copy")
        .onClick(() => void this.copyText(entry.text))
    );
    menu.addItem((item) =>
      item
        .setTitle("Remove highlight")
        .setIcon("eraser")
        .onClick(() => void this.updateSpan(file, entry.ref, removeHighlightSpan))
    );
    menu.showAtMouseEvent(evt);
  }

  async editNote(file: TFile, entry: HighlightEntry): Promise<void> {
    const raw = await this.app.vault.read(file);
    const span = this.resolveSpan(raw, entry.ref);
    if (!span) {
      new Notice("Cannot find that highlight — the file may have changed.");
      return;
    }
    const existing = span.footnoteLabel
      ? getFootnoteDefinition(raw, span.footnoteLabel)
      : null;
    const ref = { start: span.start, text: raw.slice(span.start, span.refEnd) };
    const save = (text: string) =>
      void this.updateSpan(file, ref, (r, s) => setSpanNote(r, s, text));

    new NoteModal(this.app, {
      title: existing != null ? "Edit note" : "Add note",
      quote: entry.text,
      initialText: existing ?? "",
      onSave: save,
      onDelete: existing != null ? () => save("") : undefined,
    }).open();
  }

  /** Find the span a ref points at in the current text, if it is still there. */
  resolveSpan(raw: string, ref: SpanRef): HighlightSpan | null {
    const start = locateSpan(raw, ref);
    if (start == null) return null;
    return findHighlightSpans(raw).find((s) => s.start === start) ?? null;
  }

  /** Rewrite one highlight in place, keeping the reading position. */
  async updateSpan(
    file: TFile,
    ref: SpanRef,
    edit: (raw: string, span: HighlightSpan) => string
  ): Promise<void> {
    const view = this.viewForFile(file);
    const scrollBefore = view?.getMode() === "preview" ? this.getScroll(view) : null;

    let applied = false;
    await this.app.vault.process(file, (raw: string): string => {
      const span = this.resolveSpan(raw, ref);
      if (!span) return raw;
      applied = true;
      return edit(raw, span);
    });

    if (!applied) {
      new Notice("Cannot find that highlight — the file may have changed.");
      return;
    }
    if (view && scrollBefore != null) this.restoreScroll(view, scrollBefore);
  }

  viewForFile(file: TFile): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path) return active;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        return leaf.view;
      }
    }
    return null;
  }

  /*────────── Highlights panel ──────────*/
  getPanels(): HighlightsView[] {
    return this.app.workspace
      .getLeavesOfType(HIGHLIGHTS_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is HighlightsView => view instanceof HighlightsView);
  }

  async activatePanel(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(HIGHLIGHTS_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: HIGHLIGHTS_VIEW_TYPE, active: true });
    }
    // revealLeaf needs 1.7.2; expanding the sidebar and focusing the leaf
    // does the same on older versions.
    workspace.rightSplit.expand();
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  followActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    for (const panel of this.getPanels()) void panel.setFile(file);
  }

  schedulePanelRefresh(): void {
    if (this.panelRefreshTimer != null) window.clearTimeout(this.panelRefreshTimer);
    this.panelRefreshTimer = window.setTimeout(() => {
      this.panelRefreshTimer = null;
      for (const panel of this.getPanels()) void panel.refresh();
    }, 300);
  }

  async jumpToHighlight(file: TFile, entry: HighlightEntry): Promise<void> {
    const { workspace } = this.app;
    let view = this.viewForFile(file);
    if (!view) {
      const leaf = workspace.getLeaf(false);
      await leaf.openFile(file);
      view = leaf.view instanceof MarkdownView ? leaf.view : null;
      if (!view) return;
    }
    // On phones the panel is a drawer covering the note.
    if (Platform.isMobile) workspace.rightSplit.collapse();
    workspace.setActiveLeaf(view.leaf, { focus: true });
    view.setEphemeralState({ line: entry.line });

    const target = view;
    // Reading view renders sections lazily; give it a moment to draw.
    window.setTimeout(() => this.flashHighlight(target, entry), 350);
  }

  flashHighlight(view: MarkdownView, entry: HighlightEntry): void {
    if (view.getMode() !== "preview") return;
    const previewEl = this.getPreviewEl(view);
    if (!previewEl) return;
    const raw = view.getViewData();
    const target = this.resolveSpan(raw, entry.ref);
    if (!target) return;
    for (const mark of Array.from(previewEl.querySelectorAll("mark"))) {
      if (this.spanForMark(raw, mark)?.start !== target.start) continue;
      mark.addClass("reading-highlighter-flash");
      window.setTimeout(() => mark.removeClass("reading-highlighter-flash"), 1200);
      return;
    }
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
  getScroll(view: MarkdownView): number {
    return view.previewMode.getScroll();
  }

  applyScroll(view: MarkdownView, pos: number): void {
    view.previewMode.applyScroll(pos);
  }

  /** Restore scroll after a rewrite, in two passes because rendering can finish late. */
  restoreScroll(view: MarkdownView, pos: number): void {
    const restore = () => this.applyScroll(view, pos);
    window.requestAnimationFrame(() => {
      restore();
      window.setTimeout(restore, 50);
    });
  }

  /*────────── Position helpers ──────────*/
  /**
   * Resolve the source-markdown byte range for the markdown block
   * (paragraph / heading / list item / …) containing `node`. Obsidian
   * annotates blocks with `data-sourcepos="line:col-line:col"` (1-indexed,
   * end column is the last character). Newer versions drop that attribute,
   * so fall back to the reading view's sections. Returns null if neither
   * gives a range.
   */
  sourcePosRangeForNode(node: Node | null): SourcePosRange | null {
    const el = this.dataSourcePosElement(node);
    if (!el) return this.sectionRangeForNode(node);
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

  /** The block element for `node`: its `data-sourcepos` ancestor, else its reading-view section. */
  sourcePosElement(node: Node | null): HTMLElement | null {
    const el = this.dataSourcePosElement(node);
    if (el) return el;
    const sections = this.previewSections();
    const index = this.sectionIndexForNode(sections, node);
    return sections && index !== -1 ? sections[index].el : null;
  }

  /**
   * Reading-view sections in source order (internal API: each has its
   * element and the number of source lines it covers). Null when the
   * shape isn't what we expect.
   */
  previewSections(): PreviewSection[] | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const renderer = (view?.previewMode as unknown as { renderer?: { sections?: unknown } })
      ?.renderer;
    const sections = renderer?.sections;
    if (!Array.isArray(sections)) return null;
    const valid = sections.every(
      (s: Partial<PreviewSection> | null) =>
        s != null && s.el instanceof HTMLElement && typeof s.lines === "number"
    );
    return valid ? (sections as PreviewSection[]) : null;
  }

  sectionIndexForNode(sections: PreviewSection[] | null, node: Node | null): number {
    if (!sections || !node) return -1;
    return sections.findIndex((s) => s.el.contains(node));
  }

  sectionRangeForNode(node: Node | null): SourcePosRange | null {
    const sections = this.previewSections();
    const index = this.sectionIndexForNode(sections, node);
    if (!sections || index === -1) return null;
    const viewData = this.app.workspace.getActiveViewOfType(MarkdownView)?.getViewData();
    if (!viewData) return null;
    return sectionRange(viewData, sections.map((s) => s.lines), index);
  }

  /** Nearest ancestor (within 10 levels) carrying `data-sourcepos`. */
  dataSourcePosElement(node: Node | null): HTMLElement | null {
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
    return el && el.getAttribute("data-sourcepos") ? el : null;
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
        return [match.index, match.index + match[0].length];
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
