export const skillToolCapabilities = {
  "web-search": ["web.search"],
  "browser-control": [
    "browser.start_session",
    "browser.inspect",
    "browser.act",
    "browser.close",
  ],
} as const satisfies Record<string, readonly string[]>;

export const defaultEnabledBundledSkillNames = new Set([
  "web-search",
  "document-authoring",
  "team-channel-collaboration",
  "folder-access",
  "telegram-messaging",
]);

export function toolNamesForSkills(skills: Iterable<{ name: string }>): string[] {
  const result = new Set<string>();
  for (const skill of skills) {
    const tools = skillToolCapabilities[skill.name as keyof typeof skillToolCapabilities];
    for (const tool of tools ?? []) result.add(tool);
  }
  return [...result];
}

export function skillEnablesTool(skills: Iterable<{ name: string }>, toolName: string): boolean {
  return toolNamesForSkills(skills).includes(toolName);
}
