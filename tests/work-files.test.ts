import { deleteWorkFiles } from '@main/integrations/delete-work-files';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat, rename, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { CoworkerDatabase } from '@main/db/database';
import { ToolGateway } from '@main/tools/tool-gateway';
import { bundledSkills } from '@main/integrations/skills';
import { runSkillScript } from '@main/integrations/skill-script-runner';
import { createDocument } from '@main/integrations/documents';
import { fileRoots, listFiles, previewFile, resolveFile } from '@main/tools/file-access';
import { resolveSharedFolderGrants } from '@main/tools/shared-folders';
import { writeGrantedText } from '@main/tools/file-output';
import { deleteArtifactFile, resolveArtifactFile } from '@main/integrations/artifact-files';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'coworker-work-files-'));
  const data = join(root, 'data'); const workspace = join(data, 'workspaces', 'test');
  const input = join(root, 'input'); const output = join(root, 'output');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(input), mkdir(output)]);
  const db = new CoworkerDatabase(join(data, 'test.db'));
  cleanups.push(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  for (const skill of bundledSkills) { db.upsertSkill(skill); db.replaceSkillResources(skill.id, 'resources' in skill ? skill.resources : []); }
  const folders = await resolveSharedFolderGrants([{ path: input, access: 'read' }, { path: output, access: 'read-write', defaultOutput: true }], { dataPath: data });
  const owner = db.createCoworker({ name: 'Files', role: 'Test', systemPrompt: 'Test', modelProvider: 'demo', modelName: 'faux-1', enabledTools: [], enabledSkillIds: bundledSkills.map(s => s.id), sharedFolders: folders }, workspace);
  return { root, data, workspace, input, output, db, owner, read: folders[0]!.id!, write: folders[1]!.id! };
}
// Scripts are trusted fixtures here; production execution uses a sandboxed Electron worker.
const execute = async (source: string, input: unknown) => new Function(`${source}; return run;`)()(input, { JSZip });
it('defaults document and invoice exports to the configured output folder while honoring explicit roots', async () => {
  const f = await fixture();
  const owner = f.db.updateCoworker(f.owner.id, { enabledTools: ['documents.export', 'invoice.create'] });
  const task = f.db.createTask({ coworkerId: owner.id, title: 'Output destinations', input: 'Create a PDF.' });
  const gateway = new ToolGateway(f.db, { async set() {}, async get() { return null; }, async has() { return false; }, async delete() {} }, join(f.data, 'outbox'), {}, { dataPath: f.data });
  let call = 0;
  const request = (toolName: string, args: unknown) => gateway.request({ task, coworker: f.db.getCoworker(owner.id), toolCallId: `output-${++call}`, toolName, arguments: args });
  const pdf = { name: 'poem', content: '# A small light\n\nA short poem.', formats: ['pdf'] };
  const result = await request('documents.export', pdf);
  expect(result.kind).toBe('completed');
  expect((await readFile(join(f.output, 'poem.pdf'))).subarray(0, 5).toString()).toBe('%PDF-');
  await expect(stat(join(f.workspace, 'poem.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.db.listArtifacts()[0]!.filePath).toBe(join(await realpath(f.output), 'poem.pdf'));
  expect(result).toMatchObject({ kind: 'completed', result: { files: [{ path: join(await realpath(f.output), 'poem.pdf') }] } });
  await request('documents.export', { ...pdf, root: 'workspace' });
  expect((await stat(join(f.workspace, 'poem.pdf'))).isFile()).toBe(true);
  await writeFile(join(f.workspace, 'source.md'), '# Source\n\nFrom the workspace.');
  await request('documents.export', { sourcePath: 'source.md', formats: ['pdf'] });
  expect((await stat(join(f.output, 'source.pdf'))).isFile()).toBe(true);
  const invoice = await request('invoice.create', { client: 'Acme', lineItems: [{ description: 'Services', quantity: 1, rate: 10 }], format: 'pdf' });
  expect(invoice.kind).toBe('completed');
  const savedInvoice = f.db.listArtifacts().find(a => a.name.startsWith('INV-'))!;
  expect(dirname(savedInvoice.filePath)).toBe(join(await realpath(f.output), 'invoices'));
  expect((await readFile(savedInvoice.filePath)).subarray(0, 5).toString()).toBe('%PDF-');
  await expect(request('documents.export', { ...pdf, root: f.read })).rejects.toThrow('read-only');
  // An unavailable configured folder must fail, never silently fall back to Workspace.
  await rename(f.output, join(f.root, 'unavailable-output'));
  await expect(request('documents.export', { ...pdf, name: 'unavailable' })).rejects.toThrow('no longer available');
  await expect(stat(join(f.workspace, 'unavailable.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('seeds packaged scripts and creates an archive of nested binary files and empty folders', async () => {
  const f = await fixture();
  await mkdir(join(f.input, 'reports', 'empty'), { recursive: true });
  await writeFile(join(f.input, 'reports', 'résumé.bin'), Buffer.from([0,1,2,255]));
  const result = await runSkillScript(f.db, f.data, f.owner.id, { skill: 'file-archiving', script: 'scripts/zip.js', inputs: [{root:f.read,path:'reports'}, {root:f.read,path:'reports/résumé.bin'}], destination: {root:f.write,path:'bundle.zip'} }, null, execute);
  const artifact = result.artifacts[0]!;
  const zip = await JSZip.loadAsync(await readFile(artifact.filePath));
  expect(Object.keys(zip.files)).toEqual(['reports/', 'reports/empty/', 'reports/résumé.bin']);
  expect(await zip.file('reports/résumé.bin')!.async('uint8array')).toEqual(new Uint8Array([0,1,2,255]));
  expect((await resolveArtifactFile(f.db, artifact.id)).path).toBe(artifact.filePath);
  await deleteArtifactFile(f.db, artifact.id);
  expect((await stat(artifact.filePath)).isFile()).toBe(true);
  expect(f.db.listActivity(20).some(a => a.type === 'skill.script.completed')).toBe(true);
});
it('enforces read grants, traversal, symlinks, default output and revocation before publishing', async () => {
  const f = await fixture();
  expect(fileRoots(f.owner).find(r => r.defaultOutput)?.id).toBe(f.write);
  await expect(resolveFile(f.owner, {root:f.read,path:'x'}, f.data, true)).rejects.toThrow('read-only');
  await expect(resolveFile(f.owner, {root:f.write,path:'../x'}, f.data, true)).rejects.toThrow('traversal');
  await symlink(f.input, join(f.output, 'escape'));
  await expect(resolveFile(f.owner, {root:f.write,path:'escape/x'}, f.data, true)).rejects.toThrow();
  await writeFile(join(f.input, 'test.txt'), 'hello');
  await expect(runSkillScript(f.db, f.data, f.owner.id, {skill:'file-archiving',script:'scripts/zip.js',inputs:[{root:f.read,path:'test.txt'}],destination:{root:f.write,path:'test.zip'}}, null, async (source,input) => {
    f.db.updateCoworker(f.owner.id, {sharedFolders: f.owner.sharedFolders.map(folder => ({...folder,access:'read',defaultOutput:false}))});
    return execute(source,input);
  })).rejects.toThrow('read-only');
  expect(f.db.listArtifacts()).toHaveLength(0);
  expect(f.db.listActivity(20).some(a => a.type === 'skill.script.failed')).toBe(true);
});
it('does not overwrite new output and supports revision-checked explicit edits', async () => {
  const f = await fixture(); const ref = {root:f.write,path:'notes.txt'};
  const first = await writeGrantedText(f.owner, ref, f.data, 'original long text');
  const second = await writeGrantedText(f.owner, ref, f.data, 'second');
  expect(second.filePath).not.toBe(first.filePath);
  await writeGrantedText(f.owner, ref, f.data, 'short', first.revision);
  expect(await readFile(first.filePath,'utf8')).toBe('short');
  await expect(writeGrantedText(f.owner, ref, f.data, 'stale', first.revision)).rejects.toThrow('changed');
  expect((await listFiles(f.owner, {root:f.write,path:'.'}, f.data)).map(e => e.name)).toContain('notes.txt');
  expect((await previewFile(f.owner, ref, f.data)).content).toBe('short');
});
it('rejects scripts outside their package and archive symlinks', async () => {
  const f = await fixture();
  await writeFile(join(f.input,'file.txt'),'x'); await symlink(join(f.input,'file.txt'),join(f.input,'link'));
  const request = {skill:'file-archiving',script:'scripts/zip.js',inputs:[{root:f.read,path:'link'}],destination:{root:f.write,path:'out.zip'}};
  await expect(runSkillScript(f.db,f.data,f.owner.id,request,null,execute)).rejects.toThrow('Symbolic links');
  await expect(runSkillScript(f.db,f.data,f.owner.id,{...request,script:'scripts/../zip.js'},null,execute)).rejects.toThrow('inside');
});
it('creates valid JSON, escaped HTML and quoted TSV through packaged scripts', async () => {
  const f = await fixture();
  for (const options of [{format:'json',content:'{"ok":true}'},{format:'html',content:'<script>alert(1)</script>',title:'Report'},{format:'tsv',rows:[['name','value'],['A','line\tbreak']]}]) {
    const result = await runSkillScript(f.db,f.data,f.owner.id,{skill:'document-authoring',script:'scripts/text-formats.js',inputs:[],destination:{root:f.write,path:`file.${options.format}`},options},null,execute);
    const text = await readFile(result.artifacts[0]!.filePath,'utf8');
    if (options.format === 'json') expect(JSON.parse(text)).toEqual({ok:true});
    if (options.format === 'html') { expect(text).toContain('&lt;script&gt;'); expect(text).not.toContain('<script>'); }
    if (options.format === 'tsv') expect(text).toContain('"line\tbreak"');
  }
});

it('extracts PowerPoint slides in presentation order', async () => {
  const f = await fixture();
  await writeFile(join(f.workspace,'report.pptx'), await createDocument('pptx','# Report\n\n## First\n\n- Alpha\n\n## Second\n\n- Beta','Report'));
  const preview = await previewFile(f.owner,{root:'workspace',path:'report.pptx'},f.data);
  expect(preview.kind).toBe('text');
  expect(preview.content).toContain('Alpha');
  expect(preview.content).toContain('Beta');
  expect(preview.content.indexOf('Alpha')).toBeLessThan(preview.content.indexOf('Beta'));
});
it('rejects invalid output and records failed execution without artifacts', async () => {
  const f = await fixture();
  await expect(runSkillScript(f.db,f.data,f.owner.id,{skill:'document-authoring',script:'scripts/text-formats.js',inputs:[],destination:{root:f.write,path:'bad.json'},options:{}},null,async () => ({files:[{name:'x',mimeType:'text/plain',data:'***invalid***'}]}))).rejects.toThrow();
  expect(f.db.listArtifacts()).toHaveLength(0);
  expect(f.db.listActivity(20).some(a => a.type === 'skill.script.failed')).toBe(true);
});

it('exports a script result directly without creating an output folder file or artifact', async () => {
  const f = await fixture();
  await writeFile(join(f.input, 'notes.txt'), 'export me');
  let archive: Uint8Array | undefined;
  const result = await runSkillScript(f.db, f.data, f.owner.id, {
    skill: 'file-archiving', script: 'scripts/zip.js', inputs: [{ root: f.read, path: 'notes.txt' }],
    destination: { root: 'workspace', path: 'bundle.zip' },
  }, null, execute, async files => { archive = Buffer.from(files[0]!.data, 'base64'); });
  expect(await (await JSZip.loadAsync(archive!)).file('notes.txt')!.async('string')).toBe('export me');
  expect(result.artifacts).toEqual([]);
  expect(f.db.listArtifacts()).toEqual([]);
  expect(await readdir(f.output)).toEqual([]);
  expect(await readdir(f.workspace)).toEqual([]);
});

it('cancels deletion unchanged, then trashes confirmed files and removes artifact records', async () => {
  const f = await fixture();
  const path = join(f.output, 'report.txt');
  await writeFile(path, 'report');
  f.db.createArtifact({ coworkerId: f.owner.id, taskId: null, name: 'report.txt', mimeType: 'text/plain', filePath: path });
  const ref = { root: f.write, path: 'report.txt' };
  const trash = vi.fn(async (path: string) => rename(path, join(f.root, 'trashed-report.txt')));
  const confirm = vi.fn(async () => false);
  expect((await deleteWorkFiles(f.db, f.data, f.owner.id, [ref], confirm, trash)).cancelled).toBe(true);
  expect(confirm).toHaveBeenCalledWith([await realpath(path)], []);
  expect(trash).not.toHaveBeenCalled();
  expect(f.db.listArtifacts()).toHaveLength(1);
  const result = await deleteWorkFiles(f.db, f.data, f.owner.id, [ref, ref], async () => true, trash);
  expect(result.deleted).toEqual([ref]);
  expect(trash).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.root, 'trashed-report.txt'), 'utf8')).toBe('report');
  expect(f.db.listArtifacts()).toHaveLength(0);
  expect(f.db.listActivity(20).some(event => event.type === 'files.deleted')).toBe(true);
});

it('rejects deletion of read-only files, directories, symlinks, managed context, and traversal before confirmation', async () => {
  const f = await fixture();
  await writeFile(join(f.input, 'input.txt'), 'input');
  await writeFile(join(f.workspace, 'MEMORY.md'), 'memory');
  await symlink(join(f.workspace, 'MEMORY.md'), join(f.workspace, 'alias.txt'));
  const confirm = vi.fn(async () => true), trash = vi.fn();
  for (const ref of [
    { root: f.read, path: 'input.txt' }, { root: f.write, path: '.' },
    { root: 'workspace', path: 'MEMORY.md' }, { root: 'workspace', path: 'alias.txt' },
    { root: f.write, path: '../input/input.txt' },
  ]) await expect(deleteWorkFiles(f.db, f.data, f.owner.id, [ref], confirm, trash)).rejects.toThrow();
  expect(confirm).not.toHaveBeenCalled();
  expect(trash).not.toHaveBeenCalled();
});

it('rechecks grants and file identity after confirmation, and reports trash failures', async () => {
  const f = await fixture();
  const path = join(f.output, 'report.txt');
  const ref = { root: f.write, path: 'report.txt' };
  await writeFile(path, 'before');
  const trash = vi.fn();
  const changed = await deleteWorkFiles(f.db, f.data, f.owner.id, [ref], async () => { await writeFile(path, 'changed content'); return true; }, trash);
  expect(changed.errors[0]!.message).toContain('File changed');
  const revoked = await deleteWorkFiles(f.db, f.data, f.owner.id, [ref], async () => {
    f.db.updateCoworker(f.owner.id, { sharedFolders: f.owner.sharedFolders.map(folder => ({ ...folder, access: 'read', defaultOutput: false })) });
    return true;
  }, trash);
  expect(revoked.errors[0]!.message).toContain('read-only');
  expect(trash).not.toHaveBeenCalled();
  f.db.updateCoworker(f.owner.id, { sharedFolders: f.owner.sharedFolders });
  const failed = await deleteWorkFiles(f.db, f.data, f.owner.id, [ref], async () => true, async () => { throw new Error('Trash unavailable'); });
  expect(failed.errors[0]!.message).toBe('Trash unavailable');
  expect(await readFile(path, 'utf8')).toBe('changed content');
});

it('confirms permanent folder deletion, deduplicates descendants, and leaves linked outside files untouched', async () => {
  const f = await fixture();
  const folder = join(f.output, 'reports');
  await mkdir(join(folder, 'nested', 'empty'), { recursive: true });
  const child = join(folder, 'nested', 'report.txt');
  await writeFile(child, 'report');
  await writeFile(join(f.input, 'outside.txt'), 'outside');
  await symlink(join(f.input, 'outside.txt'), join(folder, 'outside-link'));
  f.db.createArtifact({ coworkerId: f.owner.id, taskId: null, name: 'report.txt', mimeType: 'text/plain', filePath: child });
  const parentRef = { root: f.write, path: 'reports' };
  const childRef = { root: f.write, path: 'reports/nested/report.txt' };
  const confirm = vi.fn(async () => false), trash = vi.fn();
  const cancelled = await deleteWorkFiles(f.db, f.data, f.owner.id, [childRef, parentRef], confirm, trash);
  expect(cancelled.cancelled).toBe(true);
  expect(confirm).toHaveBeenCalledWith([await realpath(folder)], [await realpath(folder)]);
  expect(await readFile(child, 'utf8')).toBe('report');
  const result = await deleteWorkFiles(f.db, f.data, f.owner.id, [childRef, parentRef], async () => true, trash);
  expect(result.errors).toEqual([]);
  expect(result.deleted).toEqual([childRef, parentRef]);
  expect(result.permanentlyDeleted).toEqual([parentRef]);
  expect(result.trashed).toEqual([]);
  expect(trash).not.toHaveBeenCalled();
  await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.input, 'outside.txt'), 'utf8')).toBe('outside');
  expect(f.db.listArtifacts()).toHaveLength(0);
});

it('rejects changed nested contents and folders containing managed memory', async () => {
  const f = await fixture();
  const folder = join(f.workspace, 'reports');
  await mkdir(join(folder, 'nested'), { recursive: true });
  const child = join(folder, 'nested', 'report.txt');
  await writeFile(child, 'original');
  const ref = { root: 'workspace', path: 'reports' };
  const result = await deleteWorkFiles(f.db, f.data, f.owner.id, [ref], async () => {
    await writeFile(child, 'changed while dialog was open');
    return true;
  }, vi.fn());
  expect(result.errors[0]!.message).toContain('Folder contents changed');
  expect(await readFile(child, 'utf8')).toContain('changed');
  await symlink(child, join(f.workspace, 'MEMORY.md'));
  const confirm = vi.fn();
  await expect(deleteWorkFiles(f.db, f.data, f.owner.id, [ref], confirm, vi.fn())).rejects.toThrow('managed memory');
  await expect(deleteWorkFiles(f.db, f.data, f.owner.id, [{ root: 'workspace', path: '.' }], confirm, vi.fn())).rejects.toThrow('roots cannot be deleted');
  expect(confirm).not.toHaveBeenCalled();
});
