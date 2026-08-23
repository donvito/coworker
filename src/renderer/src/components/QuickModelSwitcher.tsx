import { useEffect, useId, useRef, useState } from "react";
import type { Coworker, ModelOption, RemoteModelProvider } from "@shared/contracts";
import {
  modelProviderCredentialKey,
  modelProviderName,
  remoteModelProviderDefinitions,
} from "@shared/model-providers";
import { modelOptionLabel, modelPricingLabel } from "../lib/model-pricing";

export function QuickModelSwitcher({
  coworker,
  disabled = false,
  onChanged,
}: {
  coworker: Coworker;
  disabled?: boolean;
  onChanged: () => Promise<void>;
}) {
  const initialProvider =
    coworker.modelProvider === "demo" ? "" : coworker.modelProvider;
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState(coworker.modelName);
  const [selectedProvider, setSelectedProvider] = useState<RemoteModelProvider | "">(
    initialProvider,
  );
  const [catalogProvider, setCatalogProvider] = useState<RemoteModelProvider | "">(
    initialProvider,
  );
  const [configuredProviders, setConfiguredProviders] = useState<RemoteModelProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [selectedOption, setSelectedOption] = useState<ModelOption | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listboxId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);

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
    setSelectedModel(coworker.modelName);
    const nextProvider = coworker.modelProvider === "demo" ? "" : coworker.modelProvider;
    setSelectedProvider(nextProvider);
    setCatalogProvider(nextProvider);
    setSelectedOption(null);
    setOpen(false);
    setQuery("");
  }, [coworker.modelName, coworker.modelProvider]);

  useEffect(() => {
    let cancelled = false;
    setProvidersLoading(true);
    void Promise.all(
      remoteModelProviderDefinitions.map(async (provider) => ({
        provider: provider.id,
        configured: (
          await window.coworker.integrations.credentialStatus(
            modelProviderCredentialKey(provider.id),
          )
        ).configured,
      })),
    )
      .then((statuses) => {
        if (cancelled) return;
        const available = statuses
          .filter((status) => status.configured)
          .map((status) => status.provider);
        setConfiguredProviders(available);
        setCatalogProvider((current) =>
          current && available.includes(current) ? current : (available[0] ?? ""),
        );
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) setProvidersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coworker.modelProvider]);

  useEffect(() => {
    let cancelled = false;
    if (!catalogProvider) {
      setModels([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setQuery("");
    void window.coworker.integrations
      .listModels(catalogProvider)
      .then((availableModels) => {
        if (cancelled) return;
        setModels(availableModels);
        if (catalogProvider === selectedProvider) {
          setSelectedOption(
            availableModels.find((model) => model.id === selectedModel) ?? null,
          );
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogProvider]);

  async function changeModel(modelName: string) {
    const previousModel = selectedModel;
    const previousProvider = selectedProvider;
    const previousOption = selectedOption;
    const nextOption = models.find((model) => model.id === modelName) ?? null;
    if (!catalogProvider) return;
    setSelectedModel(modelName);
    setSelectedProvider(catalogProvider);
    setSelectedOption(nextOption);
    setSaving(true);
    setError(null);
    setOpen(false);
    try {
      await window.coworker.coworkers.update(coworker.id, {
        modelProvider: catalogProvider,
        modelName,
      });
      await onChanged();
    } catch (saveError) {
      setSelectedModel(previousModel);
      setSelectedProvider(previousProvider);
      setSelectedOption(previousOption);
      setCatalogProvider(previousProvider);
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  const selectedPricing = modelPricingLabel(selectedOption ?? {});
  const normalizedQuery = query.trim().toLowerCase();
  const matchingModels = normalizedQuery
    ? models.filter((model) =>
        `${model.name} ${model.id}`.toLowerCase().includes(normalizedQuery),
      )
    : models;
  const visibleModels =
    !normalizedQuery && catalogProvider === selectedProvider && selectedOption
      ? [selectedOption, ...matchingModels.filter((model) => model.id !== selectedOption.id)]
      : matchingModels;

  return (
    <span className="conversation-model-switcher" ref={rootRef}>
      <button
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Model used by ${coworker.name}`}
        className="quick-model-trigger"
        disabled={disabled || providersLoading || saving || configuredProviders.length === 0}
        onClick={() => setOpen((current) => !current)}
        role="combobox"
        title={error ?? `Change ${coworker.name}'s model`}
        type="button"
      >
        <span>
          {selectedProvider ? (selectedOption?.name ?? selectedModel) : "Choose provider and model"}
        </span>
        <b aria-hidden="true">⌄</b>
      </button>
      {open ? (
        <div className="quick-model-popover">
          <label className="quick-model-provider">
            <span>Provider</span>
            <select
              aria-label={`Model provider for ${coworker.name}`}
              disabled={saving}
              onChange={(event) => {
                setCatalogProvider(event.target.value as RemoteModelProvider);
                setQuery("");
              }}
              value={catalogProvider}
            >
              {remoteModelProviderDefinitions
                .filter((provider) => configuredProviders.includes(provider.id))
                .map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
            </select>
          </label>
          <div className="quick-model-search">
            <input
              aria-label={`Search models for ${coworker.name}`}
              autoFocus
              disabled={loading}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by model name or ID…"
              type="search"
              value={query}
            />
            <small>
              {loading
                ? "Loading…"
                : normalizedQuery
                  ? `${matchingModels.length} of ${models.length}`
                  : `${models.length} models`}
            </small>
          </div>
          <div className="quick-model-options" id={listboxId} role="listbox">
            {loading ? (
              <span className="quick-model-empty">Loading model catalog…</span>
            ) : visibleModels.length > 0 ? (
              visibleModels.map((model) => {
                const pricing = modelPricingLabel(model);
                return (
                  <button
                    aria-selected={
                      catalogProvider === selectedProvider && model.id === selectedModel
                    }
                    className={
                      catalogProvider === selectedProvider && model.id === selectedModel
                        ? "selected"
                        : ""
                    }
                    key={model.id}
                    onClick={() => void changeModel(model.id)}
                    role="option"
                    title={modelOptionLabel(model)}
                    type="button"
                  >
                    <span className="quick-model-option-name">
                      <strong>{model.name}</strong>
                      {model.supportsImages ? <b>Images</b> : null}
                    </span>
                    <span className="quick-model-option-meta">
                      <code>{model.id}</code>
                      {pricing ? <small>{pricing}</small> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <span className="quick-model-empty">No models match this search.</span>
            )}
          </div>
        </div>
      ) : null}
      <small className={error ? "error" : ""} role={error ? "alert" : "status"}>
        {error
          ? "Not saved"
          : saving
            ? "Saving…"
            : providersLoading || loading
              ? "Loading…"
              : disabled
                ? "Available after this run"
                : selectedProvider
                  ? `${modelProviderName(selectedProvider)} · Auto-saves${
                      selectedPricing ? ` · ${selectedPricing}` : ""
                    }`
                  : "No configured provider"}
      </small>
    </span>
  );
}
