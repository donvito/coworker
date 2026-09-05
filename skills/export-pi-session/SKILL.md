---
name: export-pi-session
description: Export a Coworker task checkpoint from its local SQLite database into Pi coding-agent session JSONL, preserving user, assistant, thinking, tool-call, and tool-result blocks. Use when the user asks to extract, reconstruct, inspect, or migrate a Coworker run in Pi's session format. Do not use for ordinary conversation exports or diagnostic logs.
---

# Export a Coworker checkpoint as a Pi session

Use `scripts/export-pi-session.mjs` for deterministic conversion. It merges two database sources: authored conversation entries from `messages`, and per-task assistant/thinking/tool blocks from `task_checkpoints.messages_json`. Coworker's synthetic checkpoint user prompts are deliberately discarded because they embed prior `You:` and coworker transcript lines inside one user block.

Run:

```bash
node skills/export-pi-session/scripts/export-pi-session.mjs \
  --db /absolute/path/to/coworker.db \
  --task-id <task-uuid> \
  --output /absolute/path/to/session.jsonl
```

If the user gives a conversation ID instead, pass `--conversation-id`; the script selects its latest checkpoint. A task export reconstructs its conversation through that task, including earlier task checkpoints from the same thread. Do not combine different coworkers or conversation branches.

The database and checkpoint may contain private prompts, thinking, tool arguments, and tool results. Read or export them only when the user requests that content. Keep output in the user's workspace unless they explicitly choose another location.

After export, check the script's structured summary and parse every JSONL line. The first line must be a version 3 `session` header. Remaining entries must form a linear `id`/`parentId` chain and message entries must retain their original order.
