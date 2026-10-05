import { useEffect, useRef, useState } from "react";
import type { Coworker, Skill, UpdateCoworkerInput } from "@shared/contracts";
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
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [pendingAccess, setPendingAccess] = useState<"read" | "read-write">("read");
  const [pendingOutput, setPendingOutput] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const folderPaths = coworker.sharedFolders.map((folder) => folder.path);
  const grants = coworker.sharedFolders.map(folder => ({
    path: folder.path,
    access: folder.access ?? "read",
    defaultOutput: folder.defaultOutput ?? false,
  }));
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

  async function save(patch: UpdateCoworkerInput) {
    setWorking(true);
    setError(null);
    try {
      await window.coworker.coworkers.update(coworker.id, patch);
      await onChanged();
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function addFolders() {
    setWorking(true);
    setError(null);
    try {
      const picked = await window.coworker.folders.pick();
      if (picked.length === 0) return;
      setPendingPaths([...new Set(picked)].filter(path => !folderPaths.includes(path)));
      setPendingAccess("read");
      setPendingOutput(false);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : String(pickError));
    } finally {
      setWorking(false);
    }
  }

  async function grantFolders() {
    const useOutput = pendingAccess === "read-write" && pendingOutput && pendingPaths.length === 1;
    if (await save({ sharedFolderGrants: [
      ...grants.map(folder => ({ ...folder, defaultOutput: useOutput ? false : folder.defaultOutput })),
      ...pendingPaths.map(path => ({ path, access: pendingAccess, defaultOutput: useOutput })),
    ] })) setPendingPaths([]);
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
          <div className={`composer-tool-popover composer-folder-popover${pendingPaths.length > 0 ? " has-pending-folder" : ""}`} role="dialog" aria-label="Folder access">
            {pendingPaths.length === 0 ? <header><strong>Folder access</strong></header> : null}
            {pendingPaths.length > 0 ? null : folderPaths.length === 0 ? (
              <p className="composer-tool-empty">No folders yet.</p>
            ) : (
              <ul className="composer-tool-list">
                {coworker.sharedFolders.map((folder) => (
                  <li key={folder.path} className="composer-folder-row">
                    <Icon name="folder" />
                    <span>
                      <strong>{folder.alias ?? folderDisplayName(folder.path)}</strong>
                      <small title={folder.path}>{folder.path}</small>
                      <span className="composer-folder-access-options composer-folder-saved-access" role="radiogroup" aria-label={`Access for ${folder.path}`}>
                        {(["read", "read-write"] as const).map(access => <label key={access} className={(folder.access ?? "read") === access ? "selected" : ""}>
                          <input type="radio" name={`folder-access-${folder.path}`} checked={(folder.access ?? "read") === access} disabled={working}
                            onChange={() => void save({ sharedFolderGrants: grants.map(grant => grant.path === folder.path
                              ? { ...grant, access, defaultOutput: access === "read-write" && grant.defaultOutput }
                              : grant) })} />
                          <span><strong>{access === "read" ? "Read-only" : "Read and write"}</strong></span>
                        </label>)}
                      </span>
                      {folder.access === "read-write" ? <label className="composer-folder-option">
                        <input type="checkbox" checked={folder.defaultOutput ?? false} disabled={working}
                          aria-label={`Use ${folder.path} for output`}
                          onChange={event => void save({ sharedFolderGrants: grants.map(grant => ({ ...grant,
                            defaultOutput: event.target.checked ? grant.path === folder.path : false,
                          })) })} />
                        Default output folder
                      </label> : null}
                    </span>
                    <button
                      aria-label={`Remove folder ${folder.path}`}
                      className="composer-tool-remove"
                      disabled={working}
                      onClick={() =>
                        void save({
                          sharedFolderGrants: grants.filter(grant => grant.path !== folder.path),
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
            {pendingPaths.length > 0 ? <div className="composer-folder-pending">
              <div className="composer-folder-heading">
              <strong>Add folder</strong>
              <div className="composer-folder-selection">
                {pendingPaths.map(path => <div className="composer-folder-identity" key={path}>
                  <Icon name="folder" />
                  <span><strong>{folderDisplayName(path)}</strong><small title={path}>{path}</small></span>
                </div>)}
              </div>
              </div>
              <div className="composer-folder-access-options" role="radiogroup" aria-label="Access for selected folders">
                {(["read", "read-write"] as const).map(access => <label key={access} className={pendingAccess === access ? "selected" : ""}>
                  <input type="radio" name="new-folder-access" value={access} checked={pendingAccess === access} disabled={working}
                    onChange={() => { setPendingAccess(access); setPendingOutput(false); }} />
                  <span><strong>{access === "read" ? "Read-only" : "Read and write"}</strong></span>
                </label>)}
              </div>
              <div className="composer-folder-footer">
              {pendingAccess === "read-write" && pendingPaths.length === 1 ? <label className="composer-folder-option composer-folder-output">
                <input type="checkbox" aria-label="Default output folder" checked={pendingOutput} disabled={working} onChange={event => setPendingOutput(event.target.checked)} />
                Save new files here
              </label> : null}
                <button className="composer-folder-cancel" disabled={working} onClick={() => setPendingPaths([])} type="button">Cancel</button>
                <button className="primary-button" disabled={working} onClick={() => void grantFolders()} type="button">{working ? "Adding…" : "Grant access"}</button>
              </div>
            </div> : <button
              className="composer-tool-action"
              disabled={working}
              onClick={() => void addFolders()}
              type="button"
            >
              <Icon name="plus" />
              Add folder…
            </button>}
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
