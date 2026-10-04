import { useEffect, useRef, useState } from "react";
import type { ChatGPTAuthStatus } from "@shared/chatgpt-auth";
import { ModalPortal } from "./ModalPortal";

export function isChatGPTPlanConnected(
  status: ChatGPTAuthStatus | null | undefined,
): boolean {
  if (!status || status.mode !== "chatgpt-subscription" || status.state !== "connected") {
    return false;
  }
  const account = status.accounts.find((candidate) => candidate.id === status.activeAccountId);
  return Boolean(account?.connected && account.planUsageEnabled);
}

/** Keep plan usage and its management action together at the composer. */
export function ChatGPTPlanIndicator({
  status,
  usageLimitReached = false,
}: {
  status: ChatGPTAuthStatus | null | undefined;
  usageLimitReached?: boolean;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const ready = isChatGPTPlanConnected(status);

  useEffect(() => {
    setActionError(null);
  }, [status?.activeAccountId, status?.mode, usageLimitReached]);

  if (!ready) return null;

  async function manageUsage() {
    setActionError(null);
    try {
      await window.coworker.integrations.chatgptManageUsage();
    } catch {
      setActionError("Couldn’t open ChatGPT Settings. Try again, or open Settings → Usage in ChatGPT.");
    }
  }

  return (
    <span
      aria-live={usageLimitReached ? undefined : "polite"}
      className={`chatgpt-plan-indicator${usageLimitReached ? " usage-limit" : ""}`}
      role={usageLimitReached ? "alert" : "status"}
    >
      {usageLimitReached ? (
        <span className="chatgpt-plan-indicator-copy">
          <strong>ChatGPT</strong>
          <small>Usage limit reached. Review your plan in ChatGPT Settings → Usage.</small>
        </span>
      ) : (
        <span className="chatgpt-plan-indicator-copy">Using ChatGPT plan</span>
      )}
      <button
        className={usageLimitReached ? "primary-button" : "chatgpt-plan-manage"}
        onClick={() => void manageUsage()}
        type="button"
      >
        Manage usage
      </button>
      {actionError ? <small className="chatgpt-plan-action-error" role="alert">{actionError}</small> : null}
    </span>
  );
}

/** The first successful plan sign-in needs an explicit, persistent acknowledgement. */
export function ChatGPTWelcomeDialog({
  status,
  onAcknowledge,
}: {
  status: ChatGPTAuthStatus | null | undefined;
  onAcknowledge: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const acknowledgeActionRef = useRef<() => Promise<void>>(async () => undefined);
  const onAcknowledgeRef = useRef(onAcknowledge);
  onAcknowledgeRef.current = onAcknowledge;
  const visible = isChatGPTPlanConnected(status) && !status?.welcomeSeen;

  useEffect(() => {
    if (!visible) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const focusableItems = () =>
      dialog
        ? Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
    focusableItems()[0]?.focus();

    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        void acknowledgeActionRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusableItems();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const focusIsOutside = !dialog?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || focusIsOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || focusIsOutside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKeys);
    return () => {
      document.removeEventListener("keydown", handleDialogKeys);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [visible]);

  async function acknowledge() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onAcknowledgeRef.current();
    } catch {
      setError("Couldn’t save this choice. Please try again.");
      busyRef.current = false;
      setBusy(false);
    }
  }
  acknowledgeActionRef.current = acknowledge;

  if (!visible) return null;

  return (
    <ModalPortal>
      <div
        className="modal-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busyRef.current) void acknowledge();
        }}
        role="presentation"
      >
        <section
          aria-labelledby="chatgpt-welcome-title"
          aria-modal="true"
          className="modal-card chatgpt-welcome-modal"
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <span className="eyebrow">ChatGPT</span>
          <h2 id="chatgpt-welcome-title">You’re using your ChatGPT plan</h2>
          <p>
          Coworker uses your ChatGPT plan’s allowance for eligible requests. You can manage usage
          in ChatGPT settings.
          </p>
          {error ? <div className="inline-error" role="alert">{error}</div> : null}
          <div className="modal-actions">
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void acknowledge()}
              type="button"
            >
              {busy ? "Saving…" : "Got it"}
            </button>
          </div>
        </section>
      </div>
    </ModalPortal>
  );
}
