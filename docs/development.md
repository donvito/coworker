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
| `pnpm eval:contract` | Run the deterministic agent evals |
| `pnpm package` | Build an unpacked app into `release/` |
| `pnpm dist` | Build installers for the current platform into `release/` |
| `pnpm dist:mac` / `dist:win` / `dist:linux` | Build installers for one platform |

`pnpm test` builds the production worker first, then verifies queue isolation, concurrent workers, approval pause/resume, idempotency, scheduler recovery, and workspace confinement.

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

## Contributing

New coworker capabilities are delivered as Agent Skills rather than hardcoded application logic. See [AGENTS.md](../AGENTS.md) for the capability architecture and verification expectations.

Installer and release workflow: [Releasing](releasing.md).
