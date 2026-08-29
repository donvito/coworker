# Coworker

AI agents for your work, running on your own computer.

![Team room](docs/images/home.png)

Coworker is a local-first desktop app for independent AI coworkers. There is **no subscription**. The app runs on **your computer**, talks to **local models** or keys you bring, learns new **skills**, keeps a **scheduler**, pauses on **approvals**, and can meet you on **Telegram**.

[More screenshots](docs/screenshots.md) · [What it can do](docs/features.md)

## Why Coworker

- **No subscription** — free to download and use. Pay a model provider only if you choose one.
- **Runs on your computer** — macOS, Windows, and Linux. Conversations, files, and app data stay on the machine.
- **Local models** — point it at [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) and inference never leaves your machine.
- **Bring your own keys** — Anthropic, OpenAI, Google, OpenRouter, or any OpenAI-compatible endpoint. Credentials stay in OS-backed storage.
- **Skills** — coworkers learn new capabilities from Agent Skills. Upload a `SKILL.md`, add an HTTPS URL, or paste a skill link into chat.
- **Scheduler** — persistent cron and one-time jobs, in plain language, with crash recovery.
- **Approvals** — consequential actions pause until you approve or reject them, in the app or from Telegram.
- **Telegram** — pair a private chat and message a coworker from your phone. Replies, files, and approval buttons stay in sync with the desktop.

## Download

Prebuilt installers for **macOS**, **Windows**, and **Linux** are on every [GitHub release](https://github.com/donvito/coworker/releases/latest).

The builds are not code-signed yet, so the OS warns on first launch. See [install notes](docs/releasing.md#after-you-download).

## Development

Requires **Node.js 22.12+** and **pnpm**.

```sh
pnpm install
pnpm dev
```

Unpackaged development builds use a separate **Coworker Development** data profile. Set `COWORKER_DATA_PATH` to an absolute directory to use another isolated profile; packaged builds continue using the normal production data directory.

The app ships with two demo coworkers — **Ava** (accounting) and **Sarah** (sales) — that run on a built-in faux provider, so you can try the full flow without an API key.

To connect a real model, open **Settings → Providers**, add credentials, and verify the provider. Ollama (`http://127.0.0.1:11434/v1`) and LM Studio (`http://127.0.0.1:1234/v1`) work without an API key.

Scripts, tests, evals, and packaging: [Development](docs/development.md)

## Docs

- [Screenshots](docs/screenshots.md)
- [Features](docs/features.md)
- [Development](docs/development.md)
- [Data and security](docs/security.md)
- [Releasing](docs/releasing.md)
