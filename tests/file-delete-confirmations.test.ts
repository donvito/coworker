import { afterEach, expect, it, vi } from 'vitest';
import { FileDeleteConfirmations } from '@main/integrations/file-delete-confirmations';
import type { FileDeleteResult } from '@shared/files';
const outcome = (cancelled: boolean): FileDeleteResult => ({ cancelled, deleted: [], permanentlyDeleted: [], trashed: [], errors: [] });
afterEach(() => vi.useRealTimers());

it('waits for a one-time confirmation bound to its renderer and coworker', async () => {
  const broker = new FileDeleteConfirmations();
  const mutation = vi.fn();
  const confirmation = await broker.prepare('renderer:ava', async confirm => {
    if (!await confirm(['/files/reports'], ['/files/reports'])) return outcome(true);
    mutation(); return outcome(false);
  });
  expect(confirmation.paths).toEqual(['/files/reports']);
  expect(confirmation.permanentFolders).toEqual(['/files/reports']);
  expect(mutation).not.toHaveBeenCalled();
  await expect(broker.finish('renderer:sarah', confirmation.token, true)).rejects.toThrow('expired');
  expect(mutation).not.toHaveBeenCalled();
  expect((await broker.finish('renderer:ava', confirmation.token, true)).cancelled).toBe(false);
  expect(mutation).toHaveBeenCalledTimes(1);
  await expect(broker.finish('renderer:ava', confirmation.token, true)).rejects.toThrow('expired');
  broker.dispose();
});

it('cancels abandoned or expired requests without mutating files', async () => {
  vi.useFakeTimers();
  const broker = new FileDeleteConfirmations();
  const mutation = vi.fn();
  const run = async (confirm: (paths: string[], folders: string[]) => Promise<boolean>) => {
    if (await confirm(['/file.txt'], [])) mutation();
    return outcome(true);
  };
  const first = await broker.prepare('owner', run);
  const second = await broker.prepare('owner', run);
  await expect(broker.finish('owner', first.token, true)).rejects.toThrow('expired');
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await expect(broker.finish('owner', second.token, true)).rejects.toThrow('expired');
  const third = await broker.prepare('owner', run);
  expect((await broker.finish('owner', third.token, false)).cancelled).toBe(true);
  expect(mutation).not.toHaveBeenCalled();
  broker.dispose();
});

it('reports preflight errors without displaying an actionable confirmation', async () => {
  const broker = new FileDeleteConfirmations();
  await expect(broker.prepare('owner', async () => { throw new Error('Read-only folder'); })).rejects.toThrow('Read-only folder');
  broker.dispose();
});
