import { App, Modal, Setting } from "obsidian";

interface NoteModalOptions {
  title: string;
  initialText: string;
  quote: string;
  onSave: (text: string) => void;
  /** Shown as a "Delete note" button when editing an existing note. */
  onDelete?: () => void;
}

/** Small editor for a highlight's note. Cmd/Ctrl+Enter saves. */
export class NoteModal extends Modal {
  private options: NoteModalOptions;

  constructor(app: App, options: NoteModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl, options } = this;
    this.titleEl.setText(options.title);
    this.modalEl.addClass("reading-highlighter-note-modal");

    contentEl.createEl("blockquote", {
      cls: "reading-highlighter-note-quote",
      text: options.quote,
    });

    const textarea = contentEl.createEl("textarea", {
      cls: "reading-highlighter-note-input",
      attr: { rows: "5", placeholder: "Write a note" },
    });
    textarea.value = options.initialText;

    const save = () => {
      this.close();
      options.onSave(textarea.value.trim());
    };

    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      }
    });

    const buttons = new Setting(contentEl);
    if (options.onDelete) {
      const onDelete = options.onDelete;
      buttons.addButton((b) =>
        b
          .setButtonText("Delete note")
          .setWarning()
          .onClick(() => {
            this.close();
            onDelete();
          })
      );
    }
    buttons
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Save").setCta().onClick(save));

    window.setTimeout(() => textarea.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
