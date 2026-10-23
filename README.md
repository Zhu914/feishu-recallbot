# Feishu Bot Framework

A reusable Node.js framework for a Feishu bot that receives messages through a long-lived WebSocket connection, manages per-topic Codex sessions, replies with Feishu cards, and runs optional cron tasks.

```text
Feishu events → WebSocket → access control / commands → Codex session → Feishu reply
```

This template intentionally contains no original personal skills, knowledge bases, workflows, reports, or scheduled tasks.

## Core modules

| Path | Purpose |
|---|---|
| `src/index.js` | Feishu event handling, access control, commands, sessions, WebSocket supervisor |
| `src/codex.js` | Codex CLI JSONL adapter, per-user workspace execution, session resume, and abort handling |
| `src/feishu.js` | Feishu API wrapper and message/card handling |
| `src/scheduler.js` | Optional cron task scheduler |
| `AGENTS.md` | Generic Codex assistant instructions |
| `session/knowledge/contacts.md` | Local user/chat allowlist bootstrap template |
| `skills/` | Empty skill area for your new bot |
| `tasks.json` | Cron-task bootstrap template |

## Setup

1. Create a Feishu custom app and enable its bot capability.
2. Use the WebSocket event subscription mode.
3. Subscribe to `im.message.receive_v1`.
4. Grant the minimum permissions required by your bot.
5. The project installs the Codex CLI through npm. Authenticate Codex before starting the bot.
6. Copy `.env.example` to `.env` and fill in your own Feishu app credentials and Codex settings.
7. Put your administrator's real `open_id` in `session/knowledge/contacts.md` for local runs; Docker seeds `/data/contacts.md` on first start.
8. Install and start:

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
| `/add-member @user` | Add a mentioned user to the current group | Admin |
| `/remove-member @user` | Preview removing a mentioned group member | Admin |
| `/remove-member confirm @user` | Remove a mentioned user from the current group | Admin |

## Security notes

- Use a separate Feishu app for each bot; do not share production credentials between instances.
- `tasks.json` starts empty. Review every task before enabling it.
- Skills are code/prompt extensions. Review their permissions and data access before installation.
- Codex commands run with `workspace-write` sandboxing by default. Only change `CODEX_SANDBOX_MODE` when you understand the implications.
- Production should use a dedicated, pre-authorized `CODEX_HOME` so the bot does not inherit personal Codex plugins and configuration.

## Deployment state

Docker keeps runtime state out of the application image:

| Container path | Purpose |
|---|---|
| `/data/contacts.md` | Runtime user/chat allowlist modified by `/allow` and `/remove` |
| `/data/tasks.json` | Runtime cron-task configuration |
| `/data/codex-home` | Codex configuration and authentication |
| `/root/.feishu-bot` | Feishu session index and per-user Codex workspaces |
| `/app/logs`, `/app/outputs` | Logs and project-level generated files |

The `bot-data` volume owns `/data`; the `bot-home` volume owns `/root/.feishu-bot`.
To migrate a deployment, stop the old container first, then move both volumes after
exporting them securely. If session continuity is not required, create a fresh server,
re-login Codex, and only migrate `bot-data` if you want to keep the allowlist/tasks.

## Codex authentication

The bot invokes Codex through `codex exec`. Local development normally reuses the
authenticated `CODEX_HOME` of the account that starts Node. For production, create and
authenticate a dedicated `CODEX_HOME`, then point the environment variable there. Docker
Compose already persists `/data/codex-home`; initialize that volume once before enabling
unattended restarts.
