import { useEffect, useId, useRef, useState } from "react";
import type {
  Coworker,
  ModelEndpoint,
  ModelOption,
  RemoteModelProvider,
} from "@shared/contracts";
import {
  modelProviderCredentialKey,
  modelProviderDisplayName,
  remoteModelProviderDefinitions,
} from "@shared/model-providers";
import { modelOptionLabel, modelPricingLabel } from "../lib/model-pricing";
import type { ChatGPTAuthStatus } from "@shared/chatgpt-auth";
import { ChatGPTPlanIndicator, isChatGPTPlanConnected } from "./ChatGPTPlanIndicator";

export function QuickModelSwitcher({
  coworker,
  disabled = false,
  modelEndpoints = [],
  onChanged,
  placement = "down",
  chip = false,
  showPlanUsage = false,
  usageLimitReached = false,
}: {
  coworker: Coworker;
  disabled?: boolean;
  modelEndpoints?: ModelEndpoint[];
  onChanged: () => Promise<void>;
  /** Where the picker popover opens relative to the trigger. */
  placement?: "down" | "up";
  /** Minimal pill trigger (model name + chevron) for tight spots like the composer. */
  chip?: boolean;
  /** Shows ChatGPT plan attribution and usage controls beside the composer picker. */
  showPlanUsage?: boolean;
  /** Keeps the usage remedy close to a request that hit the plan limit. */
  usageLimitReached?: boolean;
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
  const [chatGPTStatus, setChatGPTStatus] = useState<ChatGPTAuthStatus | null>(null);
  const activeChatGPTAccount = chatGPTStatus
    ? chatGPTStatus.accounts.find((account) => account.id === chatGPTStatus.activeAccountId)
    : undefined;
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
    setOpen(false);
    setQuery("");
  }, [coworker.modelName, coworker.modelProvider]);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let hasLoaded = false;
    setProvidersLoading(true);
    const candidates: RemoteModelProvider[] = [
      ...remoteModelProviderDefinitions
        .filter((definition) => definition.id !== "openai-compatible")
        .map((definition) => definition.id),
      ...modelEndpoints.map((endpoint) => endpoint.id),
    ];

    // Only a change to the selected auth mode/account should reload the OpenAI
    // model list. Other integration and task events just refresh status data.
    async function refreshProviderStatus() {
      const requestGeneration = ++generation;
      if (!hasLoaded) setProvidersLoading(true);
      try {
        const chatGPTStatusMethod = window.coworker.integrations.chatgptStatus;
        const chatGPTStatusPromise =
          typeof chatGPTStatusMethod === "function"
            ? chatGPTStatusMethod().catch(() => null)
            : Promise.resolve(null);
        const [statuses, authStatus] = await Promise.all([
          Promise.all(
            candidates.map(async (provider) => ({
              provider,
              configured: (
                await window.coworker.integrations.credentialStatus(
                  modelProviderCredentialKey(provider),
                )
              ).configured,
            })),
          ),
          chatGPTStatusPromise,
        ]);
        if (cancelled || requestGeneration !== generation) return;
        setChatGPTStatus(authStatus);
        const bridgeAvailable =
          typeof chatGPTStatusMethod === "function";
        // The saved key can remain present while subscription sign-in is active;
        // only the selected access method determines OpenAI's availability.
        const available = statuses
          .filter((status) => {
            if (status.provider !== "openai" || !bridgeAvailable) return status.configured;
            if (!authStatus) return false;
            return authStatus.mode === "chatgpt-subscription"
              ? isChatGPTPlanConnected(authStatus)
              : status.configured;
          })
          .map((status) => status.provider);
        setConfiguredProviders(available);
        setCatalogProvider((current) =>
          current && available.includes(current) ? current : (available[0] ?? ""),
        );
      } catch (loadError) {
        if (!cancelled && requestGeneration === generation) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled && requestGeneration === generation) {
          hasLoaded = true;
          setProvidersLoading(false);
        }
      }
    }

    void refreshProviderStatus();
    const unsubscribe =
      typeof window.coworker.events?.subscribe === "function"
        ? window.coworker.events.subscribe((event) => {
            if (event.type === "entity.changed" && event.entity === "integrations") {
              void refreshProviderStatus();
              return;
            }
            // Runtime errors can be the only signal that a token refresh
            // retired an account. Recheck auth metadata without polling models.
            if (
              event.type === "runtime.status" &&
              event.coworkerId === coworker.id &&
              event.status === "ERROR"
            ) {
              void refreshProviderStatus();
            }
          })
        : () => undefined;
    return () => {
      cancelled = true;
      generation += 1;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- endpoint list identity changes with each snapshot refresh
  }, [coworker.id, coworker.modelProvider, modelEndpoints.map((endpoint) => endpoint.id).join("|")]);

  useEffect(() => {
    let cancelled = false;
    const openAIStatusPending =
      catalogProvider === "openai" &&
      typeof window.coworker.integrations.chatgptStatus === "function" &&
      !chatGPTStatus;
    if (!catalogProvider || openAIStatusPending) {
      setModels([]);
      setLoading(openAIStatusPending);
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
  }, [
    catalogProvider,
    catalogProvider === "openai" ? chatGPTStatus?.mode : null,
    catalogProvider === "openai" ? chatGPTStatus?.activeAccountId : null,
    catalogProvider === "openai" ? chatGPTStatus?.state : null,
    catalogProvider === "openai" ? activeChatGPTAccount?.planUsageEnabled : null,
  ]);

  // Keep the selected option (and its pricing) in sync with whichever model
  // list is loaded, including after the coworker refreshes post-save.
  useEffect(() => {
    if (catalogProvider !== selectedProvider) return;
    setSelectedOption(models.find((model) => model.id === selectedModel) ?? null);
  }, [models, catalogProvider, selectedProvider, selectedModel]);

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

  const rootClassName = [
    "conversation-model-switcher",
    chip ? "chip-mode" : "",
    placement === "up" ? "up" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={rootClassName} ref={rootRef}>
      {chip && showPlanUsage ? (
        <ChatGPTPlanIndicator
          status={chatGPTStatus}
          usageLimitReached={usageLimitReached}
        />
      ) : null}
      <button
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Model used by ${coworker.name}`}
        className={chip ? "quick-model-trigger chip" : "quick-model-trigger"}
        disabled={disabled || providersLoading || saving || configuredProviders.length === 0}
        onClick={() => setOpen((current) => !current)}
        role="combobox"
        title={error ?? `Change ${coworker.name}'s model`}
        type="button"
      >
        <span>
          {saving && chip
            ? "Saving…"
            : selectedProvider
              ? (selectedOption?.name ?? selectedModel)
              : "Choose provider and model"}
        </span>
        {selectedProvider && !chip ? (
          <small>{modelProviderDisplayName(selectedProvider, modelEndpoints)}</small>
        ) : null}
        <b aria-hidden="true">⌄</b>
      </button>
      {open ? (
        <div className="quick-model-popover">
          <nav aria-label={`Model provider for ${coworker.name}`} className="quick-model-providers">
            {configuredProviders.map((provider) => (
              <button
                aria-pressed={provider === catalogProvider}
                className={provider === catalogProvider ? "selected" : ""}
                disabled={saving}
                key={provider}
                onClick={() => {
                  setCatalogProvider(provider);
                  setQuery("");
                }}
                type="button"
              >
                {modelProviderDisplayName(provider, modelEndpoints)}
              </button>
            ))}
          </nav>
          <div className="quick-model-catalog">
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
        </div>
      ) : null}
      {chip && !error ? null : (
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
                    ? selectedPricing
                    : "No configured provider"}
        </small>
      )}
    </span>
  );
}
