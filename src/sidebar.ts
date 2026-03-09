import { around } from "monkey-around";
import {
  EphemeralState,
  ItemView,
  MarkdownView,
  OpenViewState,
  parseLinktext,
  resolveSubpath,
  setIcon,
  TFile,
  Workspace,
  WorkspaceLeaf,
} from "obsidian";
import HoverEditorPlugin from "./main";

export const SIDEBAR_PREVIEW_VIEW_TYPE = "hover-editor-preview";
export const SIDEBAR_ICON = "file-search";

// ---------------------------------------------------------------------------
// PreviewShellView
// A minimal ItemView that exists only to hold a registered type string.
// onOpen() is empty. When openFile() is called on the leaf, Obsidian replaces
// this view with a real MarkdownView — full native behaviour, zero nesting.
// ---------------------------------------------------------------------------
export class PreviewShellView extends ItemView {
  getViewType(): string { return SIDEBAR_PREVIEW_VIEW_TYPE; }
  getIcon(): string { return SIDEBAR_ICON; }
  getDisplayText(): string { return "Preview"; }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// SidebarPreview — controller owned by HoverEditorPlugin
// ---------------------------------------------------------------------------
export class SidebarPreview {
  plugin: HoverEditorPlugin;
  private opening = false;
  private leaf: WorkspaceLeaf | null = null;

  constructor(plugin: HoverEditorPlugin) {
    this.plugin = plugin;
  }

  // Called once from plugin.onload(), before onLayoutReady.
  register(): void {
    this.plugin.registerView(
      SIDEBAR_PREVIEW_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new PreviewShellView(leaf),
    );
  }

  // ---------------------------------------------------------------------------
  // Leaf validation — checks both disposed flag AND DOM presence.
  // A leaf can be non-disposed but detached from the workspace (e.g. after the
  // user closes the tab), so we must check both conditions.
  // ---------------------------------------------------------------------------
  private isLeafAlive(leaf: WorkspaceLeaf | null): boolean {
    if (!leaf || leaf.disposed) return false;
    // Check the leaf's container element is still attached to the document.
    // This catches the "closed tab" case where disposed isn't set yet.
    return document.contains(leaf.containerEl);
  }

  // ---------------------------------------------------------------------------
  // Leaf acquisition — four-stage recovery, runs on every openLink() call.
  //
  // 1. Cached reference still alive and in DOM → use it (fast path)
  // 2. getLeavesOfType() → shell survived restart before any file was opened
  // 3. getLeafById(storedId) → leaf was used for a file, now type="markdown"
  // 4. Nothing found → create a fresh shell leaf
  // ---------------------------------------------------------------------------
  private async getOrCreateLeaf(): Promise<WorkspaceLeaf> {
    // 1. Cached and alive
    if (this.isLeafAlive(this.leaf)) return this.leaf!;

    // 2. Shell type still registered in workspace
    const byType = this.plugin.app.workspace.getLeavesOfType(SIDEBAR_PREVIEW_VIEW_TYPE);
    if (byType.length > 0) {
      this.leaf = byType[0];
      return this.leaf;
    }

    // 3. Previously opened a file — leaf is now type="markdown", find by ID
    const storedId: string | undefined = (this.plugin as any)._sidebarLeafId;
    if (storedId) {
      const found = (this.plugin.app.workspace as any).getLeafById?.(storedId);
      if (this.isLeafAlive(found)) {
        this.leaf = found;
        return this.leaf!;
      }
    }

    // 4. Create fresh — open shell in the right sidebar by default;
    // user can drag it wherever they want afterwards.
    const newLeaf = this.plugin.app.workspace.getRightLeaf(false)!;
    await newLeaf.setViewState({ type: SIDEBAR_PREVIEW_VIEW_TYPE, state: {} });
    this.leaf = newLeaf;
    return this.leaf;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Open the shell leaf (empty preview container) without loading a file.
   *  Used by the "Open sidebar preview" command. */
  async openShell(): Promise<void> {
    const leaf = await this.getOrCreateLeaf();
    this.plugin.app.workspace.revealLeaf(leaf);
  }

  async openLink(
    linkText: string,
    sourcePath: string,
    eState?: EphemeralState,
  ): Promise<void> {
    const link = parseLinktext(linkText);
    const file = link
      ? this.plugin.app.metadataCache.getFirstLinkpathDest(link.path, sourcePath)
      : null;
    if (!(file instanceof TFile)) return;

    const resolvedEState = Object.assign(
      {},
      this.buildEphemeralState(file, link ?? undefined),
      eState,
    );

    await this.openFile(file, {
      active: false,
      state: { mode: this.getViewMode() },
      eState: resolvedEState,
    });
  }

  /** Open a specific file directly — used by sidebar commands. */
  async openFileDirectly(file: TFile, eState?: EphemeralState): Promise<void> {
    await this.openFile(file, {
      active: false,
      state: { mode: this.getViewMode() },
      eState: eState ?? {},
    });
    const leaf = await this.getOrCreateLeaf();
    this.plugin.app.workspace.revealLeaf(leaf);
  }

  // ---------------------------------------------------------------------------
  // Internal open
  // ---------------------------------------------------------------------------
  private async openFile(file: TFile, openState?: OpenViewState): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      const leaf = await this.getOrCreateLeaf();
      const view = leaf.view as MarkdownView;

      // Same file — just scroll, avoids editor flicker on heading/block links
      if (view?.file?.path === file.path && openState?.eState) {
        view.setEphemeralState(openState.eState);
      } else {
        await leaf.openFile(file, openState);
      }

      // After openFile() the view is now a MarkdownView. Patch our icon and
      // title back onto the live instance so the tab stays branded.
      const liveView = leaf.view;
      if (liveView && !(liveView instanceof PreviewShellView)) {
        liveView.getIcon = () => SIDEBAR_ICON;
        liveView.getDisplayText = () => file.basename;
        this.refreshTabHeader(leaf, file.basename);
      }

      // Store leaf ID for cross-restart recovery
      (this.plugin as any)._sidebarLeafId = (leaf as any).id;

      // Prevent recent-files pollution — copied from popover.ts
      setTimeout(
        around(Workspace.prototype, {
          recordMostRecentOpenedFile(old) {
            return function (_file: TFile) {
              if (_file !== file) return old.call(this, _file);
            };
          },
        }),
        1,
      );
      const recentFiles = this.plugin.app.plugins.plugins["recent-files-obsidian"];
      if (recentFiles) {
        setTimeout(
          around(recentFiles, {
            shouldAddFile(old) {
              return function (_file: TFile) {
                return _file !== file && old.call(this, _file);
              };
            },
            update(old) {
              return function (_file: TFile) {
                return old.call(this, _file === file ? null : _file);
              };
            },
          }),
          1,
        );
      }

      if (this.plugin.settings.sidebarAutoReveal) {
        this.plugin.app.workspace.revealLeaf(leaf);
      }
      if (this.plugin.settings.sidebarAutoFocus) {
        setTimeout(
          () => this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true }),
          50,
        );
      }
    } catch (e) {
      console.error("[HoverEditor] SidebarPreview.openFile error:", e);
    } finally {
      this.opening = false;
    }
  }

  private refreshTabHeader(leaf: WorkspaceLeaf, title: string): void {
    const l = leaf as any;
    if (l.tabHeaderInnerTitleEl) l.tabHeaderInnerTitleEl.innerText = title;
    if (l.tabHeaderInnerIconEl) setIcon(l.tabHeaderInnerIconEl, SIDEBAR_ICON);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private buildEphemeralState(
    file: TFile,
    link?: { path: string; subpath: string },
  ): EphemeralState {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const subpath = cache ? resolveSubpath(cache, link?.subpath ?? "") : undefined;
    const eState: EphemeralState = { subpath: link?.subpath };
    if (subpath) {
      eState.line = subpath.start.line;
      eState.startLoc = subpath.start;
      eState.endLoc = subpath.end ?? undefined;
    }
    return eState;
  }

  private getViewMode(): string {
    const defaultMode = this.plugin.settings.defaultMode;
    if (defaultMode === "match") {
      const activeLeaf = this.plugin.app.workspace.activeLeaf;
      return (activeLeaf?.view as any)?.getMode?.() ?? "preview";
    }
    return defaultMode;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Warm the leaf cache from workspace.json on startup. */
  warmCache(): void {
    if (this.isLeafAlive(this.leaf)) return;

    const byType = this.plugin.app.workspace.getLeavesOfType(SIDEBAR_PREVIEW_VIEW_TYPE);
    if (byType.length > 0) {
      this.leaf = byType[0];
      return;
    }

    const storedId: string | undefined = (this.plugin as any)._sidebarLeafId;
    if (storedId) {
      const found = (this.plugin.app.workspace as any).getLeafById?.(storedId);
      if (this.isLeafAlive(found)) this.leaf = found;
    }
  }

  /** Detach shell-state leaves on plugin unload. Leaves with a real file open
   *  are left intact — warmCache() will reclaim them on next load. */
  unload(): void {
    this.plugin.app.workspace
      .getLeavesOfType(SIDEBAR_PREVIEW_VIEW_TYPE)
      .forEach(leaf => leaf.detach());
    this.leaf = null;
  }
}