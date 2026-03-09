import { App, PluginSettingTab, Setting } from "obsidian";
import HoverEditorPlugin from "../main";
import { parseCssUnitValue } from "../utils/misc";

export interface HoverEditorSettings {
  defaultMode: string;
  autoPin: string;
  triggerDelay: number;
  closeDelay: number;
  autoFocus: boolean;
  rollDown: boolean;
  snapToEdges: boolean;
  initialHeight: string;
  initialWidth: string;
  showViewHeader: boolean;
  imageZoom: boolean;
  regularLinks: "native" | "floating" | "sidebar";
  headings:     "native" | "floating" | "sidebar";
  blocks:       "native" | "floating" | "sidebar";
  hoverEmbeds:  "native" | "floating" | "sidebar";
  footnotes:    "native" | "floating" | "sidebar";
  sidebarAutoReveal: boolean;
  sidebarAutoFocus:  boolean;
}

export const DEFAULT_SETTINGS: HoverEditorSettings = {
  defaultMode:       "match",
  autoPin:           "onMove",
  triggerDelay:      300,
  closeDelay:        600,
  autoFocus:         true,
  rollDown:          false,
  snapToEdges:       false,
  initialHeight:     "340px",
  initialWidth:      "400px",
  showViewHeader:    false,
  imageZoom:         true,
  regularLinks:      "sidebar",
  headings:          "sidebar",
  blocks:            "floating",
  hoverEmbeds:       "sidebar",
  footnotes:         "native",
  sidebarAutoReveal: true,
  sidebarAutoFocus:  false,
};

export const modeOptions = {
  preview: "Reading view",
  source:  "Editing view",
  match:   "Match current view",
};

export const pinOptions = {
  onMove: "On drag or resize",
  always: "Always",
};

const linkModeOptions = {
  native:   "Native preview",
  floating: "Floating hover editor",
  sidebar:  "Sidebar preview",
};

export class SettingTab extends PluginSettingTab {
  plugin: HoverEditorPlugin;

  constructor(app: App, plugin: HoverEditorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide() {}

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // -------------------------------------------------------------------------
    containerEl.createEl("h3", { text: "General" });

    new Setting(containerEl)
      .setName("Default view mode")
      .setDesc("Whether previews open in reading or editing view by default")
      .addDropdown(cb => {
        cb.addOptions(modeOptions);
        cb.setValue(this.plugin.settings.defaultMode);
        cb.onChange(async value => {
          this.plugin.settings.defaultMode = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Trigger delay (ms)")
      .setDesc("How long to wait before opening a preview on hover")
      .addText(tf => {
        tf.setPlaceholder(String(this.plugin.settings.triggerDelay));
        tf.inputEl.type = "number";
        tf.setValue(String(this.plugin.settings.triggerDelay));
        tf.onChange(async value => {
          this.plugin.settings.triggerDelay = Number(value);
          await this.plugin.saveSettings();
        });
      });

    // -------------------------------------------------------------------------
    containerEl.createEl("h3", { text: "Preview modes" });
    containerEl.createEl("p", {
      text: "Choose how each link type is previewed on hover.",
      cls: "setting-item-description",
    });

    const linkSettings: Array<[keyof HoverEditorSettings, string, string]> = [
      ["regularLinks", "Regular links",   "[[Note]]"],
      ["headings",     "Heading links",   "[[Note#Heading]]"],
      ["blocks",       "Block links",     "[[Note#^blockid]]"],
      ["hoverEmbeds",  "Embed links",     "![[Note]] or ![[image]]"],
      ["footnotes",    "Footnote links",  "[^1]"],
    ];

    for (const [key, name, example] of linkSettings) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(example)
        .addDropdown(dd =>
          dd
            .addOptions(linkModeOptions)
            .setValue(this.plugin.settings[key] as string)
            .onChange(async (value: "native" | "floating" | "sidebar") => {
              (this.plugin.settings[key] as any) = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    // -------------------------------------------------------------------------
    containerEl.createEl("h3", { text: "Sidebar preview" });

    new Setting(containerEl)
      .setName("Auto-reveal sidebar")
      .setDesc("Automatically expand the sidebar panel when a preview opens")
      .addToggle(t =>
        t.setValue(this.plugin.settings.sidebarAutoReveal).onChange(async value => {
          this.plugin.settings.sidebarAutoReveal = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-focus sidebar")
      .setDesc("Move keyboard focus into the sidebar preview after opening")
      .addToggle(t =>
        t.setValue(this.plugin.settings.sidebarAutoFocus).onChange(async value => {
          this.plugin.settings.sidebarAutoFocus = value;
          await this.plugin.saveSettings();
        }),
      );

    // -------------------------------------------------------------------------
    containerEl.createEl("h3", { text: "Hover editor" });

    new Setting(containerEl)
      .setName("Auto-focus")
      .setDesc("Set the hover editor as the active pane when opened")
      .addToggle(t =>
        t.setValue(this.plugin.settings.autoFocus).onChange(async value => {
          this.plugin.settings.autoFocus = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-pin")
      .addDropdown(cb => {
        cb.addOptions(pinOptions);
        cb.setValue(this.plugin.settings.autoPin);
        cb.onChange(async value => {
          this.plugin.settings.autoPin = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Close delay (ms)")
      .setDesc("How long to wait before closing a hover editor after the mouse leaves")
      .addText(tf => {
        tf.setPlaceholder(String(this.plugin.settings.closeDelay));
        tf.inputEl.type = "number";
        tf.setValue(String(this.plugin.settings.closeDelay));
        tf.onChange(async value => {
          this.plugin.settings.closeDelay = Number(value);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Minimize downwards")
      .setDesc("Double-click title bar rolls the window down instead of up")
      .addToggle(t =>
        t.setValue(this.plugin.settings.rollDown).onChange(async value => {
          this.plugin.settings.rollDown = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Snap to edges")
      .setDesc(
        "Drag a popover to the screen edges to maximize it vertically (sides) or fully (top). Drag away to restore.",
      )
      .addToggle(t =>
        t.setValue(this.plugin.settings.snapToEdges).onChange(async value => {
          this.plugin.settings.snapToEdges = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Show view header by default")
      .setDesc("Show the note's view header inside the hover editor. Can also be toggled per-popover.")
      .addToggle(t =>
        t.setValue(this.plugin.settings.showViewHeader).onChange(async value => {
          this.plugin.settings.showViewHeader = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Click to zoom image")
      .setDesc("Click and hold an image inside a hover editor to fill the viewport. Release to restore.")
      .addToggle(t =>
        t.setValue(this.plugin.settings.imageZoom).onChange(async value => {
          this.plugin.settings.imageZoom = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Initial width")
      .setDesc("Any valid CSS unit, e.g. 400px or 30vw")
      .addText(tf => {
        tf.setPlaceholder(this.plugin.settings.initialWidth);
        tf.inputEl.type = "text";
        tf.setValue(this.plugin.settings.initialWidth);
        tf.onChange(async value => {
          value = parseCssUnitValue(value);
          if (!value) value = DEFAULT_SETTINGS.initialWidth;
          this.plugin.settings.initialWidth = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Initial height")
      .setDesc("Any valid CSS unit, e.g. 340px or 40vh")
      .addText(tf => {
        tf.setPlaceholder(this.plugin.settings.initialHeight);
        tf.inputEl.type = "text";
        tf.setValue(String(this.plugin.settings.initialHeight));
        tf.onChange(async value => {
          value = parseCssUnitValue(value);
          if (!value) value = DEFAULT_SETTINGS.initialHeight;
          this.plugin.settings.initialHeight = value;
          await this.plugin.saveSettings();
        });
      });
  }
}