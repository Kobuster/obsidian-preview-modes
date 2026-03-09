

# Obsidian Preview Modes

Preview links in the sidebar, hover editor, or native preview — configured per link type. This is a fork of [Hover Editor](https://github.com/nothingislost/obsidian-hover-editor) extended with a persistent sidebar preview and per-link-type routing.


## Features

### Choose Preview Modes by Link Format
Choose exactly how each link type is previewed:
- **Standard** - Regular links
- **Footnotes** (`[^1]`) - Native preview, floating editor, or sidebar
- **Headings** (`#Section`) - Navigate to specific sections instantly
- **Block references** (`#^blockid`) - Jump to precise locations
- **Embeds** (`![[note]]`, `![[image.png]]`) - Edit embedded content almost inline


### Sidebar preview

A persistent panel in your sidebar that updates as you hover links — without opening new panes or moving your focus. Drag it to either sidebar like any other panel.

- Stays open across sessions and plugin reloads
- Full note view: view header, properties, backlinks, reading/editing mode
- Same-note heading links scroll without reopening
- Freely moveable between left and right sidebars

### Floating hover editor

All original Hover Editor features intact:
- Resizable, draggable floating windows
- Pin multiple previews simultaneously
- Snap to screen edges
- Image zoom on click-hold
- Full editing in the popover

---

## Installation

### Community plugins (pending approval)
Settings → Community Plugins → search "Preview Modes"

### BRAT
Add `Kobuster/obsidian-preview-modes` in BRAT settings.

### Manual
1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/Kobuster/obsidian-preview-modes/releases/latest)
2. Create folder: `<vault>/.obsidian/plugins/obsidian-preview-modes/`
3. Copy both files into that folder
4. Reload Obsidian and enable the plugin under Settings → Community Plugins

## Credits & License

Fork of [Hover Editor](https://github.com/nothingislost/obsidian-hover-editor) © nothingislost  
Preview Modes additions © Kobuster  
MIT License — see [LICENSE.md](LICENSE.md)


## ☕ Support Development

If this plugin enhances your workflow, consider fueling my addiction:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow.svg)](https://ko-fi.com/kobuster)

[![Donate with PayPal](https://img.shields.io/badge/PayPal-Donate-blue?logo=paypal)](https://PayPal.me/Kobuster)

Contributions help motivate me to maintain and improve this plugin. Who am I kidding.

## Bug Reports & Feature Requests

[Open an issue](https://github.com/kobuster/Obsidian-preview-modes/issues)


## 📝 Changelog

See [RELEASES](https://github.com/kobuster/Obsidian-preview-modes/releases) for version history.

