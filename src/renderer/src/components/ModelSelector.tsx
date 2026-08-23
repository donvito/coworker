import { useEffect, useState } from "react";
import type { ModelOption, ModelProvider } from "@shared/contracts";

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setModels([]);

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
  const placeholder = loading
    ? "Loading models…"
    : error
      ? "Models unavailable"
      : "No compatible models";

  return (
    <label className="model-selector">
      <span>Model</span>
      <div className="model-selector-control">
        <select
          aria-busy={loading}
          disabled={disabled || loading}
          name="modelName"
          onChange={(event) => onChange(event.target.value)}
          required
          value={value}
        >
          {!value ? (
            <option value="">{placeholder}</option>
          ) : !includesValue ? (
            <option value={value}>
              {value} {loading ? "(checking availability…)" : "(last selected)"}
            </option>
          ) : null}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {`${model.name === model.id ? model.id : `${model.name} — ${model.id}`}${
                model.supportsImages ? " · image input" : ""
              }`}
            </option>
          ))}
        </select>
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
            : `${models.length} compatible model${models.length === 1 ? "" : "s"} available`)}
      </small>
    </label>
  );
}
