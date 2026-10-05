import type { Coworker } from "@shared/contracts";
import { useId, useState } from "react";
import { Icon } from "./Icon";

export function CoworkerFolderAccess({ coworker, onOpen }: {
  coworker: Coworker;
  onOpen: (root: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  const folders = [
    { id: "workspace", path: coworker.workspacePath, alias: "Workspace", access: "read-write", defaultOutput: !coworker.sharedFolders.some(folder => folder.defaultOutput) },
    ...coworker.sharedFolders,
  ];
  return (
    <section className="conversation-folder-access" aria-label="Accessible folders">
      <h3>
        <button type="button" className="conversation-folder-toggle" aria-expanded={expanded}
          aria-controls={listId} onClick={() => setExpanded(value => !value)}>
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          Folders
        </button>
      </h3>
      <div id={listId} hidden={!expanded}>
      {folders.map(folder => (
        <button className="conversation-folder-row" type="button" key={folder.path}
          onClick={() => onOpen(folder.id ?? folder.path)} title={folder.path}
          aria-label={`Browse ${folder.alias}`}>
          <Icon name="folder" />
          <span>
            <strong>{folder.alias}</strong>
            <small className="conversation-folder-path">{folder.path}</small>
            <small className="conversation-folder-permissions">
              {folder.access === "read-write" ? "Read and write" : "Read-only"}
              {folder.defaultOutput && <span>Default output</span>}
            </small>
          </span>
        </button>
      ))}
      </div>
    </section>
  );
}
