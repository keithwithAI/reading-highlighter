# Reading Highlighter

Highlight selected text in Obsidian's reading mode using `==markdown highlight==` syntax.

## Features

- A small toolbar appears next to your selection with **Highlight**, **Highlight with note** and **Copy**
- Notes are saved as ordinary Markdown footnotes, so they show up in reading view on every device
- Tap or click an existing highlight to add or edit its note, copy it, or remove it
- A highlights panel lists every highlight in the current note with its note, and tapping one jumps to it
- Undo the most recent highlight with a button or command
- Handles multi-paragraph selections, formatted text and links
- Keeps existing Markdown formatting (bold, italic, code and so on)
- Works on desktop, iPhone and iPad

## Usage

1. Open a note in **reading mode**.
2. Select the text you want to highlight.
3. Tap a button in the toolbar that appears below the selection:
   - **Highlight** wraps the text in `==highlights==` in the note's source.
   - **Highlight with note** opens a note editor, then saves the highlight and the note together.
   - **Copy** copies the selected text.

You can also run **Highlight selection in reading mode** or **Highlight selection with a note** from the command palette. On mobile, the highlighter icon in the ribbon highlights the selection too.

### Notes

A note is stored as a footnote with an `hl` label:

```markdown
Some ==quoted text==[^hl3] here.

[^hl3]: Your note. Extra lines are indented by four spaces.
```

The plugin only ever edits or removes footnotes labelled `hl` plus a number. Your own footnotes are left alone.

### Editing an existing highlight

Tap or click a highlight in reading mode to open its menu:

- **Add note** or **Edit note** opens the note editor. In the editor, **Delete note** removes the note but keeps the highlight.
- **Copy** copies the highlighted text.
- **Remove highlight** removes the `==` markers, plus the note if there is one.

### Highlights panel

Run **Open highlights panel** to show the panel in the right sidebar. It lists the highlights in the note you're reading, with their notes. Tap a highlight to jump to it in the note, or use the **⋯** button for the same menu as tapping the highlight.

### Undoing a highlight

After you make a highlight, an **undo button** appears at the bottom of the screen. Tap it to remove the most recent highlight, including its note. The button stays visible until you use it, switch to a different note, or disable the plugin. You can also run **Undo last highlight** from the command palette and give it a hotkey.

To remove an older highlight, tap it and choose **Remove highlight**.

## Settings

**Toolbar position** sets where the toolbar appears. **Next to the selection** is the default. **Bottom of the screen** keeps it in a fixed spot above the home indicator.

## Hotkeys

No default hotkeys are set. To add one:

1. Go to **Settings > Hotkeys**.
2. Search for "Reading Highlighter".
3. Assign shortcuts to the commands you use.

## Installation

Available in **Settings > Community Plugins > Browse** (search "Reading Highlighter").

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/keithwithAI/reading-highlighter/releases/latest)
2. Create a folder called `reading-highlighter` inside your vault's `.obsidian/plugins/` directory
3. Place the downloaded files in that folder
4. Restart Obsidian and enable the plugin in **Settings > Community Plugins**

## Attribution

Originally created by [Tintalectronico](https://alexochoa.es). Maintained by [keithwithAI](https://github.com/keithwithAI).
