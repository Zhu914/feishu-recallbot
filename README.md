# Feishu Bot Framework

A reusable Node.js framework for a Feishu bot that receives messages through a long-lived WebSocket connection, manages per-topic Claude Code sessions, replies with Feishu cards, and runs optional cron tasks.

```text
Feishu events → WebSocket → access control / commands → Claude Code session → Feishu reply
```

This template intentionally contains no original personal skills, knowledge bases, workflows, reports, or scheduled tasks.

## Core modules

| Path | Purpose |
|---|---|
| `src/index.js` | Feishu event handling, access control, commands, sessions, WebSocket supervisor |
| `src/feishu.js` | Feishu API wrapper and message/card handling |
| `src/scheduler.js` | Optional cron task scheduler |
| `session/CLAUDE.md` | Generic assistant instructions |
| `session/knowledge/contacts.md` | User/chat allowlist template |
| `skills/` | Empty skill area for your new bot |
| `tasks.json` | Empty cron-task configuration |

## Setup

1. Create a Feishu custom app and enable its bot capability.
2. Use the WebSocket event subscription mode.
3. Subscribe to `im.message.receive_v1`.
4. Grant the minimum permissions required by your bot.
5. Copy `.env.example` to `.env` and fill in your own app credentials.
6. Put your administrator's real `open_id` in `session/knowledge/contacts.md`.
7. Install and start:

```bash
npm install
npm start
```

## Commands

| Command | Description | Access |
|---|---|---|
| `/help` | List commands | Allowed users |
| `/status` | Show active sessions | Allowed users |
| `/stop` | Stop the current topic task | Allowed users |
| `/allow <open_id>` | Add an allowed user | Admin |
| `/remove <open_id>` | Remove an allowed user | Admin |
| `/users` | List allowed users | Admin |

## Security notes

- Use a separate Feishu app for each bot; do not share production credentials between instances.
| `tasks.json` starts empty. Review every task before enabling it.
- Skills are code/prompt extensions. Review their permissions and data access before installation.
- Claude runs with normal permission prompts by default. Set `CLAUDE_PERMISSION_MODE` only when you understand the implications.
