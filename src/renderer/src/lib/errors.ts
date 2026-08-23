/**
 * Electron wraps main-process failures as `Error invoking remote method '…': Error: …`.
 * Strip that prefix so the panel shows the reason instead of the plumbing.
 */
export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}
