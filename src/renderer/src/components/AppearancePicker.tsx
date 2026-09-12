import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  colorModeOptions,
  themeOptions,
  type AppearancePatch,
} from "../lib/appearance-options";
import { readableError } from "../lib/errors";
import { useAppData } from "../state/AppDataProvider";
import { AppearanceControls } from "./AppearanceControls";
import { Icon } from "./Icon";
import { ModalPortal } from "./ModalPortal";

export function AppearancePicker() {
  const { snapshot, refresh } = useAppData();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const savingFocusRef = useRef<HTMLElement | null>(null);
  const dialogId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const reposition = () => {
      const anchor = trigger.getBoundingClientRect();
      const panel = popover.getBoundingClientRect();
      const margin = 12;
      const maxLeft = Math.max(margin, window.innerWidth - panel.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - panel.height - margin);
      setPosition({
        left: Math.min(Math.max(margin, anchor.right + 10), maxLeft),
        top: Math.min(Math.max(margin, anchor.bottom - panel.height), maxTop),
      });
    };
    reposition();
    popover.querySelector<HTMLButtonElement>('.color-mode-option[aria-pressed="true"]')?.focus();

    const isInside = (target: EventTarget | null) =>
      target instanceof Node && (trigger.contains(target) || popover.contains(target));
    const dismissOutside = (event: Event) => {
      if (!isInside(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.focus();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", onKeyDown);
    const observer = new ResizeObserver(reposition);
    observer.observe(popover);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", onKeyDown);
      observer.disconnect();
    };
  }, [open]);

  useLayoutEffect(() => {
    if (working || !open || !savingFocusRef.current) return;
    // Disabled controls can lose browser focus while their selection is saved.
    // Restore only if focus has not moved elsewhere in the meantime.
    if (
      document.activeElement === document.body ||
      document.activeElement === savingFocusRef.current
    ) {
      savingFocusRef.current.focus();
    }
    savingFocusRef.current = null;
  }, [working, open]);

  if (!snapshot) return null;
  const settings = snapshot.settings;
  const theme = themeOptions.find((option) => option.id === settings.theme)?.label;
  const colorMode = colorModeOptions.find((option) => option.id === settings.colorMode)?.label;

  async function saveAppearance(patch: AppearancePatch) {
    if (working) return;
    savingFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setWorking(true);
    setError(null);
    try {
      await window.coworker.app.updateSettings(patch);
      await refresh();
    } catch (settingsError) {
      setError(readableError(settingsError));
    } finally {
      setWorking(false);
    }
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div className="appearance-picker">
      <button
        aria-controls={open ? dialogId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Appearance: ${theme}, ${colorMode}`}
        className="appearance-trigger"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        title="Change appearance"
        type="button"
      >
        <Icon name="palette" />
        <span>
          <strong>Appearance</strong>
          <small>{theme} · {colorMode}</small>
        </span>
        <Icon name="arrow" />
      </button>
      {open && (
        <ModalPortal>
          <div
            aria-label="Appearance"
            className="appearance-popover"
            id={dialogId}
            ref={popoverRef}
            role="dialog"
            style={{ left: position.left, top: position.top }}
          >
            <header className="appearance-popover-header">
              <strong>Appearance</strong>
              <button
                aria-label="Close appearance picker"
                className="appearance-popover-close"
                onClick={close}
                type="button"
              >
                <span aria-hidden="true">×</span>
              </button>
            </header>
            <p className="appearance-popover-description">Choose your colors without leaving your work.</p>
            <AppearanceControls
              compact
              disabled={working}
              onChange={(patch) => void saveAppearance(patch)}
              settings={settings}
            />
            {error && <p className="appearance-popover-error" role="alert">{error}</p>}
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
