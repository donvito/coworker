import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join, relative, normalize, sep } from "node:path";
import { applyWorkspaceTextEdit, workspaceContextFiles, type WorkspaceTextDocument, type WorkspaceTextEdit } from "@shared/workspace-context";
import { resolveWorkspacePath } from "./workspace-path";

const writes = new Map<string, Promise<unknown>>();
const maxTextCharacters = 5_000_000;

function contextFile(path: string) {
  const normalized = normalize(path).split(sep).join("/").toLowerCase();
  return workspaceContextFiles.find((file) => file.path.toLowerCase() === normalized);
}

async function target(workspace: string, requestedPath: string, writing: boolean) {
  const declared = contextFile(requestedPath);
  let path = await resolveWorkspacePath(workspace, requestedPath, {
    createParent: writing || Boolean(declared),
  });
  // Validate the original request first, then give reserved context names a
  // single spelling and lock identity, including before the file exists.
  if (declared) {
    path = await resolveWorkspacePath(workspace, declared.path, { createParent: true });
  }
  const root = await resolveWorkspacePath(workspace, ".");
  let managed = declared ?? contextFile(relative(root, path));
  if (!managed) {
    // A context file may itself point to another confined workspace file.
    // Protect writes through that target name as well as links to the context.
    for (const context of workspaceContextFiles) {
      const contextPath = await resolveWorkspacePath(workspace, context.path, { createParent: true });
      if (contextPath === path) { managed = context; break; }
    }
  }
  return { path, relativePath: managed?.path ?? relative(root, path).split(sep).join("/"), managed, maxCharacters: managed?.maxCharacters ?? maxTextCharacters };
}

/** Generated documents and downloads cannot replace managed context files. */
export async function resolveWorkspaceOutputPath(workspace: string, requestedPath: string): Promise<string> {
  const file = await target(workspace, requestedPath, true);
  if (file.managed) throw new Error("Use a reviewed text change to update saved context files.");
  return file.path;
}

type TextMutation = { path: string; content: string; expectedRevision?: string } | WorkspaceTextEdit;
/** Omitted only for direct user-operated editors. Tools must supply the approved target or null. */
interface TextWriteAuthorization { approvedContextPath: string | null }

function validateText(content: string, maxCharacters: number): void {
  if (content.length > maxCharacters) throw new Error(`File must be at most ${maxCharacters} characters`);
  if (Buffer.from(content, "utf8").toString("utf8") !== content || content.includes("\0")) throw new Error("File must contain valid Unicode text without NUL characters");
}

async function mutationContent(file: Awaited<ReturnType<typeof target>>, mutation: TextMutation): Promise<string> {
  if ((file.managed || "oldText" in mutation) && mutation.expectedRevision === undefined) throw new Error("Read the file first and supply its revision as expectedRevision");
  if (mutation.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(mutation.expectedRevision)) throw new Error("Invalid expectedRevision; use the revision returned by files.read");
  let current = "";
  if (mutation.expectedRevision !== undefined) {
    current = await readText(file.path, file.maxCharacters, true);
    if (revision(current) !== mutation.expectedRevision) throw new Error("File changed since it was read. Reload it and reapply your changes.");
  }
  const content = "content" in mutation ? mutation.content : applyWorkspaceTextEdit(current, mutation.oldText, mutation.newText);
  validateText(content, file.maxCharacters);
  return content;
}

/** Validate a proposal without saving it, and freeze its confined, canonical target. */
export async function prepareWorkspaceTextMutation(workspace: string, mutation: TextMutation) {
  const file = await target(workspace, mutation.path, true);
  await mutationContent(file, mutation);
  return { path: file.relativePath, requiresApproval: file.managed?.requireApproval === true };
}

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readText(path: string, maxCharacters: number, allowMissing: boolean): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Expected a regular workspace text file");
    if (info.size > maxCharacters * 4) {
      throw new Error(`File exceeds ${maxCharacters} characters; shorten it before loading`);
    }
    // Bound the read even if an external editor grows the file after stat().
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxCharacters * 4 + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error("File changed while reading; reload and try again");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error("Workspace text files must contain valid UTF-8");
    }
    if (content.length > maxCharacters) throw new Error(`File exceeds ${maxCharacters} characters; shorten it before loading`);
    if (content.includes("\0")) throw new Error("Workspace text files cannot contain NUL characters");
    return content;
  } finally {
    await file.close();
  }
}

export async function readWorkspaceText(workspace: string, requestedPath: string): Promise<WorkspaceTextDocument> {
  const file = await target(workspace, requestedPath, false);
  const content = await readText(file.path, file.maxCharacters, Boolean(file.managed));
  return { path: requestedPath, content, revision: revision(content) };
}

export async function writeWorkspaceText(
  workspace: string,
  requestedPath: string,
  content: string,
  expectedRevision?: string,
  authorization?: TextWriteAuthorization,
): Promise<WorkspaceTextDocument & { filePath: string; managed: boolean }> {
  return mutateWorkspaceText(workspace, { path: requestedPath, content, expectedRevision }, authorization);
}

export async function editWorkspaceText(workspace: string, edit: WorkspaceTextEdit, authorization?: TextWriteAuthorization) {
  return mutateWorkspaceText(workspace, edit, authorization);
}

async function mutateWorkspaceText(workspace: string, mutation: TextMutation, authorization?: TextWriteAuthorization): Promise<WorkspaceTextDocument & { filePath: string; managed: boolean }> {
  const file = await target(workspace, mutation.path, true);
  if (authorization && file.managed?.requireApproval && authorization.approvedContextPath !== file.managed.path) {
    throw new Error("This context file requires approval before a tool can change it.");
  }

  const previous = writes.get(file.path) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const content = await mutationContent(file, mutation);
    const temporary = join(dirname(file.path), `.coworker-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, file.path);
    } finally { await rm(temporary, { force: true }); }
    return { path: mutation.path, content, revision: revision(content), filePath: file.path, managed: Boolean(file.managed) };
  });
  writes.set(file.path, pending);
  try { return await pending; }
  finally { if (writes.get(file.path) === pending) writes.delete(file.path); }
}

export async function loadWorkspaceContext(workspace: string): Promise<WorkspaceTextDocument[]> {
  return Promise.all(workspaceContextFiles.map(async ({ path }) => {
    try { return await readWorkspaceText(workspace, path); }
    catch (error) { throw new Error(`Could not load ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }));
}
