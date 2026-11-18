// Feishu Bot Framework — Feishu WebSocket events × MA moderation
// 主链路（agent 回答/附件/产物）已下线：回复为固定话术，模型仅用于消息审核（Managed Agents）。

import 'dotenv/config';
import lark from '@larksuiteoapi/node-sdk';
import { fileURLToPath } from 'url';
import { replyMessage, extractMessageText, initFeishuClient, sendDirectMessage, extractMessageMentions, addChatMembers, removeChatMembers, addChatManagers, recallMessage, sendCardMessage, replyCardMessage, getBotOpenId } from './feishu.js';

import { initModeration, moderateMessage, getModerationStatus, moderationReasonLabel } from './moderation.js';
import { initAdRecall, noteViolationAndMaybeAsk, isAdRecallCandidate, handleAdMessage, isRecallExempt, handleKickCardAction, setAdminLogChat, buildRecallNoticeCard, isKickAdjudicator, handleVoteMessage } from './ad-recall.js';

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
// Group-wide access keeps onboarding simple for bots that are deliberately added
// to a group. Direct messages still use the user allowlist.
const GROUP_ACCESS_ALL = process.env.GROUP_ACCESS_ALL === 'true';
const MODERATION_ALL_GROUPS = process.env.MODERATION_ALL_GROUPS === 'true';

if (!appId || !appSecret) { console.error('Missing FEISHU_APP_ID or FEISHU_APP_SECRET'); process.exit(1); }

// ---- 单例锁：启动时自动杀旧实例，防止多实例抢 WS ----
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PID_FILE = join(PROJECT_ROOT, '.feishu-bot.pid');
try {
  const oldPid = parseInt(await readFile(PID_FILE, 'utf-8').catch(() => '0'), 10);
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0); // throws if dead
      process.kill(oldPid, 'SIGTERM');
      console.log(`[singleton] killed stale PID=${oldPid}`);
      await new Promise(r => setTimeout(r, 1000));
      try { process.kill(oldPid, 0); process.kill(oldPid, 'SIGKILL'); } catch {}
    } catch {} // already dead, fine
  }
} catch {}
await writeFile(PID_FILE, String(process.pid)).catch(() => {});
process.on('exit', () => {
  try { unlinkSync(PID_FILE); } catch {}
  // 去重记录落盘：跨重启后仍能识别飞书重投递的旧事件（SEEN_EVENTS_FILE 定义在后，此处惰性引用）
  try { writeFileSync(SEEN_EVENTS_FILE, JSON.stringify([...eventSeen.entries()].map(([id, ts]) => ({ id, ts })))); } catch {}
});

// stdout EPIPE 兜底：父进程关闭管道时静默退出，不崩进程
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  console.error('Uncaught:', err);
});

// ---- 日志 ----
const LEVEL_STYLE = { info: '36m', ok: '32m', warn: '33m', error: '31m', dim: '2m' };
const LOG_DIR = join(PROJECT_ROOT, 'logs');
const LOG_RETAIN_DAYS = 1;
let logFile = '';

async function initLog() {
  await mkdir(LOG_DIR, { recursive: true });
  // 清理过期日志
  const cutoff = Date.now() - LOG_RETAIN_DAYS * 86400000;
  for (const f of await readdir(LOG_DIR).catch(() => [])) {
    if (!f.endsWith('.log')) continue;
    const fileTime = new Date(f.replace('.log', '')).getTime();
    if (fileTime && fileTime < cutoff) {
      await unlink(join(LOG_DIR, f)).catch(() => {});
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  logFile = join(LOG_DIR, `${date}.log`);
}

function log(level, tag, msg) {
  const now = new Date();
  const ts = now.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ms = String(now.getTime() % 1000).padStart(3, '0');
  const c = LEVEL_STYLE[level] || LEVEL_STYLE.info;
  console.log(`\x1b[${c}${ts}.${ms}\x1b[0m [${tag}] ${msg}`);
  // 实时写入日志文件
  if (logFile) {
    const line = `${now.toISOString()} [${level.toUpperCase()}] [${tag}] ${msg}\n`;
    appendFile(logFile, line).catch(() => {});
  }
}

// Handle termination while retaining the singleton PID-file cleanup hook.
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ---- 权限管理（从 contacts.md 读取，单一数据源） ----
import { readFile, writeFile, readdir, unlink, appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
const CONTACTS_FILE = process.env.CONTACTS_FILE || new URL('../session/knowledge/contacts.md', import.meta.url);
// 隔离到项目外（历史遗留：曾用于 Codex workspace；现在只放 seen-events.json 等运行时状态）
const BOT_HOME = join(homedir(), '.feishu-bot');

let contactsCache = { openIds: new Set(), chatIds: new Set(), adminOpenId: '' };

function parseContacts(content) {
  const openIds = new Set();
  const chatIds = new Set();
  let adminOpenId = '';
  let m;
  const reOu = /open_id:\s*(ou_\w+)/g;
  while ((m = reOu.exec(content)) !== null) openIds.add(m[1]);
  const reChat = /chat_id:\s*(oc_\w+)/g;
  while ((m = reChat.exec(content)) !== null) chatIds.add(m[1]);
  const mySection = content.match(/## Admin[\s\S]*?open_id:\s*(ou_\w+)/);
  if (mySection) adminOpenId = mySection[1];
  return { openIds, chatIds, adminOpenId };
}

async function loadContacts() {
  try {
    contactsCache = parseContacts(await readFile(CONTACTS_FILE, 'utf-8'));
    log('info', 'auth', `${contactsCache.openIds.size} contact(s), admin=${contactsCache.adminOpenId || 'NOT DETECTED'}`);
  } catch {
    log('warn', 'auth', 'contacts.md not found');
  }
}

await loadContacts();

function isAdmin(openId) { return openId === contactsCache.adminOpenId; }
function isAllowed(openId, chatId, chatType) {
  if (GROUP_ACCESS_ALL && chatType === 'group') return true;
  if (chatId && contactsCache.chatIds.has(chatId)) return true;
  return contactsCache.openIds.has(openId);
}

async function addContact(openId) {
  if (contactsCache.openIds.has(openId)) return false;
  const entry = `\n### ${openId}\n- open_id: ${openId}\n- auto_reply: never\n`;
  await writeFile(CONTACTS_FILE, entry, { flag: 'a' });
  contactsCache.openIds.add(openId);
  return true;
}

async function removeContact(openId) {
  if (!contactsCache.openIds.has(openId) || isAdmin(openId)) return false;
  const content = await readFile(CONTACTS_FILE, 'utf-8');
  const updated = content.replace(
    new RegExp(`\\n### [^\\n]+\\n(?:- [^\\n]+\\n)+`, 'g'),
    (block) => block.includes(`open_id: ${openId}`) ? '' : block
  );
  await writeFile(CONTACTS_FILE, updated);
  contactsCache.openIds.delete(openId);
  return true;
}

import { watchFile, unlinkSync, writeFileSync } from 'fs';

initFeishuClient(appId, appSecret);
await initLog();

// 群聊回复策略：config/reply-policy.json（策略参数，随 git 同步；缺文件/缺键按内置默认值）
// groupRequireMention：群里只有 @机器人 才回复（审核/广告撤回仍逐条执行，不受影响）
// cannedReply：固定话术（主链路 agent 已下线，回复不再由模型生成；文案随时可改，无需发版）
let REPLY_POLICY = {
  groupRequireMention: true,
  cannedReply: '收到～ 我是本群管理机器人，负责内容审核与秩序维护；有问题请 @管理员 或联系 bot 管理员。',
};
try {
  const replyPolicyRaw = await readFile(new URL('../config/reply-policy.json', import.meta.url), 'utf-8');
  REPLY_POLICY = { ...REPLY_POLICY, ...JSON.parse(replyPolicyRaw) };
} catch {}
log('info', 'boot', `reply policy: groupRequireMention=${REPLY_POLICY.groupRequireMention}, cannedReply=${String(REPLY_POLICY.cannedReply).slice(0, 30)}…`);
initModeration(log);
initAdRecall({
  log,
  appId,
  adminOpenId: contactsCache.adminOpenId,
  isChatAllowed: (chatId) => contactsCache.chatIds.has(chatId),
});
log('ok', 'boot', `Feishu bot started, log dir=${LOG_DIR}`);

// ---- 命令处理 ----
function parseCommand(text) {
  if (!text.startsWith('/')) return null;
  const parts = text.slice(1).split(/\s+/);
  return { cmd: parts[0].toLowerCase(), args: parts.slice(1).join(' ') };
}

// 群里常见写法是 @机器人 /command，这里只移除命令前方的 mention 占位符。
// 是否 @ 了本机器人：与 bot 自身 open_id（getBotOpenId，bot/v3/info）比对。
// 拿不到机器人 ID 时按“未 @”处理并留痕一次：宁可漏回，也不误回。
let botMentionWarned = false;
async function isBotMentioned(mentions) {
  const botOpenId = await getBotOpenId();
  if (!botOpenId) {
    if (!botMentionWarned) {
      log('warn', 'reply', '无法获取机器人 open_id（bot/v3/info），群聊 @ 识别暂不可用，先按未 @ 处理');
      botMentionWarned = true;
    }
    return false;
  }
  botMentionWarned = false;
  return mentions.some((m) => m.openId === botOpenId);
}

function normalizeCommandText(text, mentions = []) {
  let normalized = text.trim();
  for (const mention of mentions) {
    const tokens = [mention.key, mention.openId ? `@${mention.openId}` : '', mention.name ? `@${mention.name}` : '']
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const token of tokens) {
      if (normalized.startsWith(token)) {
        normalized = normalized.slice(token.length).trim();
        return normalized;
      }
    }
  }
  return normalized;
}

function resolveMemberTargets(args, mentions = []) {
  if (!args.trim()) return [];

  const byOpenId = new Map();
  for (const id of args.match(/ou_[A-Za-z0-9]+/g) || []) {
    byOpenId.set(id, { openId: id, name: id });
  }

  for (const mention of mentions) {
    const tokens = [mention.key, mention.openId ? `@${mention.openId}` : '', mention.name ? `@${mention.name}` : '']
      .filter(Boolean);
    if (tokens.some(token => args.includes(token))) {
      byOpenId.set(mention.openId, mention);
    }
  }

  return [...byOpenId.values()];
}

function memberActionSummary(targets, result, action) {
  const names = targets.map(target => target.name && target.name !== target.openId ? `${target.name} (${target.openId})` : target.openId);
  const invalid = result?.invalid_id_list || [];
  const notExisted = result?.not_existed_id_list || [];
  const pending = result?.pending_approval_id_list || [];

  if (invalid.length || notExisted.length) {
    return [
      `部分用户未能${action}。`,
      invalid.length ? `无效用户: ${invalid.join(', ')}` : '',
      notExisted.length ? `不存在用户: ${notExisted.join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }

  const pendingNote = pending.length
    ? `\n以下用户需等待审批: ${pending.join(', ')}`
    : '';
  return `已提交${action}: ${names.join(', ')}${pendingNote}`;
}

// adminOnly 包裹器：非管理员执行时返回提示
function adminOnly(handler) {
  return async (args, msgId, state, openId, context = {}) => {
    if (!isAdmin(openId)) {
      await replyMessage(msgId, '⛔ 仅管理员可执行此命令');
      return true;
    }
    return handler(args, msgId, state, openId, context);
  };
}

const adminCommands = {
  allow: async (args, msgId) => {
    const target = args.trim();
    if (!target) {
      await replyMessage(msgId, '用法: /allow <open_id>\n查看 open_id: 终端日志里的 (ou_xxx)');
      return true;
    }
    const added = await addContact(target);
    await replyMessage(msgId, added ? `已添加 ${target}` : `${target} 已在联系人中`);
    return true;
  },
  remove: async (args, msgId) => {
    const target = args.trim();
    if (!target) {
      await replyMessage(msgId, '用法: /remove <open_id>');
      return true;
    }
    if (isAdmin(target)) {
      await replyMessage(msgId, '不能移除管理员（## 我）');
      return true;
    }
    const removed = await removeContact(target);
    await replyMessage(msgId, removed ? `已移除 ${target}` : `${target} 不在联系人中`);
    return true;
  },
  'moderation': async (_args, msgId) => {
    const status = getModerationStatus();
    await replyMessage(msgId, [
      '消息审核配置：',
      `enabled: ${status.enabled}`,
      `mode: ${status.mode}`,
      `engine: ${status.engine}`,
      `model: ${status.model}`,
      `policy_source: ${status.policySource} (${status.policyLength}字)`,
      `confidence_threshold: ${status.confidenceThreshold}`,
      `timeout_ms: ${status.timeoutMs}`,
      `concurrency: ${status.concurrency}`,
      `group_only: ${status.groupOnly}`,
      `notify_admin: ${status.notifyAdmin}`,
      `rules_prefilter: ${status.rulesPrefilter}`,
      `keyword_rules: ${status.keywordCount}`,
      `regex_rules: ${status.regexCount}`,
      `exempt_users: ${status.exemptOpenIdCount}`,
      `audit_file: ${status.auditFile}`,
    ].join('\n'));
    return true;
  },
  users: async (_args, msgId) => {
    const lines = [...contactsCache.openIds].map(id =>
      `${id}${id === contactsCache.adminOpenId ? ' (admin)' : ''}`
    );
    await replyMessage(msgId, `联系人 (${lines.length}):\n${lines.join('\n')}`);
    return true;
  },
  'add-member': async (args, msgId, _state, _openId, { chatId, chatType, mentions } = {}) => {
    if (chatType !== 'group' || !chatId) {
      await replyMessage(msgId, '只能在群聊中使用 /add-member');
      return true;
    }
    const targets = resolveMemberTargets(args, mentions);
    if (targets.length === 0) {
      await replyMessage(msgId, '用法: /add-member @用户\n也可以使用: /add-member <open_id>');
      return true;
    }

    try {
      const result = await addChatMembers(chatId, targets.map(target => target.openId));
      await replyMessage(msgId, memberActionSummary(targets, result, '添加'));
      log('ok', 'chat-members', `add ${targets.length} member(s) to ${chatId}`);
    } catch (err) {
      log('error', 'chat-members', `add failed: ${err.message?.slice(0, 200)}`);
      await replyMessage(msgId, `添加群成员失败: ${err.message?.slice(0, 200)}`);
    }
    return true;
  },
  'set-bot-admin': async (_args, msgId, _state, _openId, { chatId, chatType } = {}) => {
    if (chatType !== 'group' || !chatId) {
      await replyMessage(msgId, '只能在群聊中使用 /set-bot-admin');
      return true;
    }

    try {
      await addChatManagers(chatId, [appId], 'app_id');
      await replyMessage(msgId, `已提交将机器人设为群管理员: ${appId}`);
      log('ok', 'chat-managers', `set bot ${appId} as manager in ${chatId}`);
    } catch (err) {
      log('error', 'chat-managers', `set bot manager failed: ${err.message?.slice(0, 200)}`);
      await replyMessage(msgId, `设置机器人管理员失败: ${err.message?.slice(0, 200)}`);
    }
    return true;
  },
  'set-log-chat': async (_args, msgId, _state, _openId, { chatId, chatType } = {}) => {
    if (chatType !== 'group' || !chatId) {
      await replyMessage(msgId, '只能在群聊中使用 /set-log-chat');
      return true;
    }

    try {
      await setAdminLogChat(chatId);
      await replyMessage(msgId, '✅ 已将本群设为管理员日志群\n撤回留痕与踢出确认卡片将发送到这里（config/ad-recall.json 已更新）');
    } catch (err) {
      log('error', 'ad-recall', `set-log-chat failed: ${err.message?.slice(0, 200)}`);
      await replyMessage(msgId, `设置失败: ${err.message?.slice(0, 200)}`);
    }
    return true;
  },
  'remove-member': async (args, msgId, _state, _openId, { chatId, chatType, mentions } = {}) => {
    if (chatType !== 'group' || !chatId) {
      await replyMessage(msgId, '只能在群聊中使用 /remove-member');
      return true;
    }

    const confirmRemoved = args.trim().startsWith('confirm');
    const targetArgs = confirmRemoved ? args.trim().slice('confirm'.length).trim() : args.trim();
    const targets = resolveMemberTargets(targetArgs, mentions);
    if (targets.length === 0) {
      await replyMessage(msgId, '用法: /remove-member @用户\n确认执行: /remove-member confirm @用户');
      return true;
    }
    if (!confirmRemoved) {
      await replyMessage(msgId, `即将移除: ${targets.map(target => target.name || target.openId).join(', ')}\n如确认，请发送 /remove-member confirm @用户`);
      return true;
    }

    try {
      const result = await removeChatMembers(chatId, targets.map(target => target.openId));
      await replyMessage(msgId, memberActionSummary(targets, result, '移除'));
      log('ok', 'chat-members', `remove ${targets.length} member(s) from ${chatId}`);
    } catch (err) {
      log('error', 'chat-members', `remove failed: ${err.message?.slice(0, 200)}`);
      await replyMessage(msgId, `移除群成员失败: ${err.message?.slice(0, 200)}`);
    }
    return true;
  },
};

async function handleCommand(cmd, args, msgId, state, openId, context = {}) {
  // 管理员专属命令
  if (adminCommands[cmd]) {
    return adminOnly(adminCommands[cmd])(args, msgId, state, openId, context);
  }
  switch (cmd) {
    case 'help':
      await replyMessage(msgId, [
        '可用命令：',
        '/help — 查看命令列表',
        '',
        '管理员命令：',
        '/allow <open_id> — 添加用户到白名单',
        '/remove <open_id> — 从白名单移除用户',
        '/users — 查看白名单用户列表',
        '/add-member @用户 — 添加群成员',
        '/remove-member @用户 — 预览要移除的群成员',
        '/remove-member confirm @用户 — 移除群成员',
        '/set-bot-admin — 将当前机器人设为群管理员',
        '/set-log-chat — 将本群设为管理员日志群（留痕/踢出卡片发到这里）',
        '/moderation — 查看消息审核配置',
      ].join('\n'));
      return true;
    default: return false;
  }
}


// Feishu can redeliver events when an event handler exceeds its acknowledgement
// window. Deduplicate by message_id at the entry point so retries cannot run
// moderation, recalls, or replies twice. The same protection also
// prevents duplicate moderation audits/recalls.
// 去重记录持久化到磁盘：飞书对未 ACK 事件的重投递可持续数小时（实测 8 小时后仍在重投，
// 且常发生在电脑睡眠唤醒、WS 重连之后），仅靠内存缓存在进程重启后失效，必须以磁盘为准。
const eventSeen = new Map();
const EVENT_SEEN_LIMIT = 50000;
const EVENT_SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const SEEN_EVENTS_FILE = join(BOT_HOME, 'seen-events.json');

async function loadSeenEvents() {
  try {
    const saved = JSON.parse(await readFile(SEEN_EVENTS_FILE, 'utf-8'));
    let restored = 0;
    for (const { id, ts } of Array.isArray(saved) ? saved : []) {
      if (id && ts && Date.now() - ts < EVENT_SEEN_TTL_MS) { eventSeen.set(id, ts); restored++; }
    }
    if (restored) log('ok', 'dedup', `restored ${restored} seen message id(s)`);
  } catch {}
}
await loadSeenEvents();

let seenFlushTimer = null;
function scheduleSeenFlush() {
  if (seenFlushTimer) return;
  seenFlushTimer = setTimeout(async () => {
    seenFlushTimer = null;
    const data = [...eventSeen.entries()].map(([id, ts]) => ({ id, ts }));
    await writeFile(SEEN_EVENTS_FILE, JSON.stringify(data)).catch(() => {});
  }, 5000);
  seenFlushTimer.unref?.();
}

function isDuplicateEvent(messageId) {
  if (!messageId) return false;
  const now = Date.now();

  // Map iteration order is insertion order; expire old entries without a full scan.
  while (eventSeen.size > 0) {
    const [oldestId, seenAt] = eventSeen.entries().next().value;
    if (now - seenAt < EVENT_SEEN_TTL_MS) break;
    eventSeen.delete(oldestId);
  }

  if (eventSeen.has(messageId)) return true;
  eventSeen.set(messageId, now);
  scheduleSeenFlush();
  if (eventSeen.size > EVENT_SEEN_LIMIT) {
    const oldestId = eventSeen.keys().next().value;
    eventSeen.delete(oldestId);
  }
  return false;
}

// ---- 飞书事件 ----
const noop = async () => {};

// 消息事件串行处理队列：见 im.message.receive_v1 handler 内注释（快速 ACK，防重投递）
let messageEventQueue = Promise.resolve();
const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const rawMsg = data?.message;
    const msg = data.message;
    const msgId = msg.message_id;
    const rootId = msg.root_id;
    const openId = data.sender?.sender_id?.open_id || '';
    const name = data.sender?.sender_id?.name || openId.slice(-8);
    const msgType = rawMsg?.message_type;

    if (isDuplicateEvent(msgId)) {
      log('warn', 'duplicate', `ignored redelivered message=${msgId?.slice(-8)}`);
      return;
    }

    // 历史消息丢弃：飞书 WS 在重连/重启后会重投递未确认的旧事件，只处理“新”消息
    // （超过 5 分钟的按历史对待——不判定、不撤回、不计数）
    const STALE_EVENT_MAX_AGE_MS = 5 * 60 * 1000;
    // 兼容秒（10 位）/毫秒（13 位）两种时间戳；取不到时放行并留痕，
    // 由持久化去重（seen-events.json）兜底跨进程/长延迟重投递
    const rawCreateTime = Number(msg.create_time);
    const msgCreateTime = rawCreateTime >= 1e12 ? rawCreateTime : rawCreateTime > 0 ? rawCreateTime * 1000 : 0;
    if (!msgCreateTime) {
      log('warn', 'drop', `event without usable create_time msg=${msgId?.slice(-8)} — 依赖持久化去重兜底`);
    } else if (Date.now() - msgCreateTime > STALE_EVENT_MAX_AGE_MS) {
      const age = Math.round((Date.now() - msgCreateTime) / 1000);
      log('info', 'drop', `stale event msg=${msgId?.slice(-8)} age=${age}s — 忽略历史消息，不判定不撤回`);
      return;
    }

    // 快速 ACK：SDK 只在 handler 的 Promise 完结后才发送 ACK 响应帧。此前 AI 审核/撤回等
    // 耗时逻辑把 ACK 拖到数十秒后甚至进程重启，飞书判定投递失败后错峰重投递同一事件
    // （实测 8 小时后仍在重投；电脑睡眠唤醒后，下午的旧事件在凌晨集中涌入 → “幽灵撤回”风暴）。
    // 这里把耗时处理串行入队后立即返回，ACK 秒回；队列按到达顺序串行执行。
    messageEventQueue = messageEventQueue.then(async () => {
    // Authorization must happen before message content is logged or attachments are downloaded.
    if (!isAllowed(openId, msg.chat_id, msg.chat_type)) {
      log('warn', 'block', `${name} (${openId}) chat=${msg.chat_id?.slice(-8) || 'p2p'} not in contacts`);
      return;
    }

    log('info', 'debug', `type=${msgType} content_length=${(rawMsg?.content || '').length}`);

    // 群投票管控：仅群主/群管理员可发起群投票（msg_type=vote，content 为 {"topic","options"}），
    // 非群主/管理员发起 → 撤回并群内提醒。投票消息不进入审核/AI 链路。
    if (msgType === 'vote') {
      await handleVoteMessage({
        messageId: msgId,
        chatId: msg.chat_id,
        chatType: msg.chat_type,
        senderOpenId: openId,
        senderName: name,
        senderType: data.sender?.sender_type,
        rawContent: rawMsg?.content || '',
        rootId: rootId || '',
      });
      return;
    }

    // 确定性规则（词表/广告/灰度/接龙）先于 AI 审核执行，且对【所有消息类型】生效：
    // 接龙是 interactive 卡片、识别靠 rawContent（"tag":"join_list" 等），不依赖文本。
    // 命中即毫秒级处理；已被词表提醒（warned）的消息跳过 AI 审核的重复提醒卡。
    let adWarned = false;
    if (isAdRecallCandidate({ chatType: msg.chat_type, senderType: data.sender?.sender_type, chatId: msg.chat_id })) {
      const adResult = await handleAdMessage({
        text: extractMessageText(data),
        messageId: msgId,
        chatId: msg.chat_id,
        chatType: msg.chat_type,
        senderOpenId: openId,
        senderName: name,
        // createTime 必须传归一化后的毫秒时间戳：飞书事件 create_time 是秒级，
        // 秒级值进了滑动窗口会把「5 分钟去重窗」拉长成 ~83 小时（misfire duplicate_burst）
        createTime: msgCreateTime,
        isReply: !!msg.parent_id, // 引用/回复某条消息 → 白名单
        rawContent: rawMsg?.content || '',
        rootId: rootId || '',
        msgType, // 图片二维码检测（qrImage）需要知道消息类型以提取图片资源
      });
      if (adResult.blocked) return;
      adWarned = adResult.warned;
    }

    // 非文本类消息（图片/文件/表情/卡片/分享等）在确定性规则之后拦截：它们的可提取文本
    // 只是占位符（[图片]/[附件:…]）或空串，进 AI 审核只会白花一次 MA 会话并拖慢串行队列。
    // 注意必须放在 ad-recall 之后——接龙等卡片消息的识别靠 rawContent，发生在上面。
    if (msgType !== 'text' && msgType !== 'post') return;

    // Group moderation runs after chat authorization, but before attachments are
    // downloaded or the message reaches the canned reply. By default only explicitly
    // approved chats are moderated; MODERATION_ALL_GROUPS opts in to every group
    // event received by this bot. It does not bypass message authorization.
    const shouldModerateGroup =
      (MODERATION_ALL_GROUPS && msg.chat_type === 'group') ||
      contactsCache.chatIds.has(msg.chat_id);
    // 词表已提醒（灰度词命中）→ 词表判定优先：跳过 AI 审核。
    // 灰度词的语义是「只提醒不撤回」，不允许 AI 层再补发卡片或升级为撤回。
    if (adWarned) {
      log('dim', 'moderation', `skip (ad-recall 已提醒，词表优先) msg=${msgId?.slice(-8)}`);
    } else if (shouldModerateGroup && data.sender?.sender_type === 'user') {
      // 机器人管理员/群主/群管理员豁免（与 ad-recall 同源；群信息不可用时也保守豁免，避免误撤）
      if (openId === contactsCache.adminOpenId || await isRecallExempt(msg.chat_id, openId)) {
        log('dim', 'moderation', `skip (whitelist: 群管理员/群主) msg=${msgId?.slice(-8)} from=${name}(${openId.slice(-8)})`);
      } else {
        let moderationRecalled = false; // AI 审核实际撤回成功时置位；失败/低置信/降级不计入踢出计数
        const blocked = await moderateMessage({
          text: extractMessageText(data),
          messageId: msgId,
          chatId: msg.chat_id,
          chatType: msg.chat_type,
          senderType: data.sender?.sender_type,
          senderOpenId: openId,
recall: async (mid) => { await recallMessage(mid); moderationRecalled = true; },
          // 撤回/提醒卡片统一改为「话题内回复」（root 优先，已撤回消息回复失败时降级群发），不再单独刷屏
          sendRecallNotice: async (classification) => {
            try {
              await replyCardMessage(rootId || msgId, buildRecallNoticeCard(moderationReasonLabel(classification)));
            } catch {
              await sendCardMessage(msg.chat_id, buildRecallNoticeCard(moderationReasonLabel(classification)));
            }
          },
          // AI 审核提醒档（置信度 0.7~0.9）：只发提醒卡片不撤回，文案带“疑似”前缀
          sendWarnNotice: async (classification) => {
            const card = buildRecallNoticeCard(`疑似${moderationReasonLabel(classification)}，请注意言辞`, '⚠️ 群消息提醒');
            try {
              await replyCardMessage(rootId || msgId, card);
            } catch {
              await sendCardMessage(msg.chat_id, card);
            }
          },
          notifyAdmin: contactsCache.adminOpenId
            ? async (message) => sendDirectMessage(contactsCache.adminOpenId, message)
            : undefined,
          log,
        });
        if (blocked) {
          // AI 审核撤回成功 → 与广告撤回同源，计入踢出双窗口（10分钟3次/24小时8次）
          if (moderationRecalled) {
            await noteViolationAndMaybeAsk({ chatId: msg.chat_id, senderOpenId: openId, senderName: name, reason: 'moderation', text: extractMessageText(data) });
          }
          return;
        }
      }
    }

    // 防御性兜底：非 text/post 类型已在上方拦截，这里再挡一道空文本。
    const text = extractMessageText(data);
    if (!text) {
      log('warn', 'drop', `type=${msgType} msg=${msgId.slice(-8)} — extractMessageText returned empty`);
      return;
    }

    log('info', 'recv', `${name} (${openId}) root=${rootId ? rootId.slice(-8) : 'new'}: ${text.length > 200 ? text.slice(0, 200) + '…' : text}`);

    const mentions = extractMessageMentions(rawMsg);
    const commandText = normalizeCommandText(text, mentions);
    const command = parseCommand(commandText);
    if (command) {
      const handled = await handleCommand(command.cmd, command.args, msgId, null, openId, {
        chatId: msg.chat_id,
        chatType: msg.chat_type,
        mentions,
      });
      if (handled) return;
    }

    // 群聊“仅 @ 才回复”：审核（moderateMessage）与广告撤回（handleAdMessage）在上方
    // 已对所有群消息执行完毕，不受此处拦截影响；私聊与 /command 指令同样不受影响。
    if (
      msg.chat_type === 'group' &&
      REPLY_POLICY.groupRequireMention &&
      !(await isBotMentioned(mentions))
    ) {
      log('dim', 'reply', `skip (bot not @-mentioned) msg=${msgId.slice(-8)} chat=${msg.chat_id?.slice(-8)}`);
      return;
    }

    // 固定话术回复（主链路 agent 已下线；文案在 config/reply-policy.json 的 cannedReply，可随时改）
    replyMessage(msgId, String(REPLY_POLICY.cannedReply || ''))
      .then(() => log('ok', 'reply', `canned reply sent msg=${msgId.slice(-8)}`))
      .catch(err => log('error', 'reply', `canned reply failed: ${err.message?.slice(0, 200)}`));
    })
      // 队列级兜底：单条消息处理异常不能让串行队列断链（否则后续所有消息都不再处理）
      .catch(err => log('error', 'event', `queue process failed msg=${msgId?.slice(-8)}: ${err.message?.slice(0, 200)}`));
  },
  // 新成员入群事件订阅已于 2026-11-17 移除（新人判定/营销词规则下线，广告意图交 AI 审核判断）
  // 踢出确认卡片的按钮回调；操作者必须是 bot 管理员（contacts.md Admin）
  'card.action.trigger': async (data) => {
    try {
      const operatorId = data?.operator?.open_id || '';
      const operatorName = data?.operator?.nick_name || operatorId.slice(-8);
      const value = data?.action?.value || {};
      if (value.adk !== 'kick' && value.adk !== 'ignore') return; // 非本模块卡片，忽略
      // 裁决人：bot 管理员，或管理员日志群内的成员/群管理员（工作人员在日志群里点卡片裁决）
      if (!(await isKickAdjudicator(operatorId))) {
        log('warn', 'ad-recall', `卡片操作被拒绝：非 bot 管理员/日志群工作人员 operator=${operatorId?.slice(-8)}`);
        return { toast: { type: 'error', content: '仅 bot 管理员或日志群工作人员可操作' } };
      }
      const result = await handleKickCardAction({ caseId: value.caseId, action: value.adk, operatorOpenId: operatorId, operatorName });
      log(result.ok ? 'ok' : 'warn', 'ad-recall', `卡片操作 ${value.adk} case=${String(value.caseId).slice(-6)} → ${result.msg}`);
      return { toast: { type: result.ok ? 'success' : 'error', content: result.msg } };
    } catch (err) {
      log('error', 'ad-recall', `卡片回调异常: ${err.message?.slice(0, 200)}`);
      return { toast: { type: 'error', content: '处理异常，请查看日志' } };
    }
  },
  'im.message.reaction.created_v1': noop,
  'im.message.reaction.deleted_v1': noop,
});

// ---- WS Supervisor：SDK 重试耗尽后重建 WSClient，指数退避 ----
let wsDownSince = null;
const WS_CHECK_INTERVAL = 60 * 1000;
const WS_BACKOFF_BASE = 2000;   // 初始 2s
const WS_BACKOFF_MAX = 30000;   // 上限 30s

function createWSClient() {
  return new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.warn,
    onReady() {
      log('ok', 'ws', 'connected');
    },
    onReconnecting() {
      if (!wsDownSince) {
        wsDownSince = Date.now();
        log('warn', 'ws', 'connection lost, reconnecting...');
      }
    },
    onReconnected() {
      const downTime = wsDownSince ? Math.round((Date.now() - wsDownSince) / 1000) : 0;
      log('ok', 'ws', `reconnected (was down ${downTime}s)`);
      wsDownSince = null;
    },
  });
}

async function wsSupervisor() {
  let attempt = 0;
  while (true) {
    const client = createWSClient();
    await new Promise((resolve) => {
      client.start({
        eventDispatcher,
        onError(err) {
          log('error', 'ws', `SDK retry exhausted: ${err.message}, recreating client (attempt ${attempt + 1})`);
          resolve();
        },
      });
    });
    // onError fired → SDK gave up, recreate with backoff
    try { client.close({ force: true }); } catch {}
    wsDownSince = Date.now();
    attempt++;
    const delay = Math.min(WS_BACKOFF_BASE * Math.pow(1.8, attempt - 1), WS_BACKOFF_MAX)
      * (0.75 + Math.random() * 0.5); // jitter
    log('warn', 'ws', `recreating WSClient in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    await new Promise(r => setTimeout(r, delay));
  }
}

wsSupervisor();

// 安全兜底：如果 supervisor 本身卡死，5 分钟后仍断连则告警（不再 exit）
setInterval(() => {
  if (wsDownSince && Date.now() - wsDownSince > 5 * 60 * 1000) {
    const elapsed = Math.round((Date.now() - wsDownSince) / 60000);
    log('error', 'ws', `still offline after ${elapsed}min — supervisor should be retrying`);
  }
}, WS_CHECK_INTERVAL);

// 监听 contacts.md 变化自动热加载权限缓存
watchFile(CONTACTS_FILE, { interval: 3000 }, () => {
  loadContacts().catch(err => log('error', 'auth', `contacts reload failed: ${err.message}`));
});

log('ok', 'boot', 'Feishu bot ready (moderation-only: 固定话术回复 + MA 审核)');
