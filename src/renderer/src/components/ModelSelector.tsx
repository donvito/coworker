import { useEffect, useId, useRef, useState } from "react";
import type { ModelOption, ModelProvider } from "@shared/contracts";
import { modelOptionLabel, modelPricingLabel } from "../lib/model-pricing";

export function ModelSelector({
  disabled = false,
  onChange,
  provider,
  value,
}: {
  disabled?: boolean;
  onChange: (modelId: string) => void;
  provider: ModelProvider;
  value: string;
}) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState("");
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setModels([]);
    setQuery("");
    setOpen(false);

    void window.coworker.integrations
      .listModels(provider)
      .then((availableModels) => {
        if (cancelled) return;
        setModels(availableModels);
        setLoading(false);
        if (availableModels.length === 0) {
          onChange("");
          setError("No compatible chat models are available to this credential.");
          return;
        }
        if (!availableModels.some((model) => model.id === value)) {
          onChange(availableModels[0]!.id);
        }
      })
      .catch((loadError) => {
        if (cancelled) return;
        setLoading(false);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });

    return () => {
      cancelled = true;
    };
  }, [provider, refreshVersion]);

  const includesValue = models.some((model) => model.id === value);
  const selectedModel = models.find((model) => model.id === value);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = normalizedQuery
    ? models.filter((model) =>
        `${model.name} ${model.id}`.toLowerCase().includes(normalizedQuery),
      )
    : models;
  const placeholder = loading
    ? "Loading models…"
    : error
      ? "Models unavailable"
      : "No compatible models";

  return (
    <div className="model-selector" ref={rootRef}>
      <span id={labelId}>Model</span>
      {models.length > 8 || provider === "openrouter" ? (
        <span className="model-selector-search">
          <input
            aria-label={`Search ${provider} models`}
            disabled={disabled || loading}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="Search models by name or ID…"
            type="search"
            value={query}
          />
        </span>
      ) : null}
      <div className="model-selector-control">
        <div className="model-selector-picker">
          <button
            aria-busy={loading}
            aria-controls={listboxId}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-labelledby={labelId}
            className="model-selector-trigger"
            disabled={disabled || loading || models.length === 0}
            onClick={() => setOpen((current) => !current)}
            role="combobox"
            title={selectedModel ? modelOptionLabel(selectedModel) : value}
            type="button"
          >
            <span>
              <strong>{selectedModel?.name ?? (value || placeholder)}</strong>
              <small>
                {selectedModel ? (
                  <>
                    <code>{selectedModel.id}</code>
                    {modelPricingLabel(selectedModel) ? (
                      <span>{modelPricingLabel(selectedModel)}</span>
                    ) : null}
                  </>
                ) : value && !includesValue ? (
                  loading ? "Checking availability…" : "Last selected model"
                ) : null}
              </small>
            </span>
            <span aria-hidden="true" className="model-selector-chevron">⌄</span>
          </button>
          {open ? (
            <div className="model-selector-options" id={listboxId} role="listbox">
              {visibleModels.length > 0 ? (
                visibleModels.map((model) => {
                  const pricing = modelPricingLabel(model);
                  return (
                    <button
                      aria-selected={model.id === value}
                      className={model.id === value ? "selected" : ""}
                      key={model.id}
                      onClick={() => {
                        onChange(model.id);
                        setOpen(false);
                      }}
                      role="option"
                      title={modelOptionLabel(model)}
                      type="button"
                    >
                      <span className="model-selector-option-main">
                        <strong>{model.name}</strong>
                        {model.supportsImages ? <b>Images</b> : null}
                      </span>
                      <span className="model-selector-option-meta">
                        <code>{model.id}</code>
                        {pricing ? <small>{pricing}</small> : null}
                      </span>
                    </button>
                  );
                })
              ) : (
                <span className="model-selector-empty">No models match this search.</span>
              )}
            </div>
          ) : null}
        </div>
        {provider !== "demo" ? (
          <button
            aria-label={`Refresh ${provider} models`}
            className="model-selector-refresh"
            disabled={disabled || loading}
            onClick={() => setRefreshVersion((current) => current + 1)}
            type="button"
          >
            Refresh
          </button>
        ) : null}
      </div>
      <small className={error ? "model-selector-status error" : "model-selector-status"}>
        {error ??
          (loading
            ? `Querying ${provider === "demo" ? "the built-in runtime" : provider}…`
            : normalizedQuery
              ? `${visibleModels.length} of ${models.length} models match`
              : `${models.length} compatible model${models.length === 1 ? "" : "s"} available${
                  provider === "openrouter" ? " · live USD catalog pricing per 1M tokens" : ""
                }`)}
      </small>
    </div>
  );
}
