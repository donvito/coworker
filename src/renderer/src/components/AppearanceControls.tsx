import {
  colorModeOptions,
  themeOptions,
  type AppearancePatch,
  type AppearanceSettings,
} from "../lib/appearance-options";
import { Icon } from "./Icon";

export function AppearanceControls({
  settings,
  disabled = false,
  onChange,
  compact = false,
}: {
  settings: AppearanceSettings;
  disabled?: boolean;
  onChange: (patch: AppearancePatch) => void;
  compact?: boolean;
}) {
  const controls = (
    <>
      <div className="theme-settings">
        {!compact && <span className="eyebrow">Appearance</span>}
        <h2>Color mode</h2>
        {!compact && <p>Use any color theme in light or dark mode. Changes apply immediately.</p>}
        <div className="color-mode-picker" role="group" aria-label="Color mode">
          {colorModeOptions.map((option) => (
            <button
              aria-pressed={settings.colorMode === option.id}
              className="color-mode-option"
              disabled={disabled}
              key={option.id}
              onClick={() => onChange({ colorMode: option.id })}
              type="button"
            >
              <Icon name={option.icon} />
              <span>
                <strong>{option.label}</strong>
                {!compact && <small>{option.description}</small>}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="theme-settings">
        <h2>Color theme</h2>
        {!compact && <p>Choose the colors for your workspace.</p>}
        <div className="theme-picker" role="group" aria-label="Color theme">
          {themeOptions.map((option) => (
            <button
              aria-pressed={settings.theme === option.id}
              className="theme-option"
              data-theme={option.id}
              disabled={disabled}
              key={option.id}
              onClick={() => onChange({ theme: option.id })}
              type="button"
            >
              <span className="theme-option-swatch" aria-hidden="true" />
              <span>
                <strong>{option.label}</strong>
                {!compact && <small>{option.description}</small>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );

  return compact ? <div className="appearance-controls-compact">{controls}</div> : controls;
}
