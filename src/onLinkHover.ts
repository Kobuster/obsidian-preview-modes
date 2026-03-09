import { EphemeralState, PopoverState, Platform } from "obsidian";
import HoverEditorPlugin from "./main";
import { HoverEditorParent, HoverEditor } from "./popover";
import { isA } from "./utils/misc";

const targetPops = new WeakMap<HTMLElement, HoverEditor>();

// Keeps track of active sidebar hover timers so we can cancel them
const sidebarTimers = new WeakMap<HTMLElement, NodeJS.Timeout>();

export function onLinkHover(
  plugin: HoverEditorPlugin,
  parent: HoverEditorParent,
  targetEl: HTMLElement,
  linkText: string,
  path: string,
  oldState: EphemeralState,
  mode: "floating" | "sidebar", // NEW: Accept mode parameter
  ...args: unknown[]
) {
  // DOM cleanup workarounds (unchanged)
  if (targetEl && targetEl.matches('.workspace-leaf-content[data-type="calendar"] table.calendar td > div'))
    targetEl = targetEl.parentElement!;
  if (oldState && "scroll" in oldState && !("line" in oldState) && targetEl && targetEl.matches(".search-result-file-match")) {
    oldState.line = oldState.scroll;
    delete oldState.scroll;
  }
  if (targetEl && targetEl.matches(".bookmark .tree-item-inner")) {
    if (parent && (parent as any).innerEl === targetEl) parent = (parent as any).tree as HoverEditorParent;
    targetEl = targetEl.parentElement ?? targetEl;
  }

  // ==========================================
  // SIDEBAR MODE LOGIC
  // ==========================================
  if (mode === "sidebar") {
    // If we are already hovering this element and waiting, do nothing
    if (sidebarTimers.has(targetEl)) return;

    // Set the trigger delay timer
    const timer = setTimeout(() => {
      sidebarTimers.delete(targetEl);
      // Once timer pops, tell the sidebar class to load the link!
      plugin.sidebarPreview.openLink(linkText, path, oldState);
    }, plugin.settings.triggerDelay);

    sidebarTimers.set(targetEl, timer);

    // FIX THE BUG: Cancel the timer if the mouse leaves before the delay finishes
    const onMouseOut = (event: MouseEvent) => {
      const relatedTarget = event.relatedTarget;
      if (!(isA(relatedTarget, Node) && targetEl.contains(relatedTarget))) {
        clearTimeout(timer);
        sidebarTimers.delete(targetEl);
        targetEl.removeEventListener("mouseout", onMouseOut);
      }
    };
    targetEl.addEventListener("mouseout", onMouseOut);
    return; // Stop here for sidebar mode
  }

  // ==========================================
  // FLOATING (HOVER EDITOR) LOGIC
  // ==========================================
  const prevPopover = targetPops.has(targetEl) ? targetPops.get(targetEl) : parent.hoverPopover;
  if (prevPopover?.lockedOut) return;

  const parentHasExistingPopover =
    prevPopover &&
    prevPopover.state !== PopoverState.Hidden &&
    (!prevPopover.isPinned || plugin.settings.autoPin === "always") &&
    prevPopover.targetEl !== null &&
    prevPopover.originalLinkText === linkText &&
    prevPopover.originalPath === path &&
    targetEl &&
    prevPopover.adopt(targetEl);

  if (parentHasExistingPopover) {
    targetPops.set(targetEl, prevPopover);
  } else {
    const editor = new HoverEditor(parent, targetEl, plugin, plugin.settings.triggerDelay);
    if (targetEl) targetPops.set(targetEl, editor);
    editor.originalLinkText = linkText;
    editor.originalPath = path;
    parent.hoverPopover = editor;
    const controller = editor.abortController!;

    const unlock = function () {
      if (!editor) return;
      editor.lockedOut = false;
    };

    const onMouseDown = function (event: MouseEvent) {
      if (!editor) return;
      if (isA(event.target, HTMLElement) && !event.target.closest(".hover-editor, .menu")) {
        editor.state = PopoverState.Hidden;
        editor.hide();
        editor.lockedOut = true;
        setTimeout(unlock, 1000);
      }
    };

    const { document } = editor;

    const onKeyUp = function (event: KeyboardEvent) {
      if (!editor) return;
      const modKey = Platform.isMacOS ? "Meta" : "Control";
      if (!editor.onHover && editor.state !== PopoverState.Shown && event.key !== modKey) {
        editor.state = PopoverState.Hidden;
        editor.hide();
        editor.lockedOut = true;
        setTimeout(unlock, 1000);
      } else {
        document.body.removeEventListener("keyup", onKeyUp, true);
      }
    };

    document.addEventListener("pointerdown", onMouseDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.body.addEventListener("keyup", onKeyUp, true);
    controller.register(() => {
      document.removeEventListener("pointerdown", onMouseDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.body.removeEventListener("keyup", onKeyUp, true);
    });

    setTimeout(() => {
      if (editor?.state == PopoverState.Hidden) {
        return;
      }
      editor?.openLink(linkText, path, oldState);
    }, 0);
  }
}