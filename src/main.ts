import { around } from "monkey-around";
import {
  App,
  debounce,
  EphemeralState,
  HoverParent,
  ItemView,
  MarkdownPreviewRenderer,
  MarkdownPreviewRendererStatic,
  MarkdownPreviewView,
  MarkdownView,
  Menu,
  parseLinktext,
  Platform,
  Plugin,
  PopoverState,
  requireApiVersion,
  resolveSubpath,
  setIcon,
  setTooltip,
  TAbstractFile,
  TFile,
  View,
  ViewState,
  Workspace,
  WorkspaceContainer,
  WorkspaceItem,
  WorkspaceLeaf,
} from "obsidian";

import { SidebarPreview } from "./sidebar";
import { onLinkHover } from "./onLinkHover";
import { PerWindowComponent, use } from "@ophidian/core";
import { HoverEditorParent, HoverEditor, isHoverLeaf, setMouseCoords } from "./popover";
import { DEFAULT_SETTINGS, HoverEditorSettings, SettingTab } from "./settings/settings";
import { snapActivePopover, snapDirections, restoreActivePopover, minimizeActivePopover } from "./utils/measure";
import { Scope } from "@interactjs/types";
import interactStatic from "@nothingislost/interactjs";
import { isA } from "./utils/misc";

class Interactor extends PerWindowComponent {
  interact = this.createInteractor();
  plugin = this.use(HoverEditorPlugin);

  createInteractor() {
    if (this.win === window) return interactStatic;
    const oldScope = (interactStatic as unknown as { scope: Scope }).scope;
    const newScope = new (oldScope.constructor as new () => Scope)();
    const interact = newScope.init(this.win).interactStatic;
    for (const plugin of oldScope._plugins.list) interact.use(plugin);
    return interact;
  }

  onload() {
    this.win.addEventListener("resize", this.plugin.debouncedPopoverReflow);
  }

  onunload() {
    this.win.removeEventListener("resize", this.plugin.debouncedPopoverReflow);
    try {
      this.interact.removeDocument(this.win.document);
    } catch (e) {
      console.error(e);
    }
  }
}

export default class HoverEditorPlugin extends Plugin {
  sidebar!: SidebarPreview;

  use = use.plugin(this);
  interact = this.use(Interactor);
  settings!: HoverEditorSettings;
  settingsTab!: SettingTab;

  async onload() {
    // Initialize and register sidebar view type.
    // register() must come before onLayoutReady so Obsidian can restore the
    // leaf from workspace.json on startup.
    this.sidebar = new SidebarPreview(this);
    this.sidebar.register();

    this.registerActivePopoverHandler();
    this.registerFileRenameHandler();
    this.registerContextMenuHandler();
    this.registerCommands();

    this.patchUnresolvedGraphNodeHover();
    this.patchWorkspace();
    this.patchQuickSwitcher();
    this.patchWorkspaceLeaf();
    this.patchItemView();
    this.patchMarkdownPreviewRenderer();
    this.patchMarkdownPreviewView();

    await this.loadSettings();
    this.registerSettingsTab();

    this.app.workspace.onLayoutReady(() => {
      // Warm the sidebar leaf cache — if a leaf was restored from
      // workspace.json (shell or markdown), claim it before first hover.
      this.sidebar.warmCache();
      this.patchSlidingPanes();
      this.patchLinkHover();
      setTimeout(() => {
        this.app.workspace.trigger("css-change");
      }, 2000);
    });
  }

  patchWorkspaceLeaf() {
    this.register(
      around(WorkspaceLeaf.prototype, {
        getRoot(old: any) {
          return function (this: any) {
            const top = old.call(this);
            return top.getRoot === this.getRoot ? top : top.getRoot();
          };
        },
        onResize(old: any) {
          return function (this: any) {
            this.view?.onResize();
          };
        },
        setViewState(old: any) {
          return async function (this: any, viewState: ViewState, eState?: unknown) {
            const result = await old.call(this, viewState, eState);
            try {
              const he = HoverEditor.forLeaf(this);
              if (he) {
                if (viewState.type) he.hoverEl.setAttribute("data-active-view-type", viewState.type);
                const titleEl = he.hoverEl.querySelector(".popover-title");
                if (titleEl) {
                  titleEl.textContent = this.view?.getDisplayText();
                  if (this.view?.file?.path) {
                    titleEl.setAttribute("data-path", this.view.file.path);
                  } else {
                    titleEl.removeAttribute("data-path");
                  }
                }
              }
            } catch {}
            return result;
          };
        },
        setEphemeralState(old: any) {
          return function (this: any, state: any) {
            old.call(this, state);
            if (state.focus && this.view?.getViewType() === "empty") {
              this.view.contentEl.tabIndex = -1;
              this.view.contentEl.focus();
            }
          };
        },
      }),
    );
    this.register(
      around(WorkspaceItem.prototype, {
        getContainer(old: any) {
          return function (this: any) {
            if (!old) return;
            if (!this.parentSplit || this instanceof WorkspaceContainer) return old.call(this);
            return this.parentSplit.getContainer();
          };
        },
      })
    );
  }

  patchQuickSwitcher() {
    const plugin = this;
    const { QuickSwitcherModal } = this.app.internalPlugins.plugins.switcher.instance;
    const uninstaller = around(QuickSwitcherModal.prototype, {
      open(old) {
        return function () {
          const result = old.call(this);
          if (this.instructionsEl) {
            setTimeout(around(this.instructionsEl, {
              empty(next) {
                return () => {};
              }
            }), 0);
          }
          this.setInstructions([
            {
              command: Platform.isMacOS ? "cmd p" : "ctrl p",
              purpose: "to open in new popover",
            },
          ]);
          this.scope.register(["Mod"], "p", (event: KeyboardEvent) => {
            this.close();
            const item = this.chooser.values[this.chooser.selectedItem];
            if (!item?.file) return;
            const newLeaf = plugin.spawnPopover(undefined, () =>
              this.app.workspace.setActiveLeaf(newLeaf, false, true),
            );
            newLeaf.openFile(item.file);
            return false;
          });
          return result;
        };
      },
    });
    this.register(uninstaller);
  }

  patchItemView() {
    const plugin = this;
    const [cls, method] = View.prototype["onPaneMenu"] ? [View, "onPaneMenu"] : [ItemView, "onMoreOptionsMenu"];
    const uninstaller = around(cls.prototype, {
      [method](old: (menu: Menu, ...args: unknown[]) => void) {
        return function (this: View, menu: Menu, ...args: unknown[]) {
          const popover = this.leaf ? HoverEditor.forLeaf(this.leaf) : undefined;
          if (!popover) {
            menu.addItem(item => {
              item
                .setIcon("popup-open")
                .setTitle("Open in Hover Editor")
                .onClick(async () => {
                  const newLeaf = plugin.spawnPopover(), {autoFocus} = plugin.settings;
                  await newLeaf.setViewState({...this.leaf.getViewState(), active: autoFocus}, {focus: autoFocus});
                  if (autoFocus) {
                    await sleep(200)
                    this.app.workspace.setActiveLeaf(newLeaf, {focus: true});
                  }
                })
                .setSection?.("open");
            });
            menu.addItem(item => {
              item
                .setIcon("popup-open")
                .setTitle("Convert to Hover Editor")
                .onClick(() => {
                  plugin.convertLeafToPopover(this.leaf);
                })
                .setSection?.("open");
            });
          } else {
            menu.addItem(item => {
              item
                .setIcon("popup-open")
                .setTitle("Dock Hover Editor to workspace")
                .onClick(() => {
                  plugin.dockPopoverToWorkspace(this.leaf);
                })
                .setSection?.("open");
            });
          }
          return old.call(this, menu, ...args);
        };
      },
    });
    this.register(uninstaller);

    this.register(around(ItemView.prototype, {
      load(old) {
        return function(this: View) {
          if (!this.iconEl) {
            const iconEl = this.iconEl = this.headerEl.createDiv("clickable-icon view-header-icon")
            this.headerEl.prepend(iconEl)
            iconEl.draggable = true
            iconEl.addEventListener("dragstart", e => { this.app.workspace.onDragLeaf(e, this.leaf) })
            setIcon(iconEl, this.getIcon())
            setTooltip(iconEl, "Drag to rearrange")
          }
          return old.call(this)
        }
      }
    }))
  }

  patchMarkdownPreviewView() {
    this.register(around(MarkdownPreviewView.prototype, {
      onResize(old) {
        return function onResize() {
          this.renderer.onResize();
          if (this.view.scroll !== null && this.view.scroll !== this.getScroll()) {
            this.renderer.applyScrollDelayed(this.view.scroll)
          }
        }
      }
    }))
  }

  patchMarkdownPreviewRenderer() {
    const plugin = this;
    const uninstaller = around(MarkdownPreviewRenderer as MarkdownPreviewRendererStatic, {
      registerDomEvents(old: Function) {
        return function (
          el: HTMLElement,
          instance: { getFile?(): TFile; hoverParent?: HoverParent, info?: HoverParent & { getFile(): TFile} },
          ...args: unknown[]
        ) {
          el?.on("mouseover", ".internal-embed.is-loaded", (event: MouseEvent, targetEl: HTMLElement) => {
            if (targetEl && plugin.settings.hoverEmbeds !== "native") {
              app.workspace.trigger("hover-link", {
                event: event,
                source: targetEl.matchParent(".markdown-source-view") ? "editor" : "preview",
                hoverParent: instance.hoverParent ?? instance.info,
                targetEl: targetEl,
                linktext: targetEl.getAttribute("src"),
                sourcePath: (instance.info ?? instance).getFile?.()?.path || "",
              });
            }
          });
          return old.call(this, el, instance, ...args);
        };
      },
    });
    this.register(uninstaller);
  }

  patchWorkspace() {
    let layoutChanging = false;
    const uninstaller = around(Workspace.prototype, {
      changeLayout(old) {
        return async function (workspace: unknown) {
          layoutChanging = true;
          try {
            await old.call(this, workspace);
          } finally {
            layoutChanging = false;
          }
        };
      },
      recordHistory(old) {
        return function (leaf: WorkspaceLeaf, pushHistory: boolean, ...args: unknown[]) {
          const paneReliefLoaded = this.app.plugins.plugins["pane-relief"]?._loaded;
          if (!paneReliefLoaded && isHoverLeaf(leaf)) return;
          return old.call(this, leaf, pushHistory, ...args);
        };
      },
      iterateLeaves(old) {
        type leafIterator = (item: WorkspaceLeaf) => boolean | void;
        return function (arg1, arg2) {
          if (old.call(this, arg1, arg2)) return true;

          let cb:     leafIterator  = (typeof arg1 === "function" ? arg1 : arg2) as leafIterator;
          let parent: WorkspaceItem = (typeof arg1 === "function" ? arg2 : arg1) as WorkspaceItem;

          if (!parent) return false;
          if (layoutChanging) return false;

          if (parent === app.workspace.rootSplit || (WorkspaceContainer && parent instanceof WorkspaceContainer)) {
            for(const popover of HoverEditor.popoversForWindow((parent as WorkspaceContainer).win)) {
              if (old.call(this, cb, popover.rootSplit)) return true;
            }
          }
          return false;
        };
      },
      getDropLocation(old) {
        return function getDropLocation(event: MouseEvent) {
          for (const popover of HoverEditor.activePopovers()) {
            const dropLoc: any = this.recursiveGetTarget(event, popover.rootSplit);
            if (dropLoc) {
              if (requireApiVersion && requireApiVersion("0.15.3")) {
                return dropLoc;
              } else {
                return { target: dropLoc, sidedock: false };
              }
            }
          }
          return old.call(this, event);
        };
      },
      onDragLeaf(old) {
        return function (event: MouseEvent, leaf: WorkspaceLeaf) {
          const hoverPopover = HoverEditor.forLeaf(leaf);
          hoverPopover?.togglePin(true);
          return old.call(this, event, leaf);
        };
      },
    });
    this.register(uninstaller);
  }

  patchSlidingPanes() {
    const SlidingPanesPlugin = this.app.plugins.plugins["sliding-panes-obsidian"]?.constructor;
    if (SlidingPanesPlugin) {
      const uninstaller = around(SlidingPanesPlugin.prototype, {
        handleFileOpen(old: Function) {
          return function (...args: unknown[]) {
            if (isHoverLeaf(this.app.workspace.activeLeaf)) return;
            return old.call(this, ...args);
          };
        },
        handleLayoutChange(old: Function) {
          return function (...args: unknown[]) {
            if (isHoverLeaf(this.app.workspace.activeLeaf)) return;
            return old.call(this, ...args);
          };
        },
        focusActiveLeaf(old: Function) {
          return function (...args: unknown[]) {
            if (isHoverLeaf(this.app.workspace.activeLeaf)) return;
            return old.call(this, ...args);
          };
        },
      });
      this.register(uninstaller);
    }
  }

  patchLinkHover() {
    const plugin = this;
    const pagePreviewPlugin = this.app.internalPlugins.plugins["page-preview"];
    if (!pagePreviewPlugin.enabled) return;

    const uninstaller = around(pagePreviewPlugin.instance.constructor.prototype, {
      onHoverLink(old: Function) {
        return function (options: { event: MouseEvent }, ...args: unknown[]) {
          if (options && isA(options.event, MouseEvent)) setMouseCoords(options.event);
          return old.call(this, options, ...args);
        };
      },
      onLinkHover(old: Function) {
        return function (
          parent: HoverEditorParent,
          targetEl: HTMLElement,
          linkText: string,
          path: string,
          state: EphemeralState,
          ...args: unknown[]
        ) {
          // Determine mode based on link type
          const { subpath } = parseLinktext(linkText);
          let mode: "native" | "floating" | "sidebar";

          if (subpath && subpath[0] === "#") {
            if (subpath.startsWith("#[^")) {
              mode = plugin.settings.footnotes;
            } else if (subpath.startsWith("#^")) {
              mode = plugin.settings.blocks;
            } else {
              mode = plugin.settings.headings;
            }
          } else if (linkText.startsWith("!")) {
            mode = plugin.settings.hoverEmbeds;
          } else {
            mode = plugin.settings.regularLinks;
          }

          // Native: delegate entirely to Obsidian
          if (mode === "native") {
            return old.call(this, parent, targetEl, linkText, path, state, ...args);
          }

          const handleHover = () => {
            // Check file exists first; fall back to native for unresolved links
            const file = plugin.app.metadataCache.getFirstLinkpathDest(
              parseLinktext(linkText).path,
              path,
            );

            if (!(file instanceof TFile)) {
              old.call(this, parent, targetEl, linkText, path, state, ...args);
              return;
            }

            if (mode === "sidebar") {
              // Delegate to the sidebar controller — fire-and-forget
              plugin.sidebar.openLink(linkText, path, state);
            } else {
              // Floating hover editor
              onLinkHover(plugin, parent, targetEl, linkText, path, state, ...args);
            }
          };

          if (plugin.settings.triggerDelay > 0) {
            setTimeout(handleHover, plugin.settings.triggerDelay);
          } else {
            handleHover();
          }
        };
      },
    });

    this.register(uninstaller);

    // Re-enable page preview to pick up patched methods
    pagePreviewPlugin.disable();
    pagePreviewPlugin.enable();

    plugin.register(function () {
      if (!pagePreviewPlugin.enabled) return;
      pagePreviewPlugin.disable();
      pagePreviewPlugin.enable();
    });
  }

  registerContextMenuHandler() {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string, leaf?: WorkspaceLeaf) => {
        const popover = leaf ? HoverEditor.forLeaf(leaf) : undefined;
        if (file instanceof TFile && !popover && !leaf) {
          menu.addItem(item => {
            item
              .setIcon("popup-open")
              .setTitle("Open in Hover Editor")
              .onClick(() => {
                const newLeaf = this.spawnPopover();
                newLeaf.openFile(file);
              })
              .setSection?.("open");
          });
        }
      }),
    );
  }

  registerActivePopoverHandler() {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", leaf => {
        HoverEditor.activePopover?.hoverEl.removeClass("is-active");
        const hoverEditor = (HoverEditor.activePopover = leaf ? HoverEditor.forLeaf(leaf) : undefined);
        if (hoverEditor && leaf) {
          hoverEditor.activate();
          hoverEditor.hoverEl.addClass("is-active");
          const titleEl = hoverEditor.hoverEl.querySelector(".popover-title");
          if (!titleEl) return;
          titleEl.textContent = leaf.view?.getDisplayText();
          if (leaf?.view?.getViewType()) {
            hoverEditor.hoverEl.setAttribute("data-active-view-type", leaf.view.getViewType());
          }
          if (leaf.view?.file?.path) {
            titleEl.setAttribute("data-path", leaf.view.file.path);
          } else {
            titleEl.removeAttribute("data-path");
          }
        }
      }),
    );
  }

  registerFileRenameHandler() {
    this.app.vault.on("rename", (file, oldPath) => {
      HoverEditor.iteratePopoverLeaves(this.app.workspace, leaf => {
        if (file === leaf?.view?.file && file instanceof TFile) {
          const hoverEditor = HoverEditor.forLeaf(leaf);
          if (hoverEditor?.hoverEl) {
            const titleEl = hoverEditor.hoverEl.querySelector(".popover-title");
            if (!titleEl) return;
            const filePath = titleEl.getAttribute("data-path");
            if (oldPath === filePath) {
              titleEl.textContent = leaf.view?.getDisplayText();
              titleEl.setAttribute("data-path", file.path);
            }
          }
        }
      });
    });
  }

  debouncedPopoverReflow = debounce(
    () => {
      HoverEditor.activePopovers().forEach(popover => {
        popover.interact?.reflow({ name: "drag", axis: "xy" });
      });
    },
    100,
    true,
  );

  patchUnresolvedGraphNodeHover() {
    const leaf = new (WorkspaceLeaf as new (app: App) => WorkspaceLeaf)(this.app);
    const view = this.app.internalPlugins.plugins.graph.views.localgraph(leaf);
    const GraphEngine = view.engine.constructor;
    leaf.detach();
    view.renderer?.worker?.terminate();
    const uninstall = around(GraphEngine.prototype, {
      onNodeHover(old: Function) {
        return function (event: UIEvent, linkText: string, nodeType: string, ...items: unknown[]) {
          if (nodeType === "unresolved") {
            if ((this.onNodeUnhover(), isA(event, MouseEvent))) {
              if (
                this.hoverPopover &&
                this.hoverPopover.state !== PopoverState.Hidden &&
                this.lastHoverLink === linkText
              ) {
                this.hoverPopover.onTarget = true;
                return void this.hoverPopover.transition();
              }
              this.lastHoverLink = linkText;
              this.app.workspace.trigger("hover-link", {
                event: event,
                source: "graph",
                hoverParent: this,
                targetEl: null,
                linktext: linkText,
              });
            }
          } else {
            return old.call(this, event, linkText, nodeType, ...items);
          }
        };
      },
    });
    this.register(uninstall);
    leaf.detach();
  }

  onunload(): void {
    HoverEditor.activePopovers().forEach(popover => popover.hide());
    this.sidebar.unload();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  registerCommands() {
    // --- Sidebar commands --------------------------------------------------

    this.addCommand({
      id: "open-sidebar-preview",
      name: "Open sidebar preview",
      callback: async () => {
        await this.sidebar.openShell();
      },
    });

    this.addCommand({
      id: "open-current-file-in-sidebar",
      name: "Open current file in sidebar preview",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.activeEditor?.file ?? this.app.workspace.getActiveFile();
        if (activeFile) {
          if (!checking) this.sidebar.openFileDirectly(activeFile);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "open-link-in-sidebar",
      name: "Open link under cursor in sidebar preview",
      checkCallback: (checking: boolean) => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          if (!checking) {
            const token = activeView.editor.getClickableTokenAt(activeView.editor.getCursor());
            if (token?.type === "internal-link") {
              this.sidebar.openLink(token.text, activeView.file.path);
            }
          }
          return true;
        }
        return false;
      },
    });

    // --- Hover editor commands ---------------------------------------------

    this.addCommand({
      id: "bounce-popovers",
      name: "Toggle bouncing popovers",
      callback: () => {
        HoverEditor.activePopovers().forEach(popover => {
          popover.toggleBounce();
        });
      },
    });
    this.addCommand({
      id: "open-new-popover",
      name: "Open new Hover Editor",
      callback: () => {
        const newLeaf = this.spawnPopover(undefined, () => this.app.workspace.setActiveLeaf(newLeaf, false, true));
      },
    });
    this.addCommand({
      id: "open-link-in-new-popover",
      name: "Open link under cursor in new Hover Editor",
      checkCallback: (checking: boolean) => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          if (!checking) {
            const token = activeView.editor.getClickableTokenAt(activeView.editor.getCursor());
            if (token?.type === "internal-link") {
              const newLeaf = this.spawnPopover(undefined, () =>
                this.app.workspace.setActiveLeaf(newLeaf, false, true),
              );
              newLeaf.openLinkText(token.text, activeView.file.path);
            }
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "open-current-file-in-new-popover",
      name: "Open current file in new Hover Editor",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.activeEditor?.file ?? this.app.workspace.getActiveFile();
        if (activeFile) {
          if (!checking) {
            const newLeaf = this.spawnPopover(undefined, () => this.app.workspace.setActiveLeaf(newLeaf, false, true));
            newLeaf.openFile(activeFile);
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "convert-active-pane-to-popover",
      name: "Convert active pane to Hover Editor",
      checkCallback: (checking: boolean) => {
        const { activeLeaf } = this.app.workspace;
        if (activeLeaf) {
          if (!checking) {
            this.convertLeafToPopover(activeLeaf);
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "dock-active-popover-to-workspace",
      name: "Dock active Hover Editor to workspace",
      checkCallback: (checking: boolean) => {
        const { activeLeaf } = this.app.workspace;
        if (activeLeaf && HoverEditor.forLeaf(activeLeaf)) {
          if (!checking) {
            this.dockPopoverToWorkspace(activeLeaf);
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: `restore-active-popover`,
      name: `Restore active Hover Editor`,
      checkCallback: (checking: boolean) => {
        return restoreActivePopover(checking);
      },
    });
    this.addCommand({
      id: `minimize-active-popover`,
      name: `Minimize active Hover Editor`,
      checkCallback: (checking: boolean) => {
        return minimizeActivePopover(checking);
      },
    });
    snapDirections.forEach(direction => {
      this.addCommand({
        id: `snap-active-popover-to-${direction}`,
        name: `Snap active Hover Editor to ${direction}`,
        checkCallback: (checking: boolean) => {
          return snapActivePopover(direction, checking);
        },
      });
    });
  }

  convertLeafToPopover(oldLeaf: WorkspaceLeaf) {
    if (!oldLeaf) return;
    const newLeaf = this.spawnPopover(undefined, () => {
      const { parentSplit: newParentSplit } = newLeaf;
      const { parentSplit: oldParentSplit } = oldLeaf;
      oldParentSplit.removeChild(oldLeaf);
      newParentSplit.replaceChild(0, oldLeaf, true);
      this.app.workspace.setActiveLeaf(oldLeaf, {focus: true});
    });
    return newLeaf;
  }

  dockPopoverToWorkspace(oldLeaf: WorkspaceLeaf) {
    if (!oldLeaf) return;
    oldLeaf.parentSplit.removeChild(oldLeaf);
    const {rootSplit} = this.app.workspace;
    this.app.workspace.iterateLeaves(rootSplit, leaf => {
      leaf.parentSplit.insertChild(-1, oldLeaf)
      return true
    })
    this.app.workspace.activeLeaf = null;
    this.app.workspace.setActiveLeaf(oldLeaf, {focus: true});
    return oldLeaf;
  }

  spawnPopover(initiatingEl?: HTMLElement, onShowCallback?: () => unknown): WorkspaceLeaf {
    const parent = this.app.workspace.activeLeaf as unknown as HoverEditorParent;
    if (!initiatingEl) initiatingEl = parent.containerEl;
    const hoverPopover = new HoverEditor(parent, initiatingEl!, this, undefined, onShowCallback);
    hoverPopover.togglePin(true);
    return hoverPopover.attachLeaf();
  }

  registerSettingsTab() {
    this.settingsTab = new SettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
  }
}

export function genId(size: number) {
  const chars = [];
  for (let n = 0; n < size; n++) chars.push(((16 * Math.random()) | 0).toString(16));
  return chars.join("");
}