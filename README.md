# clauder

A lightweight desktop app for browsing your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session history. It reads the raw `.jsonl` session logs from `~/.claude/projects/` and presents them in a clean, searchable interface — no API keys, no configuration, no terminal.

## Features

- **Project browser** — automatically discovers all Claude Code projects with search (Cmd+K)
- **Session viewer** — browse conversations organized by date with message counts and token usage
- **Full message rendering** — user messages, assistant responses with markdown and syntax-highlighted code blocks
- **Thinking blocks** — collapsible sections showing Claude's reasoning with token estimates
- **Tool call details** — expandable tool invocations (Read, Edit, Bash, Grep, etc.) with file paths and parameters
- **Inline diffs** — unified diff view for file edits with syntax highlighting
- **Multi-tab interface** — open multiple projects in separate tabs, drag to reorder (Cmd+T / Cmd+W)
- **4 themes** — Dark, Light, Midnight, Mocha (persisted across sessions)
- **Collapsible tab bar** — hide/show with Cmd+B for more screen space
- **Git branch display** — see which branch each session was on

## Installation

### Download

Go to the [Releases](../../releases/latest) page and download the installer for your platform:

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `.dmg` (aarch64) |
| macOS (Intel) | `.dmg` (x64) |
| Windows | `.msi` |
| Linux | `.deb` / `.AppImage` |

> **macOS note:** The app is not signed with an Apple Developer certificate. macOS will show a "damaged" warning on first launch. To fix this, run the following command in Terminal:
> ```bash
> xattr -cr /Applications/clauder.app
> ```
> Then open the app normally. This only needs to be done once.

### Build from source

**Prerequisites:** [Node.js](https://nodejs.org/) (v18+), [Rust](https://rustup.rs/)

```bash
git clone https://github.com/yavuzozguven/clauder.git
cd clauder
npm install
npm run tauri dev     # development mode
npm run tauri build   # production build
```

The production build output will be in `src-tauri/target/release/bundle/`.

## How it works

clauder reads Claude Code's session logs from `~/.claude/projects/`. These are `.jsonl` files that Claude Code writes automatically during every conversation. The app parses them and renders the conversation in a structured UI.

**No data leaves your machine.** The app is entirely local — it only reads files from disk.

## Tech stack

- **Frontend:** React, Vite, Marked, Highlight.js
- **Backend:** Rust, Tauri 2
- **Styling:** Custom CSS with CSS variables

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+T | New tab |
| Cmd+W | Close tab |
| Cmd+1-9 | Switch to tab |
| Cmd+B | Toggle tab bar |
| Cmd+K | Focus project search |

## License

MIT
