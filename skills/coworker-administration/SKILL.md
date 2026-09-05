---
name: coworker-administration
description: Help users operate the Coworker app from a terminal, including headless startup, restart, model configuration, installed skills, schedules, approvals, coworkers, and diagnostic logs. Use for administering Coworker itself, not for performing a coworker's assigned work or administering unrelated software.
---

# Coworker terminal administration

Use `coworker start --ui` to start with a window or reveal the existing instance, including an older headless owner. This uses the owner's normal desktop launch and does not restart active work. `--ui` and `--headless` are mutually exclusive.

Chat displays tool names and status changes on stderr while waiting, polling every half-second. Fast calls may appear only with their completed status. `chat result TASK_ID` shows the task's recorded tool states before following further changes. Arguments and results are omitted from progress output. `--json` suppresses progress and returns the final structured result on stdout.

Use the installed `coworker` command, or `pnpm cli` from a built development checkout. Run `coworker --help` for the current command interface. Terminal commands are deterministic and do not require a model provider.

To test a coworker's configured model from the terminal, use `coworker chat Ava "Hello"` (a unique coworker name or ID). This submits real work through the normal conversation service and requires that coworker's model provider. By default it creates a new direct conversation; pass `--conversation ID` to continue one. Replies print when the task finishes. A timeout or Ctrl-C stops waiting, but accepted work continues. Use `coworker chat result TASK_ID` to retrieve the result later. Approval-gated work stays paused for the user's decision. Testing chat is not permission to change the coworker's model, approve actions, or send messages through another channel.

Desktop and terminal control one application instance per data profile. `coworker start` starts a background headless instance; `coworker run --headless` stays in the foreground. Opening the desktop reveals the same instance. `status`, `stop`, and `restart` manage that instance. Restart interrupts active work using the app's existing recovery behavior; explain that consequence when relevant to the user's request.

Credentials are shared only within the same OS user, app identity, and profile. Use `--data-path /absolute/path` or `COWORKER_DATA_PATH` for an explicit profile. Development builds use a separate profile. Do not copy encrypted credentials between app identities, expose credentials, or suggest plaintext storage. Model keys are entered with `--prompt-key` or `--key-stdin`, never command-line values.

Use `models providers`, `models list PROVIDER`, `models configure PROVIDER`, and `models default PROVIDER MODEL` for model setup. Coworker model overrides are managed with `coworkers update ID`. Full coworker and schedule inputs can be provided as JSON with `--file`; use existing application fields, and inspect existing objects before patching them. Cron schedules require an explicit timezone.

Use `skills install SOURCE` for HTTPS links, SKILL.md, or .skill/.zip packages; `skills enable ID --coworker ID` assigns a skill. Skill availability does not force skill selection or authorize actions.

Use `approvals list` and `approvals show ID` to inspect requests. Approval decisions belong to the user; this skill grants no authority for an agent to approve its own actions or obtain administrative credentials. Provide the appropriate terminal command when no authorized execution surface is available.

Configuration commands require an explicitly started app. `logs show`, `logs follow`, and `logs export --output PATH` also work while it is stopped. Exported diagnostics can contain filenames and error context; do not send them elsewhere without the user's instruction. No terminal command changes the user's existing action permissions.
