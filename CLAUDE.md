# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm install                # Install frontend dependencies
npm run tauri dev          # Development mode (Vite + Tauri hot-reload)
npm run tauri build        # Production build → src-tauri/target/release/bundle/
```

No linter or formatter configured. No test suite.

## Architecture

Clauder is a Tauri 2 desktop app (Rust backend + React frontend) that reads Claude Code's `.jsonl` session logs from `~/.claude/projects/` and renders them in a GUI.

### Frontend → Backend Communication

- **Commands** (`invoke()`): Frontend calls Rust functions via `@tauri-apps/api/core`
- **Events** (`listen()`): Backend streams chat responses via `@tauri-apps/api/event`

### Tauri Commands (src-tauri/src/lib.rs)

- `get_projects()` — Scans `~/.claude/projects/` directories, returns project metadata
- `get_sessions(project_id)` — Lists `.jsonl` files with aggregated stats (tokens, messages, git branch)
- `get_session_messages(project_id, session_id)` — Parses JSONL into structured messages
- `get_project_path(project_id)` — Extracts working directory from session data
- `send_chat_message()` — Spawns `claude` CLI subprocess with `--output-format stream-json`, emits events (`chat-event`, `chat-done`, `chat-error`)
- `cancel_chat()` — Kills active subprocess

### Page Views

Three views managed by tab system in `App.jsx`:

- **ProjectsPage** — Project browser with search (Cmd+K), shows cards sorted by last activity
- **SessionPage** — Session sidebar + message viewer. Uses `groupMessages()` → `buildSteps()` to render assistant responses as collapsible accordion (thinking/tools/output)
- **ChatPage** — Live chat interface that spawns Claude CLI and streams responses

### Message Rendering Pipeline

1. `groupMessages()` — Groups consecutive assistant messages between user turns
2. `buildSteps()` — Extracts thinking blocks, tool uses, and text output from a group
3. Final output rendered as markdown (via `marked`), intermediate steps in collapsible accordion
4. `ToolInputView` — Renders tool inputs with syntax highlighting based on tool type (Bash, Read, Edit, etc.)

## Theming

Four themes defined as CSS custom properties in `src/index.css` on `[data-theme="..."]` selectors: dark (default), light, midnight, mocha. All styling uses `var(--*)` variables. Theme persisted via localStorage.

Key variables: `--bg-primary`, `--bg-card`, `--text-primary`, `--text-secondary`, `--accent`, `--border`, `--sidebar-width: 260px`, `--titlebar-height: 38px`.

## Conventions

- 2-space indentation, no semicolons preference varies
- Section headers in code: `// ── Section Name ──`
- Helper functions defined above components in same file, not extracted to utils unless shared
- Rust: `spawn_blocking()` for file I/O, serde `#[derive(Serialize, Clone)]` for IPC types
- `src/utils/highlight.js` — Highlight.js wrapper with registered language subset
- `src/utils/time.js` — Shared formatting helpers (relativeTime, formatTokens, tokenColor)
