export const skillToolCapabilities = {
  "file-archiving": ["skills.run", "files.roots", "files.list"],
  "document-authoring": ["skills.run", "files.roots"],
  "folder-access": ["files.roots", "files.write"],
  "coworker-memory": ["files.read", "files.edit", "files.write"],
  "web-search": ["web.search"],
  "coworker-messaging": ["coworkers.list", "coworkers.send_message"],
  "primary-coordinator": ["coworkers.list", "coworkers.send_message", "coworkers.activity"],
  "browser-control": [
    "browser.start_session",
    "browser.inspect",
    "browser.act",
    "browser.close",
  ],
} as const satisfies Record<string, readonly string[]>;

export const defaultEnabledBundledSkillNames = new Set([
  "coworker-memory",
  "coworker-administration",
  "web-search",
  "document-authoring",
  "file-archiving",
  "team-channel-collaboration",
  "coworker-messaging",
  "folder-access",
  "telegram-messaging",
  "discord-messaging",
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
