import { useEffect, useRef, useState } from "react";
import type { Coworker, Skill } from "@shared/contracts";
import { Icon } from "./Icon";

function folderDisplayName(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments.at(-1) || path;
}

/**
 * Folder access and skill toggles sit under the composer, where the work is
 * described, so granting a folder or enabling a skill does not mean leaving
 * the conversation for the settings modal.
 */
export function ComposerTools({
  coworker,
  disabled = false,
  onChanged,
  skills,
}: {
  coworker: Coworker;
  disabled?: boolean;
  onChanged: () => Promise<void>;
  skills: Skill[];
}) {
  const [open, setOpen] = useState<"folders" | "skills" | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const folderPaths = coworker.sharedFolders.map((folder) => folder.path);
  const enabledSkills = skills.filter((skill) =>
    coworker.enabledSkillIds.includes(skill.id),
  );

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(null);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function save(patch: { sharedFolderPaths?: string[]; enabledSkillIds?: string[] }) {
    setWorking(true);
    setError(null);
    try {
      await window.coworker.coworkers.update(coworker.id, patch);
      await onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setWorking(false);
    }
  }

  async function addFolders() {
    setError(null);
    try {
      const picked = await window.coworker.folders.pick();
      if (picked.length === 0) return;
      await save({ sharedFolderPaths: [...new Set([...folderPaths, ...picked])] });
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : String(pickError));
    }
  }

  async function toggleSkill(skill: Skill, enabled: boolean) {
    await save({
      enabledSkillIds: enabled
        ? [...coworker.enabledSkillIds, skill.id]
        : coworker.enabledSkillIds.filter((id) => id !== skill.id),
    });
  }

  const folderLabel =
    folderPaths.length === 0
      ? "Choose folder"
      : folderPaths.length === 1
        ? folderDisplayName(folderPaths[0] ?? "")
        : `${folderPaths.length} folders`;
  const skillLabel =
    enabledSkills.length === 0
      ? "Skills"
      : enabledSkills.length === 1
        ? (enabledSkills[0]?.name ?? "1 skill")
        : `${enabledSkills.length} skills`;

  return (
    <div className="composer-tools" ref={rootRef}>
      <div className="composer-tool">
        <button
          aria-expanded={open === "folders"}
          aria-haspopup="dialog"
          className={open === "folders" ? "composer-tool-trigger active" : "composer-tool-trigger"}
          disabled={disabled}
          onClick={() => setOpen((current) => (current === "folders" ? null : "folders"))}
          type="button"
        >
          <Icon name="folder" />
          <span>{folderLabel}</span>
        </button>
        {open === "folders" ? (
          <div className="composer-tool-popover" role="dialog" aria-label="Folder access">
            <header>
              <strong>Folder access</strong>
              <small>Read-only — nothing in them can be changed.</small>
            </header>
            {folderPaths.length === 0 ? (
              <p className="composer-tool-empty">No folders yet.</p>
            ) : (
              <ul className="composer-tool-list">
                {coworker.sharedFolders.map((folder) => (
                  <li key={folder.path}>
                    <Icon name="folder" />
                    <span>
                      <strong>{folder.alias ?? folderDisplayName(folder.path)}</strong>
                      <small title={folder.path}>{folder.path}</small>
                    </span>
                    <button
                      aria-label={`Remove folder ${folder.path}`}
                      className="composer-tool-remove"
                      disabled={working}
                      onClick={() =>
                        void save({
                          sharedFolderPaths: folderPaths.filter(
                            (path) => path !== folder.path,
                          ),
                        })
                      }
                      type="button"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              className="composer-tool-action"
              disabled={working}
              onClick={() => void addFolders()}
              type="button"
            >
              <Icon name="plus" />
              Add folder…
            </button>
            {error ? <p className="composer-tool-error">{error}</p> : null}
          </div>
        ) : null}
      </div>

      <div className="composer-tool">
        <button
          aria-expanded={open === "skills"}
          aria-haspopup="dialog"
          className={open === "skills" ? "composer-tool-trigger active" : "composer-tool-trigger"}
          disabled={disabled}
          onClick={() => setOpen((current) => (current === "skills" ? null : "skills"))}
          type="button"
        >
          <Icon name="tool" />
          <span>{skillLabel}</span>
        </button>
        {open === "skills" ? (
          <div className="composer-tool-popover" role="dialog" aria-label="Skills">
            <header>
              <strong>Skills</strong>
              <small>Installed skills are global; choose which ones {coworker.name} can use.</small>
            </header>
            {skills.length === 0 ? (
              <p className="composer-tool-empty">
                No skills installed yet. Add them in Settings → Skills.
              </p>
            ) : (
              <ul className="composer-tool-list composer-skill-list">
                {skills.map((skill) => {
                  const enabled = coworker.enabledSkillIds.includes(skill.id);
                  return (
                    <li key={skill.id}>
                      <strong title={skill.description}>{skill.name}</strong>
                      <label className="toggle">
                        <input
                          aria-label={`${enabled ? "Disable" : "Enable"} ${skill.name}`}
                          checked={enabled}
                          disabled={working}
                          onChange={(event) => void toggleSkill(skill, event.target.checked)}
                          type="checkbox"
                        />
                        <span />
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {error ? <p className="composer-tool-error">{error}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
