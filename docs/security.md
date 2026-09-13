# Data and security

State lives under Electron's user-data directory. Model and email API keys are encrypted with Electron `safeStorage` — plaintext keys are never written to SQLite or returned to the renderer.

Each coworker's saved memory is a plaintext UTF-8 `MEMORY.md` in its workspace, limited to 8,000 characters and included in workspace backups. It is not a credential store. The app includes saved memory in model context on every turn, so a configured cloud model receives it; a local model processes it locally. Coworkers and data profiles have separate memory files. Memory provides reference context and does not grant permissions or override the user's current instructions.

Memory edits through the desktop, CLI, and controlled file tools use the same confined file boundary with validation and revision checks. Every agent-proposed memory change requires a durable approval, even if its file tool is set to automatic or the user explicitly asked it to remember something. The application enforces this boundary for whole-file writes, focused text edits, and confined file aliases; document exporters and downloads cannot overwrite managed context. User edits to a proposal can change its text, while its target, original text, and revision remain fixed. Rejected or stale proposals do not change memory. Direct user-operated settings and CLI edits save without an extra approval.

Telegram approval buttons and edit replies are accepted only from the paired private-chat user for the linked coworker. An edit reply must address the recorded prompt in its original topic. Sending that reply approves its exact text; it is not forwarded to the model as a new message.

Discord approval buttons and edit replies are accepted from any human in the paired guild channel or one of its threads. Other guild channels and DMs are ignored. An edit reply must address the recorded prompt. Sending that reply approves its exact text; it is not forwarded to the model as a new message.

Memory approvals have no **Always allow** option. Approval and tool history retain the reviewed text, including rejected proposals and user edits.

Discord and Telegram bot tokens live in the OS credential store, never SQLite, activity, or logs. Discord inbound text requires the privileged Message Content Intent (a Developer Portal toggle, not an OAuth permission). Receipt reactions use Add Reactions and Read Message History; a 403 is logged without the token and surfaced as a one-line Settings hint. The bot reacts 👀 only after a successful inject plus `RUN_STARTED`, using persisted message snowflakes so a delayed run can still react after restart.

Clearing memory removes the saved text from future turn context; it does not erase earlier conversations, tool history, existing backups, or data already sent to a provider. Disabling the memory skill does not stop existing memory from loading. See the [memory guide](memory.md) for editing and clearing it.

The renderer runs with context isolation, sandboxing, no Node integration, a restrictive CSP, and a narrow preload API. Workers cannot touch SQLite or credentials directly. File tools resolve paths against the coworker's workspace and reject traversal or escaping symlinks. Attached images are validated and capped at four images / 20 MB per message. Remote skill downloads reject credential-bearing, local, and private-network URLs, and bundled skills cannot be overwritten. There is deliberately no shell, Python, or code-execution tool.

The optional browser-control skill controls a separate, visible Chromium profile for one coworker. Starting control requires a durable approval for the current task; later browser calls are rejected without that task-scoped grant. Browser tools do not expose arbitrary JavaScript, Chrome DevTools commands, native desktop input, browser-internal URLs, or files outside the coworker's workspace. Password inputs require manual user entry. Filled values and screenshots are excluded from durable tool logs and checkpoints, browser profiles are excluded from backups and support bundles, and downloaded files are confined to the coworker workspace.

Provider, catalog, startup, inference, and runtime-exit failures are written as redacted JSON Lines to `logs/provider-errors.jsonl` in the same directory (provider/model and task/run IDs, no prompts or credentials; rotates at 5 MB). Recent entries are viewable in **Settings → Data**, where a redacted support report can be copied or exported.
