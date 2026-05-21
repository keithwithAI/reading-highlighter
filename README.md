# Reading Highlighter

Highlight selected text in Obsidian's reading mode using `==markdown highlight==` syntax.

## Features

- Select text in reading mode and highlight it instantly
- Floating highlight button appears when text is selected
- Undo the most recent highlight with a floating button or command
- Command palette: **Highlight selection in reading mode**
- Mobile ribbon icon support
- Handles multi-paragraph selections, formatted text, and links
- Preserves existing markdown formatting (bold, italic, code, etc.)

## Usage

1. Open a note in **reading mode**
2. Select the text you want to highlight
3. Use any of these methods:
   - Click the floating highlight button that appears
   - Open the command palette and run **Highlight selection in reading mode**
   - (Mobile) Tap the highlighter icon in the ribbon

The plugin wraps the selected text with `==highlights==` in the underlying markdown source.

### Undoing a highlight

If you highlight the wrong selection, an **undo button** appears next to the highlight button. Click it to remove the most recent highlight. The button stays visible until you click it, switch to a different note, or the plugin is disabled. You can also run **Undo last highlight** from the command palette (and assign a hotkey to it).

Only the most recent highlight is reversible from inside the plugin. For older highlights, edit the `==` markers directly in source mode.

## Hotkeys

No default hotkey is set. To add one:

1. Go to **Settings > Hotkeys**
2. Search for **Highlight selection in reading mode**
3. Assign your preferred shortcut

## Installation

Available in **Settings > Community Plugins > Browse** (search "Reading Highlighter").

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/keithwithAI/reading-highlighter/releases/latest)
2. Create a folder called `reading-highlighter` inside your vault's `.obsidian/plugins/` directory
3. Place the downloaded files in that folder
4. Restart Obsidian and enable the plugin in **Settings > Community Plugins**

## Attribution

Originally created by [Tintalectronico](https://alexochoa.es). Maintained by [keithwithAI](https://github.com/keithwithAI).
