# Per-coworker Markdown memory

Branch: `codex/coworker-markdown-memory`

## Research

Reviewed the [Hermes memory documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) and [memory tool source](https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py) on 2026-09-10. Hermes keeps bounded `MEMORY.md` and `USER.md` files under its profile's `memories/` directory. It loads a frozen snapshot at session start, persists edits immediately, and rejects writes over its character budget. Its tool supports adding, replacing, and removing entries.

Adopt Markdown persistence, profile isolation, bounded context, and immediate writes. Start with one file per coworker instead of separate user and agent stores. Refresh at each task/turn boundary because this app reuses workers across conversations and users must see desktop/CLI edits on their next message. Keep the snapshot stable during a running turn. No embeddings, database memory table, retrieval service, or background consolidation in this version. The initial implementation handled explicit requests; the follow-up below adds model-suggested facts with mandatory review.

## Implementation plan

1. Deliver remember/correct/forget/show behavior as the bundled `coworker-memory` Agent Skill, discoverable through the existing Pi skill listing. Enable it for new and existing coworkers once, preserving subsequent user choices. Reuse controlled `files.read` and `files.write`; the model decides what Markdown to edit, with no keyword router or capability-specific execution tool.
2. Store `MEMORY.md` in each coworker's existing workspace. Add a shared controlled text-file boundary with an 8,000-character context budget, UTF-8 validation, confined paths, atomic replacement, serialized app writes, and optional revision preconditions (required for managed context files). Keep context files out of generated artifact listings. Existing workspace backups include memory automatically.
3. Load bounded workspace context on every dispatch, including resumed and scheduled tasks, and replace the worker's context snapshot without accumulating stale blocks or restarting active work. Missing files are empty. Invalid files fail visibly rather than silently dropping memory. Treat persisted text as reference data, subordinate to current instructions and permissions.
4. Expose memory read/update through the shared authenticated administration service and Electron preload. Add a separate save/reload memory editor in coworker settings, including load/save errors, character count, and conflict recovery. Memory-only edits do not restart workers.
5. Add CLI `memory show ID`, `memory set ID --file notes.md`, and `memory clear ID`. Set/clear fetch the current revision before writing; an optional `--revision` supports edits based on an earlier snapshot. JSON output exposes content and revision; human show output is Markdown.
6. Test persistence and coworker isolation, path and size enforcement, conflicting writers, missing/cleared memory, tool validation/permissions/approval/audits, default skill discovery and exclusions, runtime refresh, desktop editing/errors, CLI contracts, and backup inclusion. Run the complete unit/integration suite, typecheck/build, and isolated Electron/CLI smoke checks. Add model behavior evaluation cases for remembering, recall, corrections, forgetting, and excluded requests; report separately if live-model evaluation is unavailable.

## Semantics

- Memory belongs to a coworker within the selected app profile, across all of that coworker's conversations.
- A save affects the next turn; it does not interrupt a currently running task.
- Clearing memory retains conversation and audit history.
- Users edit plain Markdown. No schema, entry delimiters, or migration is required for file content.
- App-managed editors reject stale revisions. External filesystem editors are supported at turn boundaries but cannot participate in the app's in-process write lock.

## Implementation and validation

Implemented all six steps. The existing file tools provide the execution primitive, so no new script runtime, memory-specific agent tool, or dependency was needed. Generic text writes now retain one result per tool-call identity: a repeated approval cannot reapply an old write, while distinct edits and fresh reads remain auditable. New workspace directories use UUIDs to prevent simultaneous same-name coworkers from sharing memory.

Verified on macOS on 2026-09-10:

- `pnpm test`: production build and typecheck succeeded; all 340 tests in 60 files passed, including approval replay, file confinement, conflicts, backups, desktop/CLI contracts, and actual worker context payloads.
- Existing tool-safety, multimodal, and recorded behavior evaluations: all 20 passed.
- Live memory evaluation with OpenRouter `google/gemini-3.7-flash`: passed seven conversations covering remember, fresh-conversation recall, correction, forgetting, and three unrelated requests that must not invoke the memory skill or modify memory.
- `node scripts/smoke-cli.mjs`: passed with an isolated Electron development profile, including CLI-to-desktop and desktop-to-CLI memory edits, stale revision rejection, isolation, restart persistence, and clearing.
- Skill frontmatter validation and `git diff --check`: passed.

Platform smoke testing was performed on macOS; Windows and Linux were not available in this environment. The live behavior check covers one model. Invalid externally edited memory fails visibly; repair the workspace's `MEMORY.md` if it exceeds the budget or is not valid UTF-8.

## Follow-up code review

Reviewed the full implementation, including runtime dispatch, file boundaries, revision checks, tool replay, skill discovery, desktop editing, CLI framing, and shared administration authorization. Fixed four reproduced issues:

| Priority | Issue | Fix |
| --- | --- | --- |
| P1 | Concurrent first writes using `MEMORY.md` and `memory.md` could both pass the revision check and overwrite one another on a case-insensitive filesystem. | Resolve reserved context filenames to their canonical spelling before selecting the write lock; validate the original path before canonicalizing. |
| P2 | Adding a UUID to the destination basename made atomic writes fail for otherwise valid long filenames. | Use a short, independently named temporary sibling. |
| P2 | Human CLI output added a newline, so exporting and reimporting an 8,000-character memory failed its size limit. Empty memory also became a nonempty file. | Print the exact Markdown bytes for human `memory show` output, while retaining newline framing for JSON. |
| P2 | The main settings Save button could close the modal and discard a draft edited in the separate memory editor. | Keep other settings from submitting while memory has unsaved changes, explain the required save/reload action, and disable memory edits while other settings are saving. |

The new regression tests reproduced the failures before the fixes. After the fixes, `pnpm test` passed typecheck/build and all 343 tests in 60 files. The Electron/CLI smoke test also passed on macOS, including exact round trips for empty, full-capacity, and newline-terminated Markdown memory. No further actionable issues were found in the reviewed changes.

## Reviewed memory proposals in chat and Telegram

The follow-up adds model-suggested memory and mandatory review. The updated skill handles explicit remember/update/forget requests and uses model judgment to suggest durable facts the user states naturally. It excludes temporary instructions, quoted material, guesses, duplicates, credentials, and sensitive inferences. It asks for one focused change and finishes the immediate task before an optional proposal, because a pending approval pauses the coworker's queue. Native skill discovery remains responsible for selecting it; there is no keyword router or background fact extraction.

The generic `files.edit` tool proposes an exact, unique text replacement or an append against a read revision. The context-file configuration declares mandatory approval. The gateway enforces it for both focused edits and whole-file writes, even under an automatic tool policy, and preserves explicit denial policies. Approval edits can change only the proposed text; their file, original match, and revision remain fixed. Validation happens before saving the decision and again during serialized execution. Direct desktop and CLI memory editing remains a user-operated save without a second approval.

Desktop chat and the Approvals page show the proposed item with Approve, Edit, and Reject controls. Corrections and deletions also show the original text. An edited approval returns the applied text to the resumed model, and replaying a completed approval cannot apply it again.

Telegram sends the complete proposal before exposing its Approve, Reject, and Edit & approve buttons. Editing uses the Bot API's [ForceReply](https://core.telegram.org/bots/api#forcereply): a reply to the recorded prompt approves that exact replacement text, while `/cancel` keeps the original pending. Prompt references persist across bridge restarts. Sender, private chat, linked coworker, topic, and pending status are checked. These replies are consumed as decisions and never sent to the model as new messages. Memory has no Always allow option.

Review identified and fixed two additional boundary issues: plain-text Telegram chunking could split a Unicode surrogate pair or drop blank lines, and a workspace alias could let another file exporter overwrite managed context. Text previews now preserve every character. Both directions of confined context-file aliases are recognized, and document, invoice, draft, and download outputs reject managed context targets.

Validation on macOS on 2026-09-10:

- `pnpm test`: typecheck/build and all 359 tests in 62 files passed. Coverage includes proposal edits, rejection, stale revisions, size/Unicode errors, path retargeting, aliases, idempotent replay, inline UI controls, and Telegram decisions and edit replies.
- Live OpenRouter `google/gemini-3.7-flash` memory evaluation: passed 11 conversations covering explicit remember, new-conversation recall, correction, forgetting, user-edited text, rejection, a proactive durable preference, and four excluded requests. The harness verifies memory is unchanged before approving each expected proposal.
- Existing contract, multimodal, and recorded behavior evaluations: all 20 passed.
- Isolated Electron/CLI smoke: passed, including direct memory edits, revision conflicts, profile/coworker isolation, and persistence across restart.
- Real-model Electron UI check: nine assertions passed with six screenshots covering a pending explicit proposal, inline editing, the exact approved text, recall in a fresh conversation, a proactive preference, and rejection without a repeat proposal. One initial provider error occurred before a proposal and left memory empty; the fresh-conversation retry succeeded. Captures and the CLI transcript are in the local, ignored `tmp/memory-approval-screenshots/` directory.
- Skill validation, documentation link checks, and `git diff --check`: passed.

Telegram transport behavior was verified with Bot API fixtures, not a live personal bot or Telegram client. Model judgment was evaluated with one configured model and can still miss useful facts or suggest unnecessary ones; explicit requests remain supported and every proposal requires review.

## Recording review and provider continuation failure

Review of the first continuous video found a red HTTP 400 `Corrupted thought signature` error after rejecting a proposal. Memory remained unchanged, but the model continuation failed. The recording harness incorrectly treated a waiting bubble and absent Stop button as a completed response; its original success verdict was invalidated. It now requires each runtime task to reach `COMPLETED` with a non-empty result, fails on task errors, and checks recorded `RUN_ERROR` events before declaring success.

A separate live OpenRouter diagnostic reproduced the same failure by switching an unchanged Gemini tool history from Google Vertex to Google AI Studio. Incoming and outgoing encrypted signature hashes matched. Sending the identical continuation back through Vertex succeeded. The provider compatibility layer now keeps Gemini reasoning requests on Vertex from the first call through approval resumes. This prevents incompatible backend failover while retaining bounded retries for transient failures. See [provider compatibility](../development.md#openrouter-gemini-compatibility) for the availability tradeoff and old-checkpoint limitation.

After this fix, typecheck and the production build passed, and all 361 tests in 62 files passed. New coverage exercises Pi's actual streaming adapter, verifies the routing payload on both calls, and checks that encrypted signatures survive checkpoint serialization and resume unchanged.
