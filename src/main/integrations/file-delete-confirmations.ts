import { randomUUID } from 'node:crypto';
import type { FileDeleteConfirmation, FileDeleteResult } from '@shared/files';

type Confirm = (paths: string[], permanentFolders: string[]) => Promise<boolean>;
type Pending = { owner: string; decide: (value: boolean) => void; result: Promise<FileDeleteResult>; timer: ReturnType<typeof setTimeout> };

/** Keep the main-process file snapshot while the renderer displays its confirmation. */
export class FileDeleteConfirmations {
  private pending = new Map<string, Pending>();
  private epochs = new Map<string, number>();
  private disposed = false;

  prepare(owner: string, run: (confirm: Confirm) => Promise<FileDeleteResult>): Promise<FileDeleteConfirmation> {
    this.cancelOwner(owner);
    const epoch = this.epochs.get(owner);
    return new Promise((resolve, reject) => {
      let token: string | undefined;
      const result = Promise.resolve().then(() => run(async (paths, permanentFolders) => {
        if (this.disposed || this.epochs.get(owner) !== epoch) throw new Error('Deletion confirmation was cancelled.');
        token = randomUUID();
        return new Promise<boolean>(decide => {
          const timer = setTimeout(() => this.cancel(token!), 5 * 60_000);
          timer.unref?.();
          this.pending.set(token!, { owner, decide, result, timer });
          resolve({ token: token!, paths, permanentFolders });
        });
      }));
      void result.catch(reject).finally(() => { if (token) this.pending.delete(token); });
    });
  }

  async finish(owner: string, token: string, confirmed: boolean): Promise<FileDeleteResult> {
    const request = this.pending.get(token);
    if (!request || request.owner !== owner) throw new Error('This confirmation expired. Select the items again.');
    this.pending.delete(token);
    clearTimeout(request.timer);
    request.decide(confirmed);
    return request.result;
  }

  private cancel(token: string) {
    const request = this.pending.get(token);
    if (!request) return;
    this.pending.delete(token); clearTimeout(request.timer); request.decide(false);
  }

  cancelOwner(owner: string) {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    for (const [token, request] of this.pending) if (request.owner === owner) this.cancel(token);
  }

  dispose() { this.disposed = true; for (const token of this.pending.keys()) this.cancel(token); }
}
