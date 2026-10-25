import { App, PluginSettingTab, Setting } from "obsidian";
import type ReadingHighlighterPlugin from "./main";

export type ToolbarPlacement = "selection" | "bottom";

export interface ReadingHighlighterSettings {
  toolbarPlacement: ToolbarPlacement;
}

export const DEFAULT_SETTINGS: ReadingHighlighterSettings = {
  toolbarPlacement: "selection",
};

export class ReadingHighlighterSettingTab extends PluginSettingTab {
  plugin: ReadingHighlighterPlugin;

  constructor(app: App, plugin: ReadingHighlighterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Toolbar position")
      .setDesc(
        "Where the highlight toolbar appears when you select text in reading view."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("selection", "Next to the selection")
          .addOption("bottom", "Bottom of the screen")
          .setValue(this.plugin.settings.toolbarPlacement)
          .onChange(async (value) => {
            this.plugin.settings.toolbarPlacement = value as ToolbarPlacement;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarPlacement();
          })
      );
  }
}
