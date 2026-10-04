import { useEffect, useId, useRef } from "react";
import type { AppUpdateNotice } from "@shared/contracts";
import { Icon } from "./Icon";
import { ModalPortal } from "./ModalPortal";

export function AppUpdateDialog({ notice, busy, error, onDismiss, onDownload }: {
  notice: AppUpdateNotice;
  busy: boolean;
  error: string | null;
  onDismiss: () => void;
  onDownload: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef(onDismiss);
  const busyRef = useRef(busy);
  dismissRef.current = onDismiss;
  busyRef.current = busy;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    doneButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busyRef.current) dismissRef.current();
      } else if (event.key === "Tab") {
        const controls = panel.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
        if (!controls?.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const title = notice.kind === "available" ? `Coworker ${notice.version} is available.`
    : notice.kind === "checking" ? "Checking for updates…"
    : notice.kind === "up-to-date" ? "You’re up to date." : "Could not check for updates.";
  const description = notice.kind === "available" ? "Download the new version from GitHub to update Coworker."
    : notice.kind === "checking" ? "Looking for a new version of Coworker."
    : notice.kind === "up-to-date" ? "No newer version of Coworker is available." : notice.message;

  return (
    <ModalPortal>
      <div className="modal-backdrop app-update-backdrop" onMouseDown={() => { if (!busy) onDismiss(); }}>
        <section
          aria-describedby={descriptionId}
          aria-labelledby={titleId}
          aria-modal="true"
          className="modal-card app-update-dialog"
          onMouseDown={event => event.stopPropagation()}
          ref={panel}
          role="dialog"
        >
          <header className="app-update-header">
            <span className="eyebrow">App updates</span>
            <button aria-label="Dismiss update notice" className="icon-button" disabled={busy} onClick={onDismiss} title="Close" type="button">
              <Icon name="close" />
            </button>
          </header>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
          {error ? <p className="inline-error" role="alert">{error}</p> : null}
          <footer className="modal-actions">
            {notice.kind === "available" ? (
              <button className="secondary-button" disabled={busy} onClick={onDismiss} type="button">Later</button>
            ) : null}
            <button className="primary-button" disabled={busy} onClick={notice.kind === "available" ? onDownload : onDismiss} ref={doneButton} type="button">
              {notice.kind === "available" ? "Download" : notice.kind === "checking" ? "Close" : "OK"}
            </button>
          </footer>
        </section>
      </div>
    </ModalPortal>
  );
}
