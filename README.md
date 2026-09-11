# Coworker

AI agents for your work, running on your own computer.

[![Latest release](https://img.shields.io/github/v/release/donvito/coworker)](https://github.com/donvito/coworker/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/macOS-arm64%20%7C%20Intel-111111?logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-x64%20%7C%20ARM64-0078D4?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-AppImage%20%7C%20deb-FCC624?logo=linux&logoColor=black)
![Local-first](https://img.shields.io/badge/local--first-yes-2ea44f)
![No subscription](https://img.shields.io/badge/subscription-none-2ea44f)
![Telegram](https://img.shields.io/badge/Telegram-supported-26A5E4?logo=telegram&logoColor=white)

![Coworker chat](docs/images/coworker-chat.png)

Coworker is a local-first desktop app for independent AI coworkers. There is **no subscription**. The app runs on **your computer**, talks to **local models** or keys you bring, learns new **skills**, keeps a **scheduler**, pauses on **approvals**, and can meet you on **Telegram**.

[More screenshots](docs/screenshots.md) · [What it can do](docs/features.md)

## Why Coworker

- **No subscription** — free to download and use. Pay a model provider only if you choose one.
- **Runs on your computer** — macOS, Windows, and Linux. Conversations, files, and app data are stored locally.
- **Local models** — point it at [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) and inference never leaves your machine.
- **Bring your own keys** — Anthropic, OpenAI, Google, OpenRouter, or any OpenAI-compatible endpoint. Credentials stay in OS-backed storage.
- **Skills** — coworkers learn new capabilities from Agent Skills. Upload a `SKILL.md`, add an HTTPS URL, or paste a skill link into chat.
- **Memory** — coworkers can propose useful facts and preferences to remember across conversations. Approve, edit, or reject each proposal in chat or Telegram; manage saved Markdown in the desktop app or CLI.
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

## Terminal and headless mode

Run Coworker without a window or tray while workers, schedules, and Telegram stay active. The CLI shares the desktop's profile and credentials, and installed macOS/Windows apps can start automatically at user login.

```sh
coworker start
coworker status
coworker startup enable --headless
```

See the [terminal and headless guide](docs/cli.md) for CLI installation, commands, login startup, and testing.

## Memory

Tell a coworker, “Remember that I prefer invoice totals in SGD.” Its saved facts live in a separate `MEMORY.md` in its workspace and load on every new turn, across conversations and scheduled work. You can ask it to correct or forget an entry, too.

The memory skill also lets the model suggest durable preferences you share naturally. Every proposed change requires your approval. The chat card shows the item with **Approve**, **Edit**, and **Reject** controls. Telegram shows the same text and supports approval buttons or editing by reply. Nothing is saved while a proposal is pending.

To edit saved memory directly, right-click the coworker in the chat sidebar, open its settings, edit **Saved memory (Markdown)**, and click **Save memory**. These user-operated edits save directly, as do the terminal commands:

```sh
coworker coworkers list
coworker memory show COWORKER_ID
coworker memory set COWORKER_ID --file notes.md
coworker memory clear COWORKER_ID
```

Memory is limited to 8,000 characters per coworker. `set` replaces the whole file. Saved memory is included in context sent to your selected model, including a cloud provider if you use one. See the [memory guide](docs/memory.md) for editing, revision checks, and data handling.

## Docs

- [Screenshots](docs/screenshots.md)
- [Features](docs/features.md)
- [Memory](docs/memory.md)
- [Terminal and headless mode](docs/cli.md)
- [Development](docs/development.md)
- [Data and security](docs/security.md)
- [Releasing](docs/releasing.md)

## License

[Apache License 2.0](LICENSE)
