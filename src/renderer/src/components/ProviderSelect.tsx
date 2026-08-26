import { useEffect, useId, useRef, useState } from "react";
import type { ModelEndpoint, RemoteModelProvider } from "@shared/contracts";
import { remoteModelProviderDefinitions } from "@shared/model-providers";

interface ProviderOption {
  id: RemoteModelProvider | "";
  label: string;
  hint?: string;
}

/**
 * Styled replacement for the native provider <select>: known providers plus
 * the user's named OpenAI-compatible endpoints, rendered with the same look
 * as the model picker.
 */
export function ProviderSelect({
  value,
  onChange,
  modelEndpoints = [],
  emptyLabel,
  disabled = false,
}: {
  value: RemoteModelProvider | "";
  onChange: (provider: RemoteModelProvider | "") => void;
  modelEndpoints?: ModelEndpoint[];
  /** When set, offers a "no provider" option with this label. */
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const options: ProviderOption[] = [
    ...(emptyLabel ? [{ id: "" as const, label: emptyLabel }] : []),
    ...remoteModelProviderDefinitions
      .filter((definition) => definition.id !== "openai-compatible")
      .map((definition) => ({ id: definition.id, label: definition.label })),
    ...modelEndpoints.map((endpoint) => ({
      id: endpoint.id,
      label: endpoint.name,
      hint: "OpenAI-compatible endpoint",
    })),
  ];
  const selected = options.find((option) => option.id === value);

  return (
    <div className="model-selector provider-select" ref={rootRef}>
      <span id={labelId}>Model provider</span>
      <div className="model-selector-picker">
        <button
          aria-controls={listboxId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-labelledby={labelId}
          className="model-selector-trigger provider-select-trigger"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          role="combobox"
          type="button"
        >
          <span>
            <strong>{selected?.label ?? emptyLabel ?? "Choose a provider"}</strong>
          </span>
          <span aria-hidden="true" className="model-selector-chevron">⌄</span>
        </button>
        {open ? (
          <div className="model-selector-options" id={listboxId} role="listbox">
            {options.map((option) => (
              <button
                aria-selected={option.id === value}
                className={option.id === value ? "selected" : ""}
                key={option.id || "none"}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <span className="model-selector-option-main">
                  <strong>{option.label}</strong>
                </span>
                {option.hint ? (
                  <span className="model-selector-option-meta">
                    <small>{option.hint}</small>
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
