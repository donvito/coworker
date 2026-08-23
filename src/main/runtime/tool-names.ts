const providerToolNamePattern = /^[a-zA-Z0-9_-]+$/;

export function toProviderToolName(controlledToolName: string): string {
  if (providerToolNamePattern.test(controlledToolName)) return controlledToolName;
  const normalized = controlledToolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!normalized) throw new Error(`Tool name cannot be normalized: ${controlledToolName}`);
  return normalized;
}
