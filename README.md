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

## Group message moderation

The bot can use the configured Codex model as an ephemeral, read-only JSON classifier for approved group chats. It is disabled by default.

1. Add the target group's `chat_id` to `session/knowledge/contacts.md` under `## Allowed chats`. Moderation is intentionally limited to approved group chats.
2. Configure `.env`:
   - `MODERATION_ENABLED=true`
   - `MODERATION_ENGINE=codex`
   - `MODERATION_CONFIDENCE_THRESHOLD=0.9`
   - Optional fast prefilter: `MODERATION_KEYWORDS=comma,separated,literal,keywords`
   - Optional regex prefilter: `MODERATION_REGEXES=regex1;regex2`
3. Start with `MODERATION_RECALL_ENABLED=false` (dry-run). Classifier decisions are written to `logs/moderation-audit.jsonl`; the moderation audit does not store original message text.
4. After validating false positives, set `MODERATION_RECALL_ENABLED=true`.
5. Grant the Feishu app permission to receive all group messages (for example `im:message.group_msg` or `im:message.group_msg:readonly`) and `im:message:recall`; for recalling another member's group message, the bot must be that group's owner, administrator, or creator.

The Codex classifier is called from an isolated temporary working directory with `--sandbox read-only`, `--ephemeral`, and a JSON output schema. It receives the message as untrusted data and is instructed not to use tools. `MODERATION_CONCURRENCY` and `MODERATION_QUEUE_LIMIT` bound model invocation load. A classifier timeout, queue overflow, or invalid response is treated as allow/degraded and is never automatically recalled.

Use `/moderation` as an administrator to inspect the current moderation configuration. Enabling this feature sends approved group message text to the configured model provider, so confirm that this matches your data-handling policy. The current classifier covers extracted text and rich-text content; it does not inspect images.

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
| `/set-bot-admin` | Set the current bot as a group administrator | Admin |
| `/moderation` | Show AI moderation configuration | Admin |

`/set-bot-admin` calls `im/v1/chats/:chat_id/managers/add_managers` with the current bot's `app_id`. Feishu requires the app to have bot capability and the API permission, and the API caller must be the group owner when assigning administrators.

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
