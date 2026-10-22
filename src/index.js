// Feishu Bot Framework — Feishu WebSocket events × Claude Code sessions

import 'dotenv/config';
import lark from '@larksuiteoapi/node-sdk';
import { query } from '@anthropic-ai/claude-code';
import { replyMessage, addReaction, deleteReaction, extractMessageText, extractAttachmentSpecs, downloadMessageFile, initFeishuClient, sendDirectMessage, getOriginalMessage, replyWithFile } from './feishu.js';

import { startScheduler, reloadScheduler } from './scheduler.js';

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const defaultCwd = process.env.DEFAULT_CWD || process.cwd();

if (!appId || !appSecret) { console.error('Missing FEISHU_APP_ID or FEISHU_APP_SECRET'); process.exit(1); }

// ---- 单例锁：启动时自动杀旧实例，防止多实例抢 WS ----
const PID_FILE = join(new URL('..', import.meta.url).pathname, '.feishu-bot.pid');
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
process.on('exit', () => { try { unlinkSync(PID_FILE); } catch {} });

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
const LOG_DIR = join(new URL('..', import.meta.url).pathname, 'logs');
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
const CONTACTS_FILE = new URL('../session/knowledge/contacts.md', import.meta.url);
// 隔离到项目外，避免 Claude Code session 污染 VSCode
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
function isAllowed(openId, chatId) {
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

// ---- 知识库预加载（注入 prompt，不靠 Claude 自己读） ----
import { watchFile, unlinkSync } from 'fs';
const STYLE_FILE_KB = new URL('../session/knowledge/style.md', import.meta.url);
const STYLE_FILE = new URL('../session/CLAUDE.md', import.meta.url);

let knowledgeContext = '';

async function loadKnowledge() {
  const parts = [];
  for (const [label, file] of [['身份与规则', STYLE_FILE], ['回复风格', STYLE_FILE_KB], ['访问控制', CONTACTS_FILE]]) {
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
const MINUTES_DIR = join(new URL('..', import.meta.url).pathname, 'minutes');
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
const OUTPUTS_DIR = join(new URL('..', import.meta.url).pathname, 'outputs');
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

async function saveSessions() {
  const data = [];
  for (const [rootId, s] of sessions) {
    data.push({ rootId, sessionId: s.sessionId, openId: s.openId || '', title: s.title, cwd: s.cwd, updatedAt: Date.now() });
  }
  await mkdir(BOT_HOME, { recursive: true }).catch(() => {});
  await writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2)).catch(() => {});
}

async function loadSessions() {
  try {
    const raw = await readFile(SESSIONS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const now = Date.now();
    let expired = 0;
    for (const entry of data) {
      if (entry.updatedAt && now - entry.updatedAt > SESSION_MAX_AGE_MS) { expired++; continue; }
      const state = {
        sessionId: entry.sessionId,
        openId: entry.openId,
        cwd: entry.cwd || join(WORKSPACE_ROOT, entry.openId || 'anonymous'),
        status: 'idle',
        title: entry.title || '',
        abortController: null,
      };
      sessions.set(entry.rootId, state);
    }
    log('ok', 'session', `restored ${data.length - expired} session(s), expired ${expired}`);
    if (expired > 0) await saveSessions();
  } catch {
    log('info', 'session', 'no saved sessions, starting fresh');
  }
}

function getSession(rootId) {
  return sessions.get(rootId);
}

function createSession(rootId, openId = '') {
  const userDir = openId || 'anonymous';
  const userWorkspace = join(WORKSPACE_ROOT, userDir);
  mkdir(userWorkspace, { recursive: true }).then(async () => {
    // symlink 项目配置到 workspace，让 Claude Code SDK 能发现 .claude/、skills/、knowledge/
    const projectRoot = new URL('..', import.meta.url).pathname;
    const symlinks = [['.claude', '.claude'], ['skills', 'skills'], ['session/knowledge', 'knowledge']];
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
      } catch (e) { log('warn', 'symlink', `${linkName}: ${e.message}`); }
    }
  }).catch(() => {});

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

// adminOnly// adminOnly 包裹器：非管理员执行时返回提示
function adminOnly(handler) {
  return async (args, msgId, state, openId) => {
    if (!isAdmin(openId)) {
      await replyMessage(msgId, '⛔ 仅管理员可执行此命令');
      return true;
    }
    return handler(args, msgId, state, openId);
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
  users: async (_args, msgId) => {
    const lines = [...contactsCache.openIds].map(id =>
      `${id}${id === contactsCache.adminOpenId ? ' (admin)' : ''}`
    );
    await replyMessage(msgId, `联系人 (${lines.length}):\n${lines.join('\n')}`);
    return true;
  },
};

async function handleCommand(cmd, args, msgId, state, openId) {
  // 管理员专属命令
  if (adminCommands[cmd]) {
    return adminOnly(adminCommands[cmd])(args, msgId, state, openId);
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
      ].join('\n'));
      return true;
    default: return false;
  }
}

// ---- 核心查询 ----
async function runClaudeQuery(prompt, msgId, state) {
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
    permissionMode: process.env.CLAUDE_PERMISSION_MODE || 'default',
    abortController,
    disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'],
    pathToClaudeCodeExecutable: process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude',
    appendSystemPrompt: 'Use the conversation language. Answer with the final result and only necessary next steps. If required parameters are missing, ask a concise clarifying question instead of guessing.',
    includePartialMessages: true,
  };

  if (state.sessionId) {
    options.resume = state.sessionId;
  }

  let fullOutput = '';
  let gotResult = false;
  let hadRealOutput = false; // 是否已累积到真实 turn 文本（区分 result 事件被污染为错误文本的情况）

  // 输出路由：长文本转 HTML 文件，超长分段，否则发送卡片。
  // 正常完成与「Claude 进程异常退出但已拿到真实结果」的救回路径共用此函数
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
    for await (const event of query({ prompt: buildPrompt(prompt), options })) {
      if (event.session_id && !state.sessionId) {
        state.sessionId = event.session_id;
        saveSessions().catch(() => {});
        log('ok', 'init', `sessionId=${event.session_id}`);
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
      log('ok', 'reply', `${fullOutput.length} chars`);
    } else if (!fullOutput) {
      fullOutput = '(no output)';
      state.status = 'done';
    } else {
      state.status = 'done';
    }

    // 输出路由：有文件发文件 / 长文本转 HTML 文件发 / 否则卡片
    await deliverResult(fullOutput, newFiles);
  } catch (err) {
    if (abortController.signal.aborted) {
      state.status = 'stopped';
      log('ok', 'stop', 'query aborted by user');
    } else {
      state.status = 'error';
      // 飞书 SDK 错误结构：err.code / err.msg，Axios 层：err.response?.data
      const feishuCode = err.code || err.response?.data?.code || '';
      const feishuMsg = err.msg || err.response?.data?.msg || '';
      log('error', 'claude', `${err.message?.slice(0, 200)} | feishu_code=${feishuCode} feishu_msg=${feishuMsg}`);
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
        // 任务实际已成功（已累积到真实 turn 文本），只是 Claude 进程异常退出（如长连接被掐断）
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

// ---- 飞书事件 ----
const noop = async () => {};
const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const rawMsg = data?.message;
    const msg = data.message;
    const msgId = msg.message_id;
    const rootId = msg.root_id;
    const openId = data.sender?.sender_id?.open_id || '';
    const name = data.sender?.sender_id?.name || openId.slice(-8);
    const msgType = rawMsg?.message_type;
    log('info', 'debug', `type=${msgType} content=${(rawMsg?.content || '').slice(0, 300)}`);

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

    if (!isAllowed(openId, msg.chat_id)) {
      log('warn', 'block', `${name} (${openId}) chat=${msg.chat_id?.slice(-8) || 'p2p'} not in contacts`);
      return;
    }

    const command = parseCommand(text);
    if (command) {
      const state = rootId ? getSession(rootId) : null;
      const handled = await handleCommand(command.cmd, command.args, msgId, state, openId);
      if (handled) return;
    }

    let state;
    let topicOriginContext = ''; // topic 原始消息上下文
    if (rootId) {
      state = getSession(rootId);
      if (!state) {
        log('info', 'topic', `new topic detected, fullRootId=${rootId}`);
        state = createSession(rootId, openId);
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
      state = createSession(msgId, openId);
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
      .then(() => runClaudeQuery(promptWithContext, msgId, state))
      .then(() => {
        // Thread attachments persist in session.attachments for cross-turn access
        // Temp files cleaned by startup sweep (>2h old)
        log('ok', 'file', `thread attachments preserved (${state.attachments?.length || 0} files in session)`);
      })
      .catch(err => log('error', 'fatal', err.message?.slice(0, 200)));
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
  runClaudeQuery: async (prompt) => {
    const state = { sessionId: null, cwd: defaultCwd, status: 'idle', title: prompt.slice(0, 50) };
    let output = '';
    for await (const event of query({
      prompt: buildPrompt(prompt),
      options: {
        cwd: state.cwd,
        permissionMode: process.env.CLAUDE_PERMISSION_MODE || 'default',
        disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'],
        pathToClaudeCodeExecutable: process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude',
        appendSystemPrompt: 'Use the conversation language. Answer with the final result and only necessary next steps. If required parameters are missing, ask a concise clarifying question instead of guessing.',
      },
    })) {
      if (event.type === 'assistant' && event.message?.content) {
        const blocks = Array.isArray(event.message.content) ? event.message.content : [event.message.content];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) output += b.text;
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
const TASKS_PATH = new URL('../tasks.json', import.meta.url).pathname;
watchFile(TASKS_PATH, { interval: 3000 }, () => {
  log('info', 'scheduler', 'tasks.json changed, reloading...');
  reloadScheduler().catch(err => log('error', 'scheduler', `reload failed: ${err.message}`));
});

// 监听 contacts.md 变化自动热加载权限缓存
watchFile(CONTACTS_FILE, { interval: 3000 }, () => {
  loadContacts().catch(err => log('error', 'auth', `contacts reload failed: ${err.message}`));
});

log('ok', 'boot', `Feishu bot ready (cwd=${defaultCwd})`);
