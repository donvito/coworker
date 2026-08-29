# Data and security

State lives under Electron's user-data directory. Model and email API keys are encrypted with Electron `safeStorage` — plaintext keys are never written to SQLite or returned to the renderer.

The renderer runs with context isolation, sandboxing, no Node integration, a restrictive CSP, and a narrow preload API. Workers cannot touch SQLite or credentials directly. File tools resolve paths against the coworker's workspace and reject traversal or escaping symlinks. Attached images are validated and capped at four images / 20 MB per message. Remote skill downloads reject credential-bearing, local, and private-network URLs, and bundled skills cannot be overwritten. There is deliberately no shell, Python, or code-execution tool.

Provider, catalog, startup, inference, and runtime-exit failures are written as redacted JSON Lines to `logs/provider-errors.jsonl` in the same directory (provider/model and task/run IDs, no prompts or credentials; rotates at 5 MB). Recent entries are viewable in **Settings → Data**, where a redacted support report can be copied or exported.
