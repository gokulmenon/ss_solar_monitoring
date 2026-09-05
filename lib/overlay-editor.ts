export const OVERLAY_EDITOR_STORAGE_KEY = "hoymiles-overlay-editor-enabled";

export const OVERLAY_EDITOR_CHANGED_EVENT = "hoymiles-overlay-editor-changed";

export function readOverlayEditorEnabled(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(OVERLAY_EDITOR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeOverlayEditorEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(OVERLAY_EDITOR_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Storage unavailable — the toggle still works for the session.
  }
  try {
    window.dispatchEvent(new Event(OVERLAY_EDITOR_CHANGED_EVENT));
  } catch {
    // Event dispatch is best-effort; navigation re-reads the flag anyway.
  }
}
