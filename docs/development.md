# Development

Requires **Node.js 22.12+** and **pnpm**. See the [main README](../README.md#development) for the quick start.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the app in development |
| `pnpm typecheck` | TypeScript check, no emit |
| `pnpm build` | Typecheck + production build |
| `pnpm db:generate` | Generate a versioned SQLite migration from the Drizzle schema |
| `pnpm db:check` | Validate the Drizzle migration history |
| `pnpm test` | Build, then run the integration suite |
| `pnpm test:cli:smoke` | Build, then exercise the real Electron app and CLI in an isolated profile |
| `pnpm eval:contract` | Run the deterministic agent evals |
| `pnpm eval:memory` | Run the live model evaluation for memory across conversations |
| `pnpm package` | Build an unpacked app into `release/` |
| `pnpm dist` | Build installers for the current platform into `release/` |
| `pnpm dist:mac` / `dist:win` / `dist:linux` | Build installers for one platform |

`pnpm test` builds the production worker first, then verifies queue isolation, concurrent workers, approval pause/resume, idempotency, scheduler recovery, workspace confinement, and memory persistence, context loading, and editing.

Changing a coworker's settings while it is working stops the old runtime before retrying interrupted work with the updated configuration. Runtime stop recovery must leave pending approvals and terminal tasks intact, and must prevent events from the retired worker from changing the replacement run. Regression coverage lives in `tests/runtime-stop-recovery.test.ts`.

The model receives the coworker's current name, role, and description as its authoritative profile. Editing these fields updates its identity even when custom operating instructions still mention an earlier role; those instructions remain saved unchanged. `tests/runtime-settings-recovery.test.ts` checks the real worker's model payload after profile edits and new conversations.

## Agent evals

The Vitest Evals suite exercises production worker threads and controlled tools, not mocked agent facades. It is split by what each suite can honestly measure.

**Contract evals** (`evals/tool-safety`, `evals/multimodal`) assert deterministic policy: path confinement, malformed tool input, approval gating, idempotent side effects, and image validation. No model is involved, so these gate every push.

```sh
pnpm eval:contract      # keyless, deterministic — the CI gate
pnpm eval:report:contract   # also writes eval-results/latest.json
pnpm eval:ui            # browse the report
```

**Behavior evals** (`evals/coworker-behavior`) assert model judgment: which controlled tool the coworker reaches for, and in what order. Grading that against a scripted stand-in would only measure the script, so each scenario runs against a real provider once and replays the recorded turns afterwards.

Recordings live in `evals/recordings/` and are currently **local and gitignored**, so these evals skip in CI rather than gate it. Committing that directory is what turns them into a CI gate; until then they are a local tool.

```sh
pnpm eval:behavior      # replay the committed recordings

EVAL_PROVIDER=openai \
EVAL_MODEL=gpt-4.1-mini \
EVAL_API_KEY=... \
pnpm eval:record        # re-record against a live provider
```

A scenario with no recording and no live provider is skipped, never graded against a stand-in. Re-record whenever a prompt, tool surface, or system prompt changes — a stale recording is a stale claim about the model.

A scenario marked `liveOnly` never replays. Its recorded turns reference an identifier the app generated during recording (an invoice number derives from a per-run task id), which a replay regenerates differently, so replaying it would assert nothing.

`EVAL_PROVIDER` accepts `anthropic`, `openai`, `google`, or `openrouter`. A provider-specific key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`) can be used instead of `EVAL_API_KEY`. Live runs may incur provider charges; the contract suite never makes remote calls.

## Memory evaluations

The memory behavior evaluation exercises a real model proposing explicit and implicit durable facts, waiting for approval, respecting user edits and rejection, recalling facts in a new conversation, correcting and forgetting them, and excluding temporary or quoted instructions:

```sh
EVAL_PROVIDER=openrouter EVAL_MODEL=google/gemini-3.7-flash pnpm eval:memory
```

Use the corresponding provider API key environment variable. This live, multi-conversation evaluation skips when a provider/model/key is not configured. The harness asserts that memory remains unchanged before approval and then supplies each expected decision. The ordinary test suite verifies mandatory approval, immutable proposal targets, aliases, revisions, persistence, backups, desktop/CLI editing, and the actual worker's context payload with a local test provider. Telegram Bot API fixtures cover full previews, approve/reject buttons, edit replies, cancelled or stale edits, sender/topic checks, and edit-prompt persistence across bridge restarts. `pnpm test:cli:smoke` also checks memory isolation, stale revisions, exact text export/import, desktop/CLI shared state, and persistence after a real app restart. See the [CLI verification guide](cli.md#verification) for platform requirements.

The document-format evaluation checks native skill selection for written artifacts, saved-default confirmation with an alternative, follow-up context, confirmed PDF export, explicit format overrides, and chat-only exclusions. It uses a temporary workspace and never configures messaging integrations:

```sh
pnpm build
EVAL_PROVIDER=openrouter EVAL_MODEL=google/gemini-3.5-flash-lite pnpm exec vitest run --config vitest.evals.config.ts evals/document-format.eval.ts
```

Supply the provider key as above. This evaluation is live-only; static skill assertions and recorded replies do not establish multi-turn model behavior.

Live validation on September 11, 2026 passed the eight-turn saved-format flow on Gemini 3.5 Flash Lite. Gemini 3.1 Flash Lite passed explicit PDF creation with a registered, readable artifact, but failed the saved-default confirmation check: it sometimes skipped skill loading or exported before confirmation. Keep that failure visible when evaluating model compatibility. SDK validation failures and controlled-tool denials are tested separately in `tests/runtime-tool-errors.test.ts`; the renderer must display their structured error status rather than treating a finished tool call as a successful action.

When a later matching attempt creates a file in the same user turn, the earlier failure is collapsed under “Succeeded after retry,” with its details still available. Failures without a confirmed matching success remain visible. This presentation does not alter tool results, task records, or approval decisions.

## OpenRouter Gemini compatibility

The [provider compatibility layer](../src/main/runtime/openrouter-reasoning.ts) keeps reasoning enabled where required and routes Gemini reasoning models through Google Vertex for the whole tool interaction, including approval resumes. In a live diagnostic, replaying Vertex's unchanged encrypted thought signatures through Google AI Studio returned HTTP 400 `Corrupted thought signature`; replaying the identical continuation through Vertex succeeded. OpenRouter [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) is restricted to `google-vertex` with cross-provider fallback disabled. This preserves the signatures and prevents an incompatible backend switch; it does not eliminate upstream outages. Existing bounded retries still apply. A checkpoint created through another backend before this fix may require starting a fresh task.

Recording tests must wait for the authoritative task status `COMPLETED`, reject `FAILED`/`CANCELLED` tasks and `RUN_ERROR` events, and require a non-empty response. A waiting bubble or absence of a Stop button is not evidence that a resumed inference completed.

## Memory implementation

The [bundled memory skill](../skills/coworker-memory/SKILL.md) owns when and how to propose, remember, correct, and forget facts. Pi discovers it through the normal skill catalog. The model uses its instructions to judge whether a stated fact would help in future work. The runtime loads bounded workspace context at the start of each turn without routing requests or extracting facts itself.

The [workspace context configuration](../src/shared/workspace-context.ts) declares the file, size budget, and approval requirement. The [workspace text boundary](../src/main/tools/workspace-text.ts) handles UTF-8 validation, path confinement, aliases, revision checks, serialized app writes, and atomic replacement. The skill uses `files.read` and the generic `files.edit` tool for exact, unique replacements or appends; `files.write` remains protected for whole-file changes. A shared [proposal presentation](../src/shared/workspace-text-approval.ts) drives the desktop card and Telegram preview. Approval validates edited text before saving the decision and checks the revision again on execution. Desktop and CLI memory administration use the same boundary for direct user edits. Keep future memory workflow changes in the skill and generic execution controls in the application boundary.

The [user guide](memory.md) describes the supported behavior. The [design and validation record](plans/coworker-memory.md) covers the Hermes research, implementation choices, tests, and known limitations.

## Contributing

New coworker capabilities are delivered as Agent Skills rather than hardcoded application logic. See [AGENTS.md](../AGENTS.md) for the capability architecture and verification expectations.

Installer and release workflow: [Releasing](releasing.md).

### Retina rendering after background startup

Use the application flag `--coworker-headless` when launching the Electron executable in background mode. Chromium consumes `--headless` itself and installs a synthetic 1× display on macOS; a subsequently opened window is then stretched on a Retina screen. The public `coworker start --headless` and `coworker run --headless` commands keep their existing syntax and translate to the application flag. Old direct executable invocations relaunch once with the safe flag before acquiring a profile lock. Login launch arguments use the same flag.

Verified on this Mac: the old flag reported renderer/display scale 1 and an 800×568 native capture; a normal or application-prefixed launch reported scale 2 and an 1800×1136 native capture. Removing the Chromium flag after the main script starts did not repair the display. The Electron CLI smoke test also passes after attaching the desktop to a background owner.

Verification of the Retina startup fix passed the production build/typecheck, all 362 tests in 62 files, and the real Electron CLI smoke test. The eight tests requiring localhost or Unix sockets were rerun with local networking available after sandbox `EPERM` failures. A real capture measured `devicePixelRatio: 2`, display scale 2, and 2880 × 2100 output. During the live memory test, the model proposed an unwanted reversal of an edited approval; persistence remained correct and the reversal was rejected.

Video projects and their generated assets, recordings, and exports are local-only under `videos/`, which is excluded from Git. Temporary test recordings under `tmp/` are also excluded.
