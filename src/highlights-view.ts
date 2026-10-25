import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ReadingHighlighterPlugin from "./main";
import type { HighlightEntry } from "./main";

export const HIGHLIGHTS_VIEW_TYPE = "reading-highlighter-highlights";

/** Sidebar list of the highlights (and their notes) in the active note. */
export class HighlightsView extends ItemView {
  plugin: ReadingHighlighterPlugin;
  private file: TFile | null = null;
  private renderToken = 0;

  constructor(leaf: WorkspaceLeaf, plugin: ReadingHighlighterPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return HIGHLIGHTS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Highlights";
  }

  getIcon(): string {
    return "highlighter";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("reading-highlighter-panel");
    // Keep showing the last note while the panel itself has focus.
    this.file = this.app.workspace.getActiveFile();
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Follow the active note; ignore focus moving to non-file views. */
  async setFile(file: TFile | null): Promise<void> {
    if (!file || file.extension !== "md") return;
    this.file = file;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const token = ++this.renderToken;
    const file = this.file;
    const entries = file ? await this.plugin.getHighlightEntries(file) : [];
    // A newer refresh started while we were reading the file.
    if (token !== this.renderToken) return;
    this.render(file, entries);
  }

  showsFile(path: string): boolean {
    return this.file?.path === path;
  }

  private render(file: TFile | null, entries: HighlightEntry[]): void {
    const el = this.contentEl;
    el.empty();

    if (!file) {
      el.createDiv({
        cls: "reading-highlighter-panel-empty",
        text: "Open a note to see its highlights.",
      });
      return;
    }

    const header = el.createDiv({ cls: "reading-highlighter-panel-header" });
    header.createDiv({ cls: "reading-highlighter-panel-title", text: file.basename });
    header.createDiv({
      cls: "reading-highlighter-panel-count",
      text: entries.length === 1 ? "1 highlight" : `${entries.length} highlights`,
    });

    if (entries.length === 0) {
      el.createDiv({
        cls: "reading-highlighter-panel-empty",
        text: "No highlights in this note yet.",
      });
      return;
    }

    const list = el.createDiv({ cls: "reading-highlighter-panel-list" });
    for (const entry of entries) {
      const row = list.createDiv({ cls: "reading-highlighter-panel-row" });
      const body = row.createDiv({ cls: "reading-highlighter-panel-body" });
      body.createDiv({ cls: "reading-highlighter-panel-text", text: entry.text });
      if (entry.note) {
        body.createDiv({ cls: "reading-highlighter-panel-note", text: entry.note });
      }
      body.addEventListener("click", () => {
        void this.plugin.jumpToHighlight(file, entry);
      });

      const more = row.createEl("button", {
        cls: "reading-highlighter-panel-more clickable-icon",
        attr: { "aria-label": "Highlight options", type: "button" },
      });
      setIcon(more, "more-horizontal");
      more.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        this.plugin.openHighlightMenu(file, entry, e);
      });
    }
  }
}
