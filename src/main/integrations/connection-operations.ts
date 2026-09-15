import type { CoworkerDatabase } from "@main/db/database";

const operations = new WeakMap<CoworkerDatabase, Map<string, Promise<unknown>>>();

/** Hold a connection stable through delivery or lifecycle changes. Other bots remain independent. */
export async function withConnectionOperation<T>(database: CoworkerDatabase, integrationId: string, operation: () => Promise<T>): Promise<T> {
  let pending = operations.get(database);
  if (!pending) { pending = new Map(); operations.set(database, pending); }
  const previous = pending.get(integrationId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  pending.set(integrationId, next);
  try { return await next; }
  finally { if (pending.get(integrationId) === next) pending.delete(integrationId); }
}
