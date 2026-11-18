# Feishu Bot Framework

A Node.js bot that receives Feishu messages through a long-lived WebSocket connection, moderates group chats with deterministic rules plus a cloud LLM classifier (Zhipu Managed Agents), manages group order (ad recall, vote control, kick-confirmation cards), and replies with a fixed canned message.

```text
Feishu events → WebSocket → access control / rules → [word rules | MA classifier] → recall / warn / kick cards / canned reply
```

The agent main path (per-topic Codex sessions, attachments, generated files) has been retired: model inference is now only used for message classification, one ephemeral cloud session per judged message.

## Core modules

| Path | Purpose |
|---|---|
| `src/index.js` | Feishu event handling, access control, commands, canned replies, WebSocket supervisor |
| `src/ma.js` | Managed Agents classifier client: one ephemeral session per message, poll-based, session sweeper |
| `src/moderation.js` | AI moderation pipeline: rules prefilter, confidence tiers, audit log, degraded-allow fallback |
| `src/feishu.js` | Feishu API wrapper and message/card handling |
| `src/ad-recall.js` | Deterministic ad recall, vote control, violation counters, kick-confirmation cards |
| `src/qrcode.js` + `src/qrcode-worker.js` | Local QR-code detection for image messages (worker-isolated, timeout-capped) |
| `config/agent.json` | MA engine config (agent name, environment, model) — policy values, tracked in git |
| `config/reply-policy.json` | Reply gating and canned reply text |
| `config/ad-recall.json` | Ad-recall/kick/vote policy |
| `session/knowledge/contacts.md` | Local user/chat allowlist bootstrap template |

## Setup

1. Create a Feishu custom app and enable its bot capability.
2. Use the WebSocket event subscription mode.
3. Subscribe to `im.message.receive_v1`.
4. Grant the minimum permissions required by your bot.
5. Provide a Zhipu API key: `ZHIPUAI_API_KEY` env var or `.secrets/zhipu.key`.
6. Create a Managed Agents environment (cloud console) and put its id into `config/agent.json`. The toolless classifier agent is created automatically on first run.
7. Copy `.env.example` to `.env` and fill in your Feishu app credentials.
8. Put your administrator's real `open_id` in `session/knowledge/contacts.md` for local runs; Docker seeds `/data/contacts.md` on first start.
9. Install and start:

```bash
npm install
npm start
```

## Group message moderation

The bot uses Managed Agents as an ephemeral JSON classifier for approved group chats: each judged message gets a fresh cloud session (toolless agent, `glm-5.3-flashx` + low effort by default), one turn, then the session is deleted. No conversation state is shared between messages. It is disabled by default.

1. Add the target group's `chat_id` to `session/knowledge/contacts.md` under `## Allowed chats`. Moderation is intentionally limited to approved group chats.
2. Configure `.env`:
   - `MODERATION_ENABLED=true`
   - `MODERATION_ENGINE=ma`
   - `MODERATION_CONFIDENCE_THRESHOLD=0.9`
   - Optional fast prefilter: `MODERATION_KEYWORDS=comma,separated,literal,keywords`
   - Optional regex prefilter: `MODERATION_REGEXES=regex1;regex2`
3. Start with `MODERATION_RECALL_ENABLED=false` (dry-run). Classifier decisions are written to `logs/moderation-audit.jsonl`; the moderation audit does not store original message text.
4. After validating false positives, set `MODERATION_RECALL_ENABLED=true`.
5. Warn tier: `block` decisions with confidence in `[MODERATION_WARN_THRESHOLD, MODERATION_CONFIDENCE_THRESHOLD)` (default 0.7–0.9) get a reminder card in the group without recall or blocking.
6. Grant the Feishu app permission to receive all group messages (for example `im:message.group_msg` or `im:message.group_msg:readonly`) and `im:message:recall`; for recalling another member's group message, the bot must be that group's owner, administrator, or creator.

Measured end-to-end latency (flashx + effort low): P50 ≈ 4.8s, P95 ≈ 6.0s against the default 15s timeout; session creation is <150ms. The classifier receives the message wrapped as untrusted data and is instructed to return JSON only; a malformed response is retried once in the same session and then treated as allow/degraded. `MODERATION_CONCURRENCY` and `MODERATION_QUEUE_LIMIT` bound model invocation load. A classifier timeout, queue overflow, or invalid response is never automatically recalled. A sweeper deletes sessions leaked by crashed flows.

Use `/moderation` as an administrator to inspect the current moderation configuration. Enabling this feature sends approved group message text to the model provider, so confirm that this matches your data-handling policy. The current classifier covers extracted text and rich-text content; it does not inspect images.

Group owners and user administrators are exempt from moderation via `isChatAdmin` (the same group-facts whitelist and cache used by ad recall). If the group-info lookup fails, the exemption does not apply for that check.

## Ad recall

Ad recall classifies group messages into `strong_ad` (auto-recalled), `weak_ad` (sender warning + admin report), and `normal` (no action) from deterministic rules: phone numbers, WeChat IDs, QR-code hints, duplicate bursts (text messages only — the constant `[图片]`/`[附件: …]` placeholder text of image/file messages is excluded from the duplicate key), netdisk-link diversion and short-link hosts (each a configurable host table matched against a shared diversion-word list — the combo recalls once `netdisk.mode`/`shortLink.mode` is `recall`, bare links get a warn card, and `shortLink.aloneAction` tunes the bare-link tier; links are never fetched/expanded), forbidden solitaires, and unambiguous profanity words (`profanity.words` in `config/ad-recall.json`, disabled when `profanity.enabled` is false; gray-area insults are left to AI moderation). Links are deliberately **not** a deterministic rule — the AI classifier judges them by context (technical/doc sharing vs. ad/traffic diversion), so normal GitHub/blog links are not recalled.

1. Configure `config/ad-recall.json`. The file is tracked in git because it holds policy values only — no secrets. `enabled` gates the feature; `allGroups: true` covers every group the bot is in (no per-group registration); `excludedChats` lists chat_ids to opt specific groups out; a missing or invalid file disables the feature.
2. Grant the app `im:message:recall`; recalling another member's message requires the bot to be the group owner, administrator, or creator.
3. Repeat offenders trigger a confirmation card to `adminLogChatId` (falls back to the admin DM when empty): 3 recalls within 10 minutes or 8 within 24 hours — strong-ad recalls and brake triggers both count. The bot never kicks on its own; removal happens only when the contacts.md admin taps "移出群聊" on the card. This requires the card-interaction capability and the `card.action.trigger` event subscription. Ignoring a case dismisses that card only and keeps the counters. Pending cards auto-expire after `kick.pendingExpireMs` (default 1 hour): the card is updated to an expired state and the next threshold violation sends a fresh card. Group owners/admins and the bot admin never enter the kick flow.
4. When a message is recalled, the bot posts a short reason notice in that group (no message content). The admin log chat carries only kick confirmation cards; recall, brake, and failure events stay in local logs. Group-owner/admin exemption fails safe: if group facts cannot be fetched, the message is exempt rather than recalled. Message events older than five minutes are treated as stale and dropped — Feishu redelivers unacked events after restarts, and history is never re-judged or recalled.

### Profanity variant detection (谐音/缩写/变形)

`profanity.words`/`warnWords` matching is variant-tolerant (see `detectProfanityWord` in `src/ad-recall.js`):

- **Normalization**: NFKC full-width folding (`ｓｂ`→`sb`) and zero-width character stripping, applied on both matching paths.
- **Pure-latin words** (`sb`, `nmsl`, `cnm`…) match via a per-word separator-tolerant regex: up to 2 non-alphanumeric characters may sit between the letters (`n-m-s-l`, `n·m·s·l`, `n$m$s$l`, `s b`, `sha bi` all hit), with safe digit/symbol alternations only (`o0 l1 e3 a@ s$ i1` — so `nms1`→`nmsl`, `sh@bi`→`shabi`). The first-char boundary (`^|[^a-z0-9]`) prevents both substring false positives (`usb`, `class b`) and adjacent-token fusion (`cnm nmsl` hits both words independently). Digit alternations `5→s`/`8→b` are deliberately excluded from this path — they made `58元`/`5.8级`/`17:58`/`三星s8`/`5b铅笔` hit block-tier `sb` (recall + kick counting).
- **Mixed/CJK words** match on a fully normalized compact string: full leet map including `5→s/8→b` (`傻8`→`傻b`), all evasion separators stripped (`傻|逼`, `草#你#妈`), then the single-char homophone map `profanity.homophones` (`煞→傻`, `哔→逼`, `艹→操`, `淦→干`, `叼→吊`) — a hit still requires a **full word match** afterwards (`买支笔`, `煞有介事`, `哔哩哔哩` all pass).
- **Tiering for safety**: split-character words (`女马`, `尸八`) live in `warnWords` — block-tier substring matching would recall+kick innocent messages like `美女马上就到了` or `验尸，八小时`. Deliberately **not** in any list (left to AI context judgment): `尼玛` (Nima County), `莎碧` (name Sabina), `wtf` (wtfutil config dir `~/.wtf`), `nc` (netcat), `卧槽`-style exclamations, and pure-number homophones like `748` (prices/order numbers).

The moderation policy text lives in `config/moderation.json` (tracked in git; edit there, no redeploy needed) with precedence `MODERATION_POLICY` env > config file > built-in default — `/moderation` shows the active source. The policy includes variant-awareness rules and few-shot examples for homophone/abbreviation abuse. Evaluate changes offline first: `node scripts/eval-moderation.mjs --layer det` (word layer, free), `--layer pipeline` (production simulation: deterministic layer first, MA only sees what it passes — the same skip semantics as the live bot), `--layer ma` (MA alone, for A/B with `--policy old`). Cases live in `config/moderation-eval.jsonl` (67 cases incl. digit negatives and fusion regression anchors); reports go to `outputs/`. Exit code fails only on block-tier false positives or block-tier misses — warn-tier drift is reported but non-gating. The audit log (`logs/moderation-audit.jsonl`) records a truncated message `text` and samples ~10% of clean allows so false negatives can be mined later.

### QR-code image recall (`qrImage`)

`qr_code` also exists as an **image-level** strong rule: when a group member sends an image (standalone `image` messages and images embedded in `post` rich text), the bot downloads it and detects QR codes **locally on the bot host** — no model call, no content interpretation. Any detected QR code upgrades the message to `strong_ad` and goes through the exact same recall pipeline (brake, precheck, notice card, kick counters) as text ad features. Only the fact of detection is used; the decoded QR content is discarded inside the worker thread and never logged.

- Toggle with `qrImage` in `config/ad-recall.json`. `maxImageBytes` (default 10 MB) bounds downloads; `downloadTimeoutMs` (default 10 s) hard-caps the download phase; `timeoutMs` (default 4 s) caps detection per image; `maxDimension` (default 2000 px) is the downsampling threshold for the base scan; `maxImagesPerMessage` (default 4) bounds scans per post. Images whose declared dimensions exceed a 40-megapixel budget are skipped before decoding (`skipped=oversized`) — pngjs allocates `4·w·h` upfront with no cap, and a ~250 KB "small file, huge header" PNG could otherwise OOM the whole bot process.
- Detection runs in a throwaway worker thread with a hard timeout: image decoding/scan libraries are synchronous CPU work with pathological worst cases on noisy photos (measured 30 s+ on raw jsQR), so the worker is terminated at the budget and the image is treated as not-detected — never blocking the serial event queue.
- Dual engines with complementary failure modes: zbar-wasm (predictable time, strong on photos/tilted codes) scans the downscaled base (≤1600 px) and, for oversized images, a higher-resolution rescue pass at up to 2500 px — this pass is **not** bounded by `maxDimension`; jsQR (strong on clean screenshots, small modules, and inverted codes) scans the base as the last step. jsQR never sees images above `maxDimension`.
- Same exemptions as text rules: quoted replies, the bot admin, group owners/administrators, and failed-safe group-fact lookups are never QR-recalled. Known gaps: stickers (Feishu API cannot download sticker resources) and GIF/WebP images (unsupported formats are skipped and logged as `skipped=…`).
- Regression suite: `node scripts/qr-verify.mjs` exercises the real worker path (PNG/JPEG/grayscale/inverted, small QR in a huge image, noise timeout, WebP skip) and writes `outputs/qr-verify-report.json`.

## Group vote control

Only the group owner, group administrators, and the contacts.md bot admin may start a group vote. Any other member's vote message (`msg_type=vote`) is recalled automatically, and the bot posts a notice card in that group explaining the restriction.

- Reuses the ad-recall chat coverage (`allGroups` / allowed chats / `excludedChats`) and the same group-facts admin cache.
- Toggle with `voteControl.enabled` in `config/ad-recall.json` (defaults to `true`).
- Recalling another member's message requires the bot to be the group owner, administrator, or creator; failures are logged with the Feishu error code (e.g. 230026).
- If group facts cannot be fetched, the vote is exempt (never recalled) — fail-safe, same as the recall whitelist.

## Group reply policy

In group chats the bot only answers when @-mentioned (`config/reply-policy.json`, synced with git). Moderation and ad recall still run on **every** group message; direct messages and `/commands` are unaffected.

```json
{
  "groupRequireMention": true,
  "cannedReply": "收到～ 我是本群管理机器人，负责内容审核与秩序维护；有问题请 @管理员 或联系 bot 管理员。"
}
```

- `groupRequireMention` — reply in groups only when the bot is @-mentioned. Set to `false` to reply to every message.
- `cannedReply` — the fixed reply text. Edit it here; no redeploy of code is needed beyond a restart.

## Commands

| Command | Description | Access |
|---|---|---|
| `/help` | List commands | Allowed users |
| `/allow <open_id>` | Add an allowed user | Admin |
| `/remove <open_id>` | Remove an allowed user | Admin |
| `/users` | List allowed users | Admin |
| `/add-member @user` | Add a mentioned user to the current group | Admin |
| `/remove-member @user` | Preview removing a mentioned group member | Admin |
| `/remove-member confirm @user` | Remove a mentioned user from the current group | Admin |
| `/set-bot-admin` | Set the current bot as a group administrator | Admin |
| `/set-log-chat` | Set the current group as the admin log chat (audit trail + kick-confirm cards) | Admin |
| `/moderation` | Show AI moderation configuration | Admin |

`/set-bot-admin` calls `im/v1/chats/:chat_id/managers/add_managers` with the current bot's `app_id`. Feishu requires the app to have bot capability and the API permission, and the API caller must be the group owner when assigning administrators.

## Security notes

- Use a separate Feishu app for each bot; do not share production credentials between instances.
- Policy lives in `config/*.json` (git); secrets live only in `.env` / `.secrets/`.
- Enabling moderation sends group message text to the model provider. Review that against your data-handling policy.

## Deployment state

Docker keeps runtime state out of the application image:

| Container path | Purpose |
|---|---|
| `/data/contacts.md` | Runtime user/chat allowlist modified by `/allow` and `/remove` |
| `/root/.feishu-bot` | Feishu dedup state (`seen-events.json`) |
| `/app/logs`, `/app/outputs` | Logs and project-level generated files |

The `bot-data` volume owns `/data`; the `bot-home` volume owns `/root/.feishu-bot`.
The Zhipu key is mounted read-only at `/run/secrets/zhipu_key` (or set `ZHIPUAI_API_KEY`).
To migrate a deployment, stop the old container first, then move both volumes; the allowlist lives in `bot-data`.

## Verification tooling

- `node scripts/ma-verify.mjs --smoke` / `--latency N --json N` — latency and JSON-compliance benchmark for the ephemeral-session design (writes `outputs/ma-verify-report.json`).
- `node scripts/test-ma-moderation.mjs` — end-to-end dry-run of the moderation pipeline against the real MA backend (no Feishu connection).
