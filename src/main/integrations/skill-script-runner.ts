import { readFile, lstat, readdir, writeFile, link, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, extname, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scriptRequestSchema, type ScriptRequest, type FileRef } from '@shared/files';
import type { CoworkerDatabase } from '@main/db/database';
import { resolveFile } from '@main/tools/file-access';
import { declaredWorkspaceContextFile } from '@shared/workspace-context';

const maxBytes = 100 * 1024 * 1024;
const outputSchema = z.object({ files: z.array(z.object({ name: z.string().min(1).max(240), mimeType: z.string().min(1).max(200), data: z.string().max(Math.ceil(maxBytes * 4 / 3) + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) })).min(1).max(20) });
export interface ScriptInputFile { name: string; data: string; directory?: boolean }
export type ScriptOutputFile = z.infer<typeof outputSchema>['files'][number];
export async function executeSandboxedScript(source: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const { BrowserWindow } = await import('electron');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, partition: `skill-${randomUUID()}` } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  let monitor: ReturnType<typeof setInterval> | undefined;
  let abort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const library = await readFile(createRequire(import.meta.url).resolve('jszip/dist/jszip.min.js'), 'utf8');
    const code = library + '\n' + source + '\nself.onmessage = async e => { try { self.postMessage({ result: await run(e.data, { JSZip: self.JSZip }) }); } catch(e) { self.postMessage({ error: String(e.message || e) }); } };';
    await window.loadURL('data:text/html,' + encodeURIComponent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'">`));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('blob:') }));
    return await Promise.race([
      window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(code)}], {type:'text/javascript'}))); worker.onmessage = e => { worker.terminate(); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result); }; worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); }; worker.postMessage(${JSON.stringify(input)}); })`),
      new Promise((_, reject) => {
        abort = () => reject(new Error('Skill execution cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        monitor = setInterval(() => {
          const pid = window.webContents.getOSProcessId();
          void import('electron').then(({app}) => { const memory = app.getAppMetrics().find(metric => metric.pid === pid)?.memory.workingSetSize ?? 0; if (memory > 512 * 1024) reject(new Error('Skill exceeded its 512 MB memory limit')); });
        }, 250);
        timer = setTimeout(() => reject(new Error('Skill script exceeded its 60 second time limit')), 60_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); if (monitor) clearInterval(monitor); if (abort) signal?.removeEventListener("abort", abort); if (!window.isDestroyed()) window.destroy(); }
}

export async function runSkillScript(database: CoworkerDatabase, dataPath: string, coworkerId: string, request: ScriptRequest, taskId: string | null = null,
  execute = executeSandboxedScript, exportOutput?: (files: ScriptOutputFile[]) => Promise<void>) {
  const args = scriptRequestSchema.parse(request);
  if (args.script.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error('Script must be inside the skill package');
  const coworker = database.getCoworker(coworkerId);
  const skill = database.listCoworkerSkills(coworkerId).find(s => s.name === args.skill);
  if (!skill) throw new Error(`Skill ${args.skill} is not enabled for this coworker`);
  const resource = database.getSkillResource(skill.id, args.script);
  if (!resource) throw new Error(`Packaged script ${args.script} was not found`);
  if (resource.content.byteLength > 1_000_000) throw new Error('Script exceeds 1 MB');
  const check = () => {
    if (taskId && database.getTask(taskId).status !== 'RUNNING') throw new Error('Skill task was cancelled or is no longer running');
    if (!database.listCoworkerSkills(coworkerId).some(s => s.id === skill.id)) throw new Error('Skill access was revoked');
    return database.getCoworker(coworkerId);
  };
  const target = exportOutput ? null : await resolveFile(check(), args.destination, dataPath, true);
  if (!exportOutput && args.destination.root === 'workspace' && declaredWorkspaceContextFile(args.destination.path)) throw new Error('Skill scripts cannot replace managed context files');
  const inputs: ScriptInputFile[] = []; const seen = new Set<string>(); let bytes = 0;
  async function visit(ref: FileRef, name: string): Promise<void> {
    check();
    const path = await resolveFile(check(), ref, dataPath);
    const root = ref.root === 'workspace' ? coworker.workspacePath : coworker.sharedFolders.find(f => f.id === ref.root || f.alias === ref.root)?.path;
    if (!root) throw new Error('Unknown input root');
    // Check lexical entries before resolving: archive operations never follow links.
    let lexical = root;
    for (const segment of ref.path.split('/').filter(p => p && p !== '.')) {
      lexical = join(lexical, segment);
      if ((await lstat(lexical)).isSymbolicLink()) throw new Error(`Symbolic links cannot be archived: ${name}`);
    }
    if (path === target || seen.has(path)) return;
    seen.add(path);
    if (seen.size > 10000) throw new Error('Selection exceeds 10,000 entries');
    const info = await lstat(path);
    if (info.isDirectory()) {
      inputs.push({ name, data: '', directory: true });
      for (const child of (await readdir(path)).sort()) await visit({ ...ref, path: posix.join(ref.path, child) }, posix.join(name, child));
    } else {
      if (!info.isFile()) throw new Error(`Not a regular file: ${name}`);
      bytes += info.size; if (bytes > maxBytes) throw new Error('Selection exceeds 100 MB');
      inputs.push({ name, data: (await readFile(path)).toString('base64') });
    }
  }
  const audit = (type: string, summary: string) => database.addActivity({ coworkerId, taskId, type, summary });
  audit('skill.script.started', `${skill.name}/${args.script}`);
  try {
    const sorted = [...args.inputs].sort((a,b) => a.path.length - b.path.length);
    const multipleRoots = new Set(sorted.map(ref => ref.root)).size > 1;
    for (const ref of sorted) await visit(ref, (multipleRoots ? ref.root + '/' : '') + (ref.path === '.' ? 'files' : ref.path));
    const controller = new AbortController();
    const cancellation = setInterval(() => { try { check(); } catch { controller.abort(); } }, 250);
    let result: z.infer<typeof outputSchema>;
    try { result = outputSchema.parse(await execute(Buffer.from(resource.content).toString('utf8'), { inputs, options: args.options }, controller.signal)); }
    finally { clearInterval(cancellation); }
    if (result.files.reduce((n,f) => n + Buffer.byteLength(f.data, 'base64'), 0) > maxBytes) throw new Error('Script output exceeds 100 MB');
    for (const file of result.files) {
      if (basename(file.name) !== file.name || /[\\/\0]/.test(file.name)) throw new Error('Script output names must be filenames');
    }
    if (exportOutput) {
      check();
      for (const ref of args.inputs) await resolveFile(check(), ref, dataPath);
      await exportOutput(result.files);
      audit('skill.script.completed', `${skill.name}: exported ${result.files.map(file => file.name).join(', ')}`);
      return { artifacts: [] };
    }
    const artifacts = [];
    for (const file of result.files) {
      if (basename(file.name) !== file.name || /[\\/\0]/.test(file.name)) throw new Error('Script output names must be filenames');
      const requested = result.files.length === 1 ? args.destination.path : posix.join(args.destination.path, file.name);
      const extension = extname(requested); let saved = '';
      for (let suffix = 0; suffix < 1000; suffix++) {
        const candidate = suffix ? requested.slice(0, requested.length - extension.length) + ` (${suffix})` + extension : requested;
        const path = await resolveFile(check(), { root: args.destination.root, path: candidate }, dataPath, true);
        if (args.destination.root === 'workspace' && declaredWorkspaceContextFile(candidate)) throw new Error('Managed context output is forbidden');
        const temporary = join(dirname(path), `.coworker-${randomUUID()}.tmp`);
        await writeFile(temporary, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o600 });
        try { await resolveFile(check(), { root: args.destination.root, path: candidate }, dataPath, true); await link(temporary, path); saved = path; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        finally { await unlink(temporary); }
        if (saved) break;
      }
      if (!saved) throw new Error('Could not select an unused output filename');
      artifacts.push(database.createArtifact({ coworkerId, taskId, name: basename(saved), mimeType: file.mimeType, filePath: saved }));
    }
    audit('skill.script.completed', `${skill.name}: ${artifacts.map(a => a.name).join(', ')}`);
    return { artifacts };
  } catch (error) { audit('skill.script.failed', `${skill.name}: ${error instanceof Error ? error.message : String(error)}`); throw error; }
}
