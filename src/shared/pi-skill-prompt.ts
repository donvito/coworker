import {
  formatSkillsForSystemPrompt,
  type Skill as PiSkill,
} from "@earendil-works/pi-agent-core";

export interface ModelSelectableSkill {
  name: string;
  description: string;
}

export function formatModelSelectableSkills(skills: ModelSelectableSkill[]): string {
  const piSkills: PiSkill[] = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    content: "",
    filePath: `skill://${skill.name}/SKILL.md`,
  }));
  const nativePrompt = formatSkillsForSystemPrompt(piSkills);
  if (!nativePrompt) return "";
  return [
    nativePrompt,
    "In this app, load a skill:// location by calling skills.read with the skill name; do not use files.read for skill locations. The model decides whether a skill matches the current request from its description. Load only skills needed for the requested action, not skills that merely share the same subject matter. Use the optional path argument only for a packaged resource referenced by the loaded SKILL.md. Never claim to have used a skill unless skills.read succeeded during this request.",
  ].join("\n\n");
}
