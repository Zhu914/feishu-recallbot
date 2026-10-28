// Feishu Bot Framework — Feishu WebSocket events × Codex sessions

import 'dotenv/config';
import lark from '@larksuiteoapi/node-sdk';
import { fileURLToPath } from 'url';
import { runCodexQuery } from './codex.js';
import { replyMessage, addReaction, deleteReaction, extractMessageText, extractAttachmentSpecs, downloadMessageFile, initFeishuClient, sendDirectMessage, getOriginalMessage, replyWithFile, extractMessageMentions, addChatMembers, removeChatMembers, addChatManagers, recallMessage, sendCardMessage, replyCardMessage, getBotOpenId } from './feishu.js';

import { startScheduler, reloadScheduler } from './scheduler.js';
import { initModeration, moderateMessage, getModerationStatus, moderationReasonLabel } from './moderation.js';
import { initAdRecall, isAdRecallCandidate, handleAdMessage, noteMemberJoined, isRecallExempt, handleKickCardAction, setAdminLogChat, buildRecallNoticeCard, isKickAdjudicator, handleVoteMessage } from './ad-recall.js';

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const defaultCwd = process.env.DEFAULT_CWD || process.cwd();
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
import { readFile, writeFile, mkdir, readdir, unlink, appendFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
const CONTACTS_FILE = process.env.CONTACTS_FILE || new URL('../session/knowledge/contacts.md', import.meta.url);
// 隔离到项目外，避免 Codex session 污染 VSCode
const BOT_HOME = join(homedir(), '.feishu-bot');
const WORKSPACE_ROOT = join(BOT_HOME, 'workspace');
const TEMP_FILE_DIR = join(tmpdir(), 'feishu-bot-files');
const fileCache = new Map(); // msg_id → { path, tempDir }（per-file 临时目录追踪）
const threadFiles = new Map(); // rootId → [{ path, name, msgId }]（话题级附件索引）

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

// ---- 知识库预加载（注入 prompt，不靠 Codex 自己读） ----
import { watchFile, unlinkSync, writeFileSync } from 'fs';
const STYLE_FILE_KB = new URL('../session/knowledge/style.md', import.meta.url);
const AGENTS_FILE = new URL('../AGENTS.md', import.meta.url);

let knowledgeContext = '';

async function loadKnowledge() {
  const parts = [];
  for (const [label, file] of [['身份与规则', AGENTS_FILE], ['回复风格', STYLE_FILE_KB], ['访问控制', CONTACTS_FILE]]) {
    try {
      const content = await readFile(file, 'utf-8');
      parts.push(`## ${label}\n${content}`);
    } catch {
      log('warn', 'knowledge', `${label} file not found`);
    }
  }
  knowledgeContext = parts.join('\n\n---\n\n');
  log('ok', 'knowledge', `loaded ${parts.length} file(s), ${knowledgeContext.length} chars`);
}

await loadKnowledge();

function buildPrompt(userMessage) {
  return `以下是机器人配置，回答时必须参考。

---

${knowledgeContext}

---

## 输出规则
生成的所有可返回文件必须保存到 outputs/ 目录，文件名包含主题和日期。禁止部署到外部仓库。用用户消息的主要语言回复，只输出最终结论和必要的下一步。

---

用户消息：
${userMessage}`;
}

initFeishuClient(appId, appSecret);
await initLog();

// 群聊回复策略：config/reply-policy.json（策略参数，随 git 同步；缺文件/缺键按内置默认值）
// groupRequireMention：群里只有 @机器人 才触发 AI 回复（审核/广告撤回仍逐条执行，不受影响）
// groupSessionFollowUp：已有会话的话题内追问视为继续对话，仍回复（避免多轮对话被打断）
let REPLY_POLICY = { groupRequireMention: true, groupSessionFollowUp: true };
try {
  const replyPolicyRaw = await readFile(new URL('../config/reply-policy.json', import.meta.url), 'utf-8');
  REPLY_POLICY = { ...REPLY_POLICY, ...JSON.parse(replyPolicyRaw) };
} catch {}
log('info', 'boot', `reply policy: groupRequireMention=${REPLY_POLICY.groupRequireMention}, groupSessionFollowUp=${REPLY_POLICY.groupSessionFollowUp}`);
initModeration(log);
initAdRecall({
  log,
  appId,
  adminOpenId: contactsCache.adminOpenId,
  isChatAllowed: (chatId) => contactsCache.chatIds.has(chatId),
});
log('ok', 'boot', `Feishu bot started, log dir=${LOG_DIR}`);

// 临时文件清理：启动时跑一次 + 每小时定时扫，删 mtime > 1 天的
const TEMP_FILE_MAX_AGE_MS = 24 * 3600000; // 1 天
const TEMP_FILE_CLEANUP_INTERVAL_MS = 3600000; // 1 小时扫一次
async function cleanupTempFiles() {
  const entries = await readdir(TEMP_FILE_DIR).catch(() => []);
  const now = Date.now();
  let cleaned = 0;
  for (const entry of entries) {
    try {
      const s = await stat(join(TEMP_FILE_DIR, entry));
      if (now - s.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
        await rm(join(TEMP_FILE_DIR, entry), { recursive: true, force: true });
        cleaned++;
      }
    } catch {}
  }
  if (cleaned > 0) log('ok', 'cleanup', `removed ${cleaned} stale temp dir(s) (>1d)`);
}
cleanupTempFiles();
setInterval(cleanupTempFiles, TEMP_FILE_CLEANUP_INTERVAL_MS);

// workspace 产物清理：每天扫，删各用户 outputs/ 下 mtime > 30 天的文件（不动 session/用户目录/子目录）
// 用「每天扫 + 30天规则」而非月频 setInterval：dev --watch 常重启，月频会被重置；每天扫效果等同月清且不受重启影响
const WORKSPACE_OUTPUT_MAX_AGE_MS = 30 * 86400000; // 30 天
const WORKSPACE_CLEANUP_INTERVAL_MS = 86400000; // 每天扫一次
async function cleanupWorkspaceOutputs() {
  const users = await readdir(WORKSPACE_ROOT).catch(() => []);
  const now = Date.now();
  let cleaned = 0;
  for (const ou of users) {
    if (ou.startsWith('.')) continue; // 跳过 .DS_Store 等
    const ouOutputs = join(WORKSPACE_ROOT, ou, 'outputs');
    const files = await readdir(ouOutputs).catch(() => []);
    for (const f of files) {
      try {
        const p = join(ouOutputs, f);
        const s = await stat(p);
        if (s.isFile() && now - s.mtimeMs > WORKSPACE_OUTPUT_MAX_AGE_MS) {
          await rm(p, { force: true });
          cleaned++;
        }
      } catch {}
    }
  }
  if (cleaned > 0) log('ok', 'cleanup', `workspace: removed ${cleaned} stale output file(s) (>30d)`);
}
cleanupWorkspaceOutputs();
setInterval(cleanupWorkspaceOutputs, WORKSPACE_CLEANUP_INTERVAL_MS);

// minutes/ 妙记转写缓存清理：每天扫，删项目内 minutes/ 下 >1 天的
const MINUTES_DIR = join(PROJECT_ROOT, 'minutes');
const MINUTES_MAX_AGE_MS = 86400000; // 1 天
async function cleanupMinutes() {
  const entries = await readdir(MINUTES_DIR).catch(() => []);
  const now = Date.now();
  let cleaned = 0;
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    try {
      const p = join(MINUTES_DIR, e);
      const s = await stat(p);
      if (now - s.mtimeMs > MINUTES_MAX_AGE_MS) {
        await rm(p, { recursive: true, force: true });
        cleaned++;
      }
    } catch {}
  }
  if (cleaned > 0) log('ok', 'cleanup', `minutes: removed ${cleaned} stale transcript(s) (>1d)`);
}
cleanupMinutes();
setInterval(cleanupMinutes, 86400000);

await loadSessions();

const FEISHU_MSG_LIMIT = 8000;
const HTML_OUTPUT_THRESHOLD = 3000; // 超过此长度自动转 HTML，不塞卡片
const OUTPUTS_DIR = join(PROJECT_ROOT, 'outputs');
const TYPING_EMOJI = 'Typing';

// 列出某 outputs/ 目录下所有文件（相对路径集合），用于识别本次会话新生成的文件
async function listOutputFiles(outputsDir) {
  const result = new Set();
  async function walk(dir, prefix) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), rel);
      else result.add(rel);
    }
  }
  await walk(outputsDir, '');
  return result;
}

// 长文本 → HTML 文件，保存到 outputs/（不再部署 github，由 deliverResult 发飞书文件）
async function generateHtmlFile(text, slug, outputsDir = OUTPUTS_DIR) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `${slug}-${date}.html`;

  // 简单 HTML 模板：markdown 渲染
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${slug}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 24px; line-height: 1.7; color: #1a1a1a; background: #fff; }
  h1 { border-bottom: 2px solid #e8e8e8; padding-bottom: 8px; }
  h2 { margin-top: 2em; color: #333; }
  h3 { color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 14px; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f5f7fa; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }
  hr { border: none; border-top: 1px solid #eee; margin: 2em 0; }
  blockquote { border-left: 3px solid #ddd; margin: 1em 0; padding: 0.5em 1em; color: #666; }
  code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-size: 0.9em; }
  strong { color: #111; }
  .meta { color: #999; font-size: 12px; margin-bottom: 2em; }
</style>
</head>
<body>
<div class="meta">Generated by Feishu Bot &middot; ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
${markdownToHtml(text)}
</body>
</html>`;

  // 保存到 outputs/
  await mkdir(outputsDir, { recursive: true });
  await writeFile(join(outputsDir, fileName), html, 'utf-8');
  log('ok', 'html-file', `saved ${fileName} (${text.length} chars)`);

  return fileName;
}

// 极简 markdown → HTML（只处理标题、表格、加粗、分隔线）
function markdownToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 表格
    if (/^\|(.+)\|$/.test(line.trim())) {
      if (/^\|[-:| ]+\|$/.test(line.trim())) continue; // 分隔行跳过
      if (!inTable) { out.push('<table>'); inTable = true; }
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      const tag = !out[out.length - 1] || out[out.length - 1] === '<table>' ? 'th' : 'td';
      out.push('<tr>' + cells.map(c => `<${tag}>${inlineMd(c)}</${tag}>`).join('') + '</tr>');
      continue;
    }
    if (inTable) { out.push('</table>'); inTable = false; }
    // 标题
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) { out.push(`<h${hm[1].length}>${inlineMd(hm[2])}</h${hm[1].length}>`); continue; }
    // 分隔线
    if (/^---+$/.test(line.trim())) { out.push('<hr>'); continue; }
    // 空行
    if (!line.trim()) { out.push(''); continue; }
    // 普通段落
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (inTable) out.push('</table>');
  return out.join('\n');
}

function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

// ---- Session 管理（持久化到磁盘，重启后恢复） ----
const sessions = new Map();
const SESSIONS_FILE = join(BOT_HOME, 'sessions.json');

const SESSION_MAX_AGE_MS = 3 * 86400000; // 3 天

const SESSIONS_AGENT = 'codex';

async function saveSessions() {
  const data = [];
  for (const [rootId, s] of sessions) {
    data.push({
      rootId,
      sessionId: s.sessionId,
      agent: SESSIONS_AGENT,
      openId: s.openId || '',
      title: s.title,
      cwd: s.cwd,
      updatedAt: Date.now(),
    });
  }
  await mkdir(BOT_HOME, { recursive: true }).catch(() => {});
  await writeFile(SESSIONS_FILE, JSON.stringify({ version: 2, agent: SESSIONS_AGENT, sessions: data }, null, 2)).catch(() => {});
}

async function loadSessions() {
  try {
    const raw = await readFile(SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // Version 1 was an array of Claude Code sessions. Those IDs cannot be
    // resumed by Codex, so deliberately start new Codex threads instead.
    const data = Array.isArray(parsed) ? [] : (parsed.sessions || []);
    const parsedAgent = Array.isArray(parsed) ? '' : parsed.agent;
    const now = Date.now();
    let expired = 0;
    let incompatible = 0;

    if (!parsedAgent || parsedAgent !== SESSIONS_AGENT) {
      incompatible = data.length;
    } else {
      for (const entry of data) {
        if (entry.updatedAt && now - entry.updatedAt > SESSION_MAX_AGE_MS) {
          expired++;
          continue;
        }
        const state = {
          sessionId: entry.sessionId,
          openId: entry.openId,
          cwd: entry.cwd || join(WORKSPACE_ROOT, entry.openId || 'anonymous'),
          status: 'idle',
          title: entry.title || '',
          abortController: null,
          attachments: [],
        };
        sessions.set(entry.rootId, state);
      }
    }

    log('ok', 'session', `restored ${sessions.size} session(s), expired ${expired}, incompatible ${incompatible}`);
    if (expired > 0 || incompatible > 0) await saveSessions();
  } catch {
    log('info', 'session', 'no saved sessions, starting fresh');
  }
}

function getSession(rootId) {
  return sessions.get(rootId);
}

async function createSession(rootId, openId = '') {
  const userDir = openId || 'anonymous';
  const userWorkspace = join(WORKSPACE_ROOT, userDir);
  await mkdir(userWorkspace, { recursive: true });

  // Link shared prompt resources into the workspace before the first Codex
  // process starts; otherwise spawn(cwd) can race with directory creation.
  const projectRoot = PROJECT_ROOT;
  const symlinks = [['skills', 'skills'], ['session/knowledge', 'knowledge'], ['AGENTS.md', 'AGENTS.md']];
  for (const [src, linkName] of symlinks) {
    const link = join(userWorkspace, linkName);
    const target = join(projectRoot, src);
    try {
      const st = await (await import('fs/promises')).lstat(link).catch(() => null);
      if (!st) {
        const { symlink } = await import('fs/promises');
        await symlink(target, link, 'junction');
        log('ok', 'symlink', `${linkName} → ${target}`);
      }
    } catch (e) {
      log('warn', 'symlink', `${linkName}: ${e.message}`);
    }
  }

  const state = { sessionId: null, openId, cwd: userWorkspace, status: 'idle', title: '', abortController: null, attachments: [] };
  sessions.set(rootId, state);
  saveSessions().catch(() => {});
  return state;
}

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
    case 'stop':
      if (state?.abortController) {
        state.abortController.abort();
        state.status = 'stopped';
        await replyMessage(msgId, '⏹ 已中止当前任务');
      } else {
        await replyMessage(msgId, '没有运行中的任务');
      }
      return true;
    case 'status': {
      const list = Array.from(sessions.entries()).map(([id, s]) => `[${s.status}] ${s.title.slice(0, 30)}`);
      await replyMessage(msgId, list.length ? `活跃 session (${list.length}):\n${list.join('\n')}` : '没有活跃 session');
      return true;
    }
    case 'help':
      await replyMessage(msgId, [
        '可用命令：',
        '/help — 查看命令列表',
        '/status — 查看活跃会话状态',
        '/stop — 中止当前话题中的任务',
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

// ---- 核心查询 ----
async function runAgentQuery(prompt, msgId, state) {
  if (state.status === 'running') {
    await replyMessage(msgId, '⏳ 上一个任务还在执行中，请等完成后再发');
    return;
  }

  state.status = 'running';

  let reactionId = null;
  addReaction(msgId, TYPING_EMOJI)
    .then(r => { reactionId = r?.reactionId; })
    .catch(() => {});

  const isResume = !!state.sessionId;
  log('info', isResume ? 'resume' : 'new', `${isResume ? `sid=${state.sessionId.slice(-8)} ` : ''}${prompt.length > 200 ? prompt.slice(0, 200) + '…' : prompt}`);
  state.lastPrompt = prompt;

  const abortController = new AbortController();
  state.abortController = abortController;

  const options = {
    cwd: state.cwd,
    abortController,
    model: process.env.CODEX_MODEL,
    sandboxMode: process.env.CODEX_SANDBOX_MODE || 'workspace-write',
  };

  if (state.sessionId) {
    options.resumeThreadId = state.sessionId;
  }

  let fullOutput = '';
  let gotResult = false;
  let hadRealOutput = false; // 是否已累积到真实 turn 文本（区分 result 事件被污染为错误文本的情况）

  // 输出路由：长文本转 HTML 文件，超长分段，否则发送卡片。
  // 正常完成与「Codex 进程异常退出但已拿到真实结果」的救回路径共用此函数
  async function deliverResult(text, newFiles) {
    const slugRaw = state.lastPrompt?.replace(/[^a-zA-Z0-9一-鿿]/g, '-').slice(0, 30).replace(/-+/g, '-').replace(/^-|-$/g, '') || 'report';
    const slug = /[a-zA-Z]/.test(slugRaw) ? slugRaw : `report-${Date.now().toString(36)}`;
    const sessionOutputs = join(state.cwd, 'outputs');

    // 待发文件（相对 session outputs/ 的路径）
    const files = [...(newFiles || [])];

    // 长文本：转成 HTML 文件一起发送
    if (text.length > HTML_OUTPUT_THRESHOLD) {
      try {
        files.push(await generateHtmlFile(text, slug, sessionOutputs));
      } catch (e) {
        log('warn', 'html-file', `generate failed: ${e.message?.slice(0, 150)}, fallback to text`);
      }
    }

    // 有文件 → 逐个飞书发文件
    if (files.length > 0) {
      let sent = 0;
      for (const rel of files) {
        try {
          await replyWithFile(msgId, join(sessionOutputs, rel));
          sent++;
          log('ok', 'reply-file', `sent outputs/${rel}`);
        } catch (e) {
          log('warn', 'reply-file', `${rel}: ${e.message?.slice(0, 120)}`);
        }
      }
      // 短文本附全文摘要；长文本已被转成 HTML 文件，只发简短提示
      const summary = (text && text !== '(no output)' && text.length <= HTML_OUTPUT_THRESHOLD)
        ? text.slice(0, 1500)
        : `📄 已发送 ${sent}/${files.length} 个文件`;
      await replyMessage(msgId, summary).catch(() => {});
      log('ok', 'reply', `files ${sent}/${files.length} sent`);
      return;
    }

    // 无文件 → 文本路由（分段 / 卡片）
    if (text.length > FEISHU_MSG_LIMIT) {
      const CHUNK = 7500;
      for (let i = 0; i < text.length; i += CHUNK) {
        await replyMessage(msgId, (i > 0 ? `[${i}/${text.length}] ` : '') + text.slice(i, i + CHUNK));
      }
    } else {
      await replyMessage(msgId, text || '(no output)');
    }
  }

  try {
    const beforeFiles = await listOutputFiles(join(state.cwd, 'outputs'));
    for await (const event of runCodexQuery({ prompt: buildPrompt(prompt), ...options, log })) {
      if (event.session_id && !state.sessionId) {
        state.sessionId = event.session_id;
        saveSessions().catch(() => {});
        log('ok', 'init', `threadId=${event.session_id}`);
      }

      // system.init
      if (event.type === 'system' && event.subtype === 'init') {
        log('info', 'init', `model=${event.model} tools=${event.tools?.length || 0} session=${event.session_id?.slice(-8) || 'n/a'}`);
      }

      // system.compact_boundary
      if (event.type === 'system' && event.subtype === 'compact_boundary') {
        log('dim', 'compact', `trigger=${event.compact_metadata?.trigger} pre_tokens=${event.compact_metadata?.pre_tokens} → post_tokens=${event.compact_metadata?.post_tokens}`);
      }

      // 流式块（逐字输出）
      if (event.type === 'stream_event' && event.event) {
        const e = event.event;
        if (e.type === 'content_block_delta') {
          const d = e.delta;
          if (d?.type === 'text_delta' && d.text) {
            process.stdout.write(d.text);
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            process.stdout.write(`\x1b[2m${d.thinking}\x1b[0m`);
          } else if (d?.type === 'input_json_delta' && d.partial_json) {
            // tool input 流式片段，静默忽略
          }
        }
      }

      // 完整 assistant 消息（一个 turn 结束）
      if (event.type === 'assistant' && event.message?.content) {
        const blocks = Array.isArray(event.message.content) ? event.message.content : [event.message.content];
        let turnText = '';
        let hasToolUse = false;
        const blockSummary = [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) {
            turnText += b.text;
            blockSummary.push(`text:${b.text.length}ch`);
          } else if (b.type === 'tool_use') {
            hasToolUse = true;
            const detail = b.input?.command || b.input?.url || b.input?.file_path || b.input?.query || b.input?.pattern || '';
            const inputKeys = Object.keys(b.input || {}).join(',');
            log('dim', 'tool', `${b.name}(${inputKeys}) → ${String(detail).slice(0, 150)}`);
            log('dim', 'tool-input', `[${b.id?.slice(-8)}] ${JSON.stringify(b.input).slice(0, 400)}`);
            blockSummary.push(`tool:${b.name}`);
          } else if (b.type === 'thinking' && b.thinking) {
            log('dim', 'thinking', b.thinking.slice(0, 300));
            blockSummary.push(`thinking:${b.thinking.length}ch`);
          }
        }
        log('dim', 'turn', `blocks=[${blockSummary.join(', ')}] hasTool=${hasToolUse}`);
        // 只保留最终回答：有 tool_use 的 turn 是中间步骤，文本丢弃
        // 没有 tool_use 的才是最终回答，覆盖式保留
        if (turnText.trim()) {
          if (hasToolUse) {
            log('dim', 'skip', `intermediate text (${turnText.length} chars): ${turnText.slice(0, 200)}`);
          } else if (gotResult) {
            log('warn', 'guard', `post-result text (${turnText.length} chars) discarded: ${turnText.slice(0, 200)}`);
          } else {
            fullOutput = turnText;
            hadRealOutput = true;
          }
        }
        process.stdout.write('\n');
      }

      // 工具执行结果
      if (event.type === 'user' && event.message?.content) {
        const blocks = Array.isArray(event.message.content) ? event.message.content : [event.message.content];
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            const content = typeof b.content === 'string' ? b.content
              : Array.isArray(b.content) ? b.content.map(c => c.text || '').join('')
              : '';
            const preview = content.slice(0, 500);
            const errFlag = b.is_error ? ' (ERROR)' : '';
            log('dim', `tool-result${errFlag}`, `[${b.tool_use_id?.slice(-8)}] ${content.length} chars → ${preview}${content.length > 500 ? '…' : ''}`);
            process.stdout.write(`\x1b[33m${preview}${content.length > 500 ? '...' : ''}\x1b[0m\n`);
          }
        }
      }

      if (event.type === 'result') {
        gotResult = true;
        log('ok', 'done', `subtype=${event.subtype} cost=$${event.total_cost_usd?.toFixed(4)} turns=${event.num_turns} duration=${event.duration_ms ? Math.round(event.duration_ms / 1000) + 's' : 'n/a'}`);
        log('dim', 'result-raw', event.result?.slice(0, 500) || '(empty)');
        if (event.result && !fullOutput) fullOutput = event.result;
      }
    }

    // 识别本次会话新生成的文件（outputs/ 前后快照对比）
    const afterFiles = await listOutputFiles(join(state.cwd, 'outputs'));
    const newFiles = [...afterFiles].filter(f => !beforeFiles.has(f));
    if (newFiles.length) log('info', 'files', `本次新生成 ${newFiles.length} 个: ${newFiles.join(', ').slice(0, 200)}`);

    // 有结果就当成功，即使进程 exit code 非 0
    if (gotResult && fullOutput) {
      state.status = 'done';
    } else if (!fullOutput) {
      fullOutput = '(no output)';
      state.status = 'done';
    } else {
      state.status = 'done';
    }

    // 输出路由：有文件发文件 / 长文本转 HTML 文件发 / 否则纯文本
    await deliverResult(fullOutput, newFiles);
    log('ok', 'reply', `delivered ${fullOutput.length} chars`);
  } catch (err) {
    if (abortController.signal.aborted) {
      state.status = 'stopped';
      log('ok', 'stop', 'query aborted by user');
    } else {
      state.status = 'error';
      // 飞书 SDK 错误结构：err.code / err.msg，Axios 层：err.response?.data
      const feishuCode = err.code || err.response?.data?.code || '';
      const feishuMsg = err.msg || err.response?.data?.msg || '';
      log('error', 'codex', `${err.message?.slice(0, 200)} | feishu_code=${feishuCode} feishu_msg=${feishuMsg}`);
      // 卡片发送 400 → 转成 HTML 文件发，兜底纯文本
      if (err.message?.includes('400') && fullOutput) {
        try {
          const slugRaw = state.lastPrompt?.replace(/[^a-zA-Z0-9一-鿿]/g, '-').slice(0, 30).replace(/-+/g, '-').replace(/^-|-$/g, '') || 'report';
          const slug = /[a-zA-Z]/.test(slugRaw) ? slugRaw : `report-${Date.now().toString(36)}`;
          const fn = await generateHtmlFile(fullOutput, slug, join(state.cwd, 'outputs'));
          await replyWithFile(msgId, join(state.cwd, 'outputs', fn));
          log('ok', 'reply-fallback', `card 400 → file sent: outputs/${fn}`);
        } catch (htmlErr) {
          log('warn', 'reply-fallback', `file send failed: ${htmlErr.message?.slice(0, 100)}, falling back to plain text`);
          try {
            const { replyTextMessage } = await import('./feishu.js');
            await replyTextMessage(msgId, fullOutput.slice(0, 4000));
            log('ok', 'reply-fallback', 'card 400 → plain text sent');
          } catch (fallbackErr) {
            log('error', 'reply', `fallback also failed: ${fallbackErr.message?.slice(0, 200)}`);
          }
        }
      } else if (hadRealOutput && fullOutput) {
        // 任务实际已成功（已累积到真实 turn 文本），只是 Codex 进程异常退出（如长连接被掐断）
        // → 救回已算出的结果，而不是把进程错误字符串发给用户
        log('warn', 'recover', `process error (${err.message?.slice(0, 120)}) but real result exists (${fullOutput.length} chars) — delivering result`);
        try {
          await deliverResult(fullOutput);
          state.status = 'done'; // 救回成功，状态与正常完成路径对齐（避免 /status 误标 error）
        } catch (deliveryErr) {
          // deliverResult 失败（如卡片 400）→ 纯文本兜底，对齐 400 分支的防御深度，避免静默无回复
          log('warn', 'reply', `recovery delivery failed: ${deliveryErr.message?.slice(0, 150)}, falling back to plain text`);
          try {
            const { replyTextMessage } = await import('./feishu.js');
            await replyTextMessage(msgId, fullOutput.slice(0, 4000));
            state.status = 'done';
          } catch (fallbackErr) {
            log('error', 'reply', `recovery fallback also failed: ${fallbackErr.message?.slice(0, 200)}`);
            // 保持 state.status = 'error'（751 行已设），如实反映交付失败
          }
        }
      } else {
        const errMsg = `Error: ${err.message?.slice(0, 200)}`;
        try {
          await replyMessage(msgId, errMsg);
        } catch {
          log('error', 'reply', 'replyMessage failed even for error message');
        }
      }
    }
  } finally {
    state.abortController = null;
    if (reactionId) {
      try { await deleteReaction(msgId, reactionId); } catch {}
    }
    // Temp files cleaned by startup cleanup (>2h old), not per-turn
    // session.attachments persists for session lifetime
  }
}

// Feishu can redeliver events when an event handler exceeds its acknowledgement
// window. Deduplicate by message_id at the entry point so retries cannot run
// moderation, Codex, file handling, or replies twice. The same protection also
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

    // 确定性规则（词表/广告/灰度）先于 AI 审核执行：命中即毫秒级处理，
    // 且已被词表提醒（warned）的消息跳过 AI 审核的重复提醒卡（同话题只发一张提醒卡）。
    let adWarned = false;
    if (isAdRecallCandidate({ chatType: msg.chat_type, senderType: data.sender?.sender_type, chatId: msg.chat_id })) {
      const adResult = await handleAdMessage({
        text: extractMessageText(data),
        messageId: msgId,
        chatId: msg.chat_id,
        chatType: msg.chat_type,
        senderOpenId: openId,
        senderName: name,
        createTime: Number(msg.create_time),
        isReply: !!msg.parent_id, // 引用/回复某条消息 → 白名单
        rawContent: rawMsg?.content || '',
        rootId: rootId || '',
      });
      if (adResult.blocked) return;
      adWarned = adResult.warned;
    }

    // Group moderation runs after chat authorization, but before attachments are
    // downloaded or the message is handed to Codex. By default only explicitly
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
        const blocked = await moderateMessage({
          text: extractMessageText(data),
          messageId: msgId,
          chatId: msg.chat_id,
          chatType: msg.chat_type,
          senderType: data.sender?.sender_type,
          senderOpenId: openId,
          recall: recallMessage,
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
        if (blocked) return;
      }
    }

    // 统一下载消息内附件（独立 image/file 消息 + post 富文本内嵌图片）
    // 必须在 text 检查之前：纯图片消息（无文字）也要下载缓存，等文字消息来了一起处理。
    // 飞书话题里图文混排是 post 消息，图片作为 {tag:'img',image_key} 内嵌，
    // extractAttachmentSpecs 会一并覆盖，避免话题里的图片读不到。
    const threadKey = rootId || msgId;
    const attSpecs = extractAttachmentSpecs(rawMsg);
    if (attSpecs.length > 0) {
      if (!threadFiles.has(threadKey)) threadFiles.set(threadKey, []);
      for (const spec of attSpecs) {
        try {
          const tempDir = join(TEMP_FILE_DIR, msgId);
          const filePath = await downloadMessageFile(msgId, spec.fileKey, spec.fileName, tempDir, spec.type);
          fileCache.set(msgId, { path: filePath, tempDir });
          threadFiles.get(threadKey).push({ path: filePath, name: spec.fileName, msgId });
          log('ok', 'file', `downloaded ${spec.fileName} → ${filePath} (thread=${threadKey.slice(-8)}, cached)`);
        } catch (err) {
          log('warn', 'file', `download failed (${spec.fileName}): ${err.message?.slice(0, 200)}`);
        }
      }
    }

    // 纯图片/文件独立消息：只缓存，不触发 AI（等后续文字消息）
    if (msgType === 'image' || msgType === 'file') {
      return;
    }

    const text = extractMessageText(data);
    if (!text) {
      log('warn', 'drop', `type=${msgType} msg=${msgId.slice(-8)} — extractMessageText returned empty`);
      return;
    }

    // Text messages: check for file attachments in this thread (supports multiple files + cross-turn persistence)
    let attachmentContext = '';
    const threadAtts = threadFiles.get(threadKey) || [];
    // 合并 session 级附件（跨轮持久化）
    const existingState = rootId ? getSession(rootId) : null;
    const sessionAtts = existingState?.attachments || [];
    const allAtts = [...threadAtts];
    for (const sa of sessionAtts) {
      if (!allAtts.some(a => a.path === sa.path)) allAtts.push(sa);
    }
    if (allAtts.length > 0) {
      const fileList = allAtts.map(f => `- ${f.name}: ${f.path}`).join('\n');
      // 纯文本模型（如 glm-5.2）Read 图片只会返回一个 URL、看不到内容；
      // 必须先 Read 拿 URL，再用 analyze_image 分析该 URL 才能识别图片。非图片文件直接 Read 即可。
      const hasImage = allAtts.some(f => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name));
      const imageHint = hasImage
        ? `\n其中含图片：Read 读图片只返回 URL（看不到内容），正确步骤是 ① Read 图片得到 URL ② 用 analyze_image 工具分析该 URL 提取图片内容。`
        : '';
      attachmentContext = `\n\n[用户在话题中发送了 ${allAtts.length} 个附件，已下载到本地：\n${fileList}${imageHint}\n请读取相关附件来回答用户的问题。]`;
    }

    const fullText = text + attachmentContext;
    log('info', 'recv', `${name} (${openId}) root=${rootId ? rootId.slice(-8) : 'new'}: ${fullText.length > 200 ? fullText.slice(0, 200) + '…' : fullText}`);

    const mentions = extractMessageMentions(rawMsg);
    const commandText = normalizeCommandText(text, mentions);
    const command = parseCommand(commandText);
    if (command) {
      const state = rootId ? getSession(rootId) : null;
      const handled = await handleCommand(command.cmd, command.args, msgId, state, openId, {
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
      !(await isBotMentioned(mentions)) &&
      !(REPLY_POLICY.groupSessionFollowUp && rootId && getSession(rootId))
    ) {
      log('dim', 'reply', `skip (bot not @-mentioned) msg=${msgId.slice(-8)} chat=${msg.chat_id?.slice(-8)}`);
      return;
    }
    let state;
    let topicOriginContext = ''; // topic 原始消息上下文
    if (rootId) {
      state = getSession(rootId);
      if (!state) {
        log('info', 'topic', `new topic detected, fullRootId=${rootId}`);
        state = await createSession(rootId, openId);
        // 新 topic：获取 rootId 对应的原始消息，注入到首次 prompt 中
        let originText = '';
        try {
          const originMsg = await getOriginalMessage(rootId, log);
          if (originMsg?.text) {
            topicOriginContext = `\n\n[话题原始消息：${originMsg.text}]`;
            originText = originMsg.text;
            log('ok', 'topic', `fetched origin msg for root=${rootId.slice(-8)}: ${originMsg.text.slice(0, 100)}`);
          } else {
            log('warn', 'topic', `origin msg empty or null for root=${rootId.slice(-8)}`);
          }
        } catch (err) {
          log('error', 'topic', `getOriginalMessage failed: ${err.message?.slice(0, 200)}`);
        }
        state.title = originText.slice(0, 50) || text.slice(0, 50);
      }
    } else {
      state = await createSession(msgId, openId);
      state.title = text.slice(0, 50);
    }

    // Merge thread attachments into session for cross-turn persistence
    if (!state.attachments) state.attachments = [];
    const currentThreadAtts = threadFiles.get(rootId || msgId) || [];
    for (const att of currentThreadAtts) {
      if (!state.attachments.some(a => a.path === att.path)) {
        state.attachments.push(att);
      }
    }

    let promptWithContext = fullText + topicOriginContext;
    Promise.resolve()
      .then(() => runAgentQuery(promptWithContext, msgId, state))
      .then(() => {
        // Thread attachments persist in session.attachments for cross-turn access
        // Temp files cleaned by startup sweep (>2h old)
        log('ok', 'file', `thread attachments preserved (${state.attachments?.length || 0} files in session)`);
      })
      .catch(err => log('error', 'fatal', err.message?.slice(0, 200)));
    })
      // 队列级兜底：单条消息处理异常不能让串行队列断链（否则后续所有消息都不再处理）
      .catch(err => log('error', 'event', `queue process failed msg=${msgId?.slice(-8)}: ${err.message?.slice(0, 200)}`));
  },
  // 新成员入群事件：为广告撤回模块提供“入群时间 < 24 小时”的新人判定依据
  // （需在飞书开放平台为应用订阅 im.chat.member.user.added_v1 事件）
  'im.chat.member.user.added_v1': async (data) => {
    noteMemberJoined(data);
  },
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

startScheduler({
  runAgentQuery: async (prompt) => {
    const state = { sessionId: null, cwd: defaultCwd, status: 'idle', title: prompt.slice(0, 50) };
    let output = '';
    for await (const event of runCodexQuery({
      prompt: buildPrompt(prompt),
      cwd: state.cwd,
      model: process.env.CODEX_MODEL,
      sandboxMode: process.env.CODEX_SANDBOX_MODE || 'workspace-write',
      log,
    })) {
      if (event.type === 'assistant' && event.message?.content) {
        const blocks = Array.isArray(event.message.content) ? event.message.content : [event.message.content];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) output = b.text;
        }
      }
      if (event.type === 'result' && event.result && !output) output = event.result;
    }
    return output;
  },
  sendMessage: async (userId, text) => {
    await sendDirectMessage(userId, text);
  },
});

// 监听 tasks.json 变化自动热加载
const TASKS_PATH = process.env.TASKS_FILE || join(PROJECT_ROOT, 'tasks.json');
watchFile(TASKS_PATH, { interval: 3000 }, () => {
  log('info', 'scheduler', 'tasks.json changed, reloading...');
  reloadScheduler().catch(err => log('error', 'scheduler', `reload failed: ${err.message}`));
});

// 监听 contacts.md 变化自动热加载权限缓存
watchFile(CONTACTS_FILE, { interval: 3000 }, () => {
  loadContacts().catch(err => log('error', 'auth', `contacts reload failed: ${err.message}`));
});

log('ok', 'boot', `Feishu bot ready (cwd=${defaultCwd})`);
