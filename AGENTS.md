# Coworker capability architecture

## Skills first

- Every new user-facing coworker capability must be delivered as an Agent Skill.
- Start by defining a narrowly routed `SKILL.md` with a clear description of when the model should and should not load it.
- Let the model select applicable skills through Pi's native skill discovery. Do not force a skill based on keywords, file types, or unrelated subject overlap.
- Keep coworker behavior, workflow decisions, authoring guidance, templates, and domain-specific rules in the skill and its packaged resources. Do not hardcode them in global system prompts, runtime branches, UI handlers, or regular expressions.
- Models are capable of interpreting skill instructions, choosing an approach, and using or invoking the scripts/resources provided by a skill. Avoid duplicating that reasoning in application code.

## Skill scripts

- Put deterministic or reusable work in the skill's `scripts/` directory and explain in `SKILL.md` when to run it.
- This app is a TypeScript/Node environment. Prefer TypeScript or JavaScript scripts and established Node libraries unless another runtime is genuinely required.
- Keep scripts generic to the capability and driven by explicit inputs. Validate inputs, return structured results, and report actionable errors.
- If skills need a missing execution primitive, add one generic, controlled skill-script runtime rather than a capability-specific hardcoded tool.

## Application boundaries

- Application code should provide generic, controlled execution boundaries: workspace confinement, permission and approval enforcement, credentials, process limits, audit logs, artifact registration, and renderer integration.
- It is acceptable for those boundaries to validate and safely execute a model-selected action. They must not decide the coworker's domain workflow or replace skill instructions with hidden business logic.
- Keep uploaded and bundled skills compatible with the standard package shape: one root skill folder containing `SKILL.md` and optional `scripts/`, `references/`, `resources/`, or `assets/` directories.

## Verification

- Test that the skill is discoverable for matching requests and does not trigger for excluded requests.
- Test packaged scripts independently with representative inputs and verify generated artifacts where applicable.
- Test the generic execution boundary for confinement, validation, failures, and auditability without baking one skill's workflow into it.
