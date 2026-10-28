// 自动广告撤回模块（ad-recall）
// 链路：index.js im.message.receive_v1 → isAdRecallCandidate → handleAdMessage
//   ├─ classifyMessage：分级识别 strong_ad / weak_ad / normal
//   ├─ 权限预检：群信息（owner_id / bot_manager_id_list）仅作参考；预检不通过仍直接尝试撤回，以飞书 API 真实结果为准
//   ├─ 动作路由：strong_ad → 撤回 + 群内警示卡片；weak_ad → 群内警示卡片（不撤回）；normal → 无动作
//   ├─ 安全刹车：同一 sender 5 分钟内被自动撤回 ≥ 3 次后暂停撤回（仅记本地日志）
//   └─ 留痕：管理员日志群只接收踢出确认卡片；撤回原因在违规群内就地提示，不带消息摘要
//
// 配置：config/ad-recall.json（策略参数，非机密，随 git 同步；缺文件时按 enabled=false 兜底）。
// 计数器为进程内存实现（Map + 滑动窗口）；多实例部署时可替换为 Redis。

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getClient, recallMessageDetailed, removeChatMembers, sendCardMessage, updateCardMessage } from './feishu.js';

// DELETE /open-apis/im/v1/messages/{message_id} 重点关注错误码
const RECALL_ERROR_HINTS = {
  230026: '机器人没有权限撤回该消息（需为群主/管理员/群创建者，或只能撤回自己发送的消息）',
  230009: '消息发出时间过长，超出企业设置的撤回时限',
  230050: '该消息对当前操作者不可见',
};

const REASON_LABELS = {
  non_whitelist_link: '包含非白名单域名链接',
  phone_number: '包含手机号',
  wechat_id: '包含微信号',
  qr_code: '包含二维码',
  duplicate_burst: '5分钟内相同文本发送≥3次',
  marketing_newcomer: '营销词汇+入群不足24小时',
  solitaire: '发起接龙（本群禁止）',
};

const DEFAULT_DOMAIN_WHITELIST = 'feishu.cn,feishu.com,larksuite.com,larkoffice.com';
const DEFAULT_MARKETING_WORDS = [
  '优惠', '促销', '特价', '秒杀', '限时', '折扣', '免费领', '免费送', '加微信', '加我',
  '私聊', '兼职', '刷单', '日结', '高薪', '引流', '获客', '代购', '一手货源', '低息',
  '贷款', '办证', '开发票', '推广', '招商', '招代理',
];

let config = {
  enabled: false,
  domainWhitelist: [],
  internalTerms: [],
  marketingWords: DEFAULT_MARKETING_WORDS,
  duplicateWindowMs: 5 * 60 * 1000,
  duplicateThreshold: 3,
  newcomerMs: 24 * 3600 * 1000,
  brakeWindowMs: 5 * 60 * 1000,
  brakeLimit: 3,
  chatFactsTtlMs: 5 * 60 * 1000,
  excludedChats: [],
  kick: {
    enabled: false,
    burstThreshold: 3,
    burstWindowMs: 10 * 60 * 1000,
    dailyThreshold: 8,
    dailyWindowMs: 24 * 3600 * 1000,
    maxPendingCases: 10,
  },
};

let ctx = {
  log: () => {},
  appId: '',
  adminOpenId: '',
  adminLogChatId: '',
  allGroups: false,
  isChatAllowed: () => false,
};

function splitList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

// 策略配置文件：config/ad-recall.json（随 git 同步）；缺文件或缺键时使用内置默认值
const CONFIG_FILE = new URL('../config/ad-recall.json', import.meta.url);

export function initAdRecall({ log = () => {}, appId = '', adminOpenId = '', isChatAllowed = () => false } = {}) {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    log('warn', 'ad-recall', err.code === 'ENOENT'
      ? 'config/ad-recall.json 不存在，按内置默认值初始化（enabled=false）'
      : `config/ad-recall.json 解析失败，按内置默认值初始化：${err.message.slice(0, 120)}`);
  }
  ctx = {
    log,
    appId,
    adminOpenId,
    adminLogChatId: String(fileConfig.adminLogChatId || ''),
    allGroups: fileConfig.allGroups === true,
    isChatAllowed,
  };
  config = {
    ...config,
    enabled: fileConfig.enabled === true,
    domainWhitelist: fileConfig.domainWhitelist?.length ? fileConfig.domainWhitelist : splitList(DEFAULT_DOMAIN_WHITELIST),
    internalTerms: fileConfig.internalTerms || [],
    marketingWords: fileConfig.marketingWords?.length ? fileConfig.marketingWords : DEFAULT_MARKETING_WORDS,
    duplicateWindowMs: Number(fileConfig.duplicateWindowMs) || 5 * 60 * 1000,
    duplicateThreshold: Number(fileConfig.duplicateThreshold) || 3,
    newcomerMs: (Number(fileConfig.newcomerHours) || 24) * 3600 * 1000,
    brakeWindowMs: Number(fileConfig.brakeWindowMs) || 5 * 60 * 1000,
    brakeLimit: Number(fileConfig.brakeLimit) || 3,
    excludedChats: Array.isArray(fileConfig.excludedChats) ? fileConfig.excludedChats.filter(c => typeof c === 'string' && c.startsWith('oc_')) : [],
    kick: {
      enabled: fileConfig.kick?.enabled === true,
      burstThreshold: Number(fileConfig.kick?.burstThreshold) || 3,
      burstWindowMs: Number(fileConfig.kick?.burstWindowMs) || 10 * 60 * 1000,
      dailyThreshold: Number(fileConfig.kick?.dailyThreshold) || 8,
      dailyWindowMs: Number(fileConfig.kick?.dailyWindowMs) || 24 * 3600 * 1000,
      maxPendingCases: Number(fileConfig.kick?.maxPendingCases) || 10,
    },
  };
  log('info', 'ad-recall', `initialized enabled=${config.enabled} allGroups=${ctx.allGroups} ` +
    `whitelistDomains=${config.domainWhitelist.length} internalTerms=${config.internalTerms.length} ` +
    `marketingWords=${config.marketingWords.length} ` +
    `adminLog=${ctx.adminLogChatId ? ctx.adminLogChatId.slice(-8) : (adminOpenId ? 'admin-dm' : 'NONE')}`);
  log('info', 'ad-recall',
    '新人判定依赖 im.chat.member.user.added_v1 事件（需在开放平台订阅），未收到入群事件的成员按非新人处理');
  loadKickCases();
  return config;
}

// /set-log-chat 命令：运行时更新管理员日志群并持久化到 config/ad-recall.json
export function setAdminLogChat(chatId) {
  if (!chatId?.startsWith('oc_')) throw new Error('invalid chat_id');
  let fileConfig = {};
  try { fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
  fileConfig.adminLogChatId = chatId;
  writeFileSync(CONFIG_FILE, JSON.stringify(fileConfig, null, 2) + '\n');
  ctx.adminLogChatId = chatId;
  ctx.log('ok', 'ad-recall', `adminLogChatId 已更新并持久化 → oc_...${chatId.slice(-8)}`);
}

// ---------- 是否进入广告识别（入口门控） ----------
export function isAdRecallCandidate({ chatType, senderType, chatId }) {
  return config.enabled
    && chatType === 'group'
    && senderType === 'user'
    && !!chatId
    && !config.excludedChats.includes(chatId)
    && (ctx.allGroups || ctx.isChatAllowed(chatId));
}

// ---------- 文本特征检测 ----------
const TLDS = new Set(['com', 'cn', 'net', 'org', 'cc', 'top', 'xyz', 'vip', 'shop', 'club', 'online',
  'site', 'icu', 'link', 'io', 'ai', 'app', 'pro', 'live', 'info', 'biz', 'store', 'ltd', 'group',
  'tech', 'wiki', 'me', 'tv', 'co']);

function extractHosts(text) {
  const hosts = new Set();
  const re = /(?:https?:\/\/|www\.)?([a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)+)(?:[:/?#]\S*)?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const host = m[1].toLowerCase();
    if (TLDS.has(host.split('.').pop())) hosts.add(host);
  }
  return hosts;
}

function hasNonWhitelistLink(text) {
  for (const host of extractHosts(text)) {
    const whitelisted = config.domainWhitelist.some(d => host === d || host.endsWith(`.${d}`));
    if (!whitelisted) return host;
  }
  return '';
}

// 手机号：先去分隔符（137 1234 5678 / 137-1234-5678），带边界防误拼
function hasPhoneNumber(text) {
  const compact = text.replace(/[\s\-_.·]/g, '');
  return /(?<!\d)(?:\+?86)?1[3-9]\d{9}(?!\d)/.test(compact) || /(?<!\d)400\d{7}(?!\d)/.test(compact);
}

const WECHAT_ID_RE = /(?:微信号|微信|weixin|wechat|vx|v信|薇信|威信|wx)\s*(?:号|:|：|=)?\s*[a-zA-Z][a-zA-Z0-9_-]{5,19}\b/i;
const QR_HINT_RE = /(二维码|扫码|扫一扫|qrcode|qr\s?code|qr码)/i;

function hasWechatId(text) { return WECHAT_ID_RE.test(text); }

// 二维码检测说明：不做图像识别，以“文本中出现二维码/扫码等提示词”为准
// （广告通常会配套“扫码加群/扫码领福利”等文案；纯二维码图片无文字时不触发强特征）
function hasQrCodeHint(text) { return QR_HINT_RE.test(text); }

function containsAny(text, words) {
  const lower = text.toLowerCase();
  return words.some(w => w && lower.includes(w.toLowerCase()));
}

function normalizeForHash(text) {
  return String(text || '').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

function stableHash(text) {
  return createHash('sha1').update(normalizeForHash(text)).digest('hex').slice(0, 16);
}

function summarize(text, len = 50) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, len);
}

// ---------- 滑动窗口计数器（内存实现；多实例可替换为 Redis） ----------
const duplicateHistory = new Map(); // `${chatId}|${senderId}|${hash}` → timestamps[]
const brakeHistory = new Map();     // senderId → timestamps[]（实际撤回成功时间）

function pushAndCount(map, key, ts, windowMs) {
  const kept = (map.get(key) || []).filter(t => ts - t < windowMs);
  kept.push(ts);
  map.set(key, kept);
  return kept.length;
}

function countRecent(map, key, now, windowMs) {
  return (map.get(key) || []).filter(t => now - t < windowMs).length;
}

// ---------- 入群时间跟踪（事件 im.chat.member.user.added_v1 提供） ----------
const joinTimes = new Map(); // `${chatId}|${openId}` → joinedAt(ms)

export function noteMemberJoined(data) {
  const chatId = data?.chat_id || '';
  const users = Array.isArray(data?.users) ? data.users : [];
  let noted = 0;
  for (const u of users) {
    const openId = u?.member_id || u?.open_id || '';
    if (chatId && openId.startsWith('ou_')) {
      joinTimes.set(`${chatId}|${openId}`, Date.now());
      noted++;
    }
  }
  if (noted > 0) ctx.log('info', 'ad-recall', `noted ${noted} member(s) joined chat=${chatId.slice(-8)}`);
}

// ---------- 群信息 / 权限预检（缓存） ----------
// botCanRecall 判定：机器人是群主（owner_id === appId）或群管理员（bot_manager_id_list 含 appId），
// 且群成员接口 is_in_chat 确认机器人仍在群内。
const chatFactsCache = new Map(); // chatId → { fetchedAt, ok, facts }

async function getChatFacts(chatId) {
  const cached = chatFactsCache.get(chatId);
  if (cached && Date.now() - cached.fetchedAt < config.chatFactsTtlMs) return cached;

  const entry = { fetchedAt: Date.now(), ok: false, botCanRecall: false, botInChat: false, adminUserIds: new Set(), chatName: '', memberNames: new Map() };
  try {
    const client = getClient();
    const [chatResp, inChatResp] = await Promise.all([
      client.im.chat.get({ path: { chat_id: chatId }, params: { user_id_type: 'open_id' } }).catch(() => null),
      client.im.chatMembers.isInChat({ path: { chat_id: chatId } }).catch(() => null),
    ]);
    const chat = chatResp?.data || {};
    entry.chatName = chat.name || '';
    // 成员名单（open_id → 姓名），用于把通知里的 ID 显示为自然语言姓名
    try {
      let pageToken = '';
      do {
        const membersResp = await client.request({
          method: 'GET',
          url: `/open-apis/im/v1/chats/${chatId}/members`,
          params: { member_id_type: 'open_id', page_size: 100, page_token: pageToken },
        });
        for (const m of membersResp?.data?.items || []) {
          if (m.member_id) entry.memberNames.set(m.member_id, m.name || '');
        }
        pageToken = membersResp?.data?.page_token || '';
      } while (pageToken);
    } catch {}
    entry.botInChat = inChatResp?.data?.is_in_chat !== false;
    entry.botIsOwner = chat.owner_id === ctx.appId && !!ctx.appId;
    entry.botIsAdmin = Array.isArray(chat.bot_manager_id_list) && !!ctx.appId && chat.bot_manager_id_list.includes(ctx.appId);
    entry.adminUserIds = new Set(chat.user_manager_id_list || []);
    if (chat.owner_id && chat.owner_id !== ctx.appId) entry.adminUserIds.add(chat.owner_id);
    // 接口成功：严格按角色判定；接口失败：ok=false，由调用方决定是否降级放行（交给撤回接口报错兜底）
    entry.ok = !!(chatResp || inChatResp);
    if (chatResp && inChatResp) {
      entry.botCanRecall = entry.botInChat && (entry.botIsOwner || entry.botIsAdmin);
    } else if (chatResp) {
      entry.botCanRecall = entry.botIsOwner || entry.botIsAdmin;
    }
    chatFactsCache.set(chatId, entry);
  } catch (err) {
    ctx.log('warn', 'ad-recall', `chat facts fetch failed chat=${chatId?.slice(-8)}: ${err.message?.slice(0, 150)}`);
    chatFactsCache.set(chatId, entry);
  }
  return entry;
}

// ---------- 通知文案辅助：ID → 自然语言 ----------
async function describeSender(chatId, senderOpenId, senderName = '') {
  const facts = await getChatFacts(chatId);
  const name = facts.memberNames?.get(senderOpenId) || '';
  if (name) return name;
  // index.js 的 senderName 兜底是 open_id 尾号（8 位十六进制），不是真实姓名时不采用
  if (senderName && !/^[0-9a-f]{8}$/i.test(senderName)) return senderName;
  return '未知成员';
}

async function chatLabel(chatId) {
  const facts = await getChatFacts(chatId);
  return facts.chatName || '群聊';
}

// ---------- 接龙识别 ----------
// 覆盖两种形态：
// 1. 文本接龙：以 “#接龙”/“接龙” 开头，或首行含“接龙”且正文为多行序号列表
// 2. 原生接龙消息：卡片 title 为“接龙”，含“立即接龙/查看全部接龙”按钮或“参加群接龙”文案
//    （结构实测：{"title":"接龙","elements":[[...],[{"tag":"button","text":"立即接龙"},...]]}）
function looksLikeSolitaire(text, rawContent) {
  const t = String(text || '').trim();
  if (t) {
    if (/^#*\s*接龙/.test(t)) return true;
    const lines = t.split('\n').map(l => l.trim());
    const numbered = lines.filter(l => /^(\d{1,3}[、.．)\s]|[①-⑩])/.test(l)).length;
    if (/接龙/.test(lines[0] || '') && numbered >= 2) return true;
  }
  const raw = String(rawContent || '');
  return raw.includes('"title":"接龙"')
    || raw.includes('立即接龙')
    || raw.includes('查看全部接龙')
    || raw.includes('参加群接龙')
    || raw.includes('solitaire')
    || raw.includes('"tag":"join_list"');
}

// ---------- 分级识别 ----------
/**
 * @param {object} input
 * @param {string} input.text        消息文本
 * @param {string} input.senderId    发送者 open_id
 * @param {string} input.chatId      群 chat_id
 * @param {number} input.createTime  消息创建时间（ms）
 * @param {boolean} input.isReply    是否引用/回复某条消息
 * @param {string} [input.rawContent] 原始消息 content JSON（用于提取 post 富文本里的链接 href）
 * @returns {Promise<{level: 'strong_ad'|'weak_ad'|'normal', reason: string, detail?: string}>}
 */
export async function classifyMessage({ text, senderId, chatId, createTime, isReply, rawContent = '' }) {
  const raw = String(text || '');

  // 白名单（优先于一切强特征）
  if (isReply) return { level: 'normal', reason: 'whitelist: 引用回复' };

  // 强特征 0：接龙（要求“禁止任何人”，置于管理员白名单之前，仅保留引用回复豁免）
  if (looksLikeSolitaire(raw, rawContent)) {
    return { level: 'strong_ad', reason: 'solitaire' };
  }

  if (config.internalTerms.length > 0 && containsAny(raw, config.internalTerms)) {
    return { level: 'normal', reason: 'whitelist: 内部术语' };
  }
  // bot 管理员（contacts.md Admin）永不撤回：与群主/群管理员同级的白名单
  if (senderId && senderId === ctx.adminOpenId) {
    return { level: 'normal', reason: 'whitelist: bot管理员' };
  }
  if (chatId && senderId) {
    const facts = await getChatFacts(chatId);
    if (!facts.ok) {
      // 查不到管理员名单 → 保守豁免：宁可不撤，不冒误撤管理员的风险
      return { level: 'normal', reason: 'whitelist: 群信息获取失败(保守豁免)' };
    }
    if (facts.adminUserIds.has(senderId)) {
      return { level: 'normal', reason: 'whitelist: 群管理员/群主' };
    }
  }

  const ts = Number(createTime) || Date.now();

  // 强特征 1：5 分钟内相同文本发送 ≥ 3 次（同群同发送者）
  const dupKey = `${chatId}|${senderId}|${stableHash(raw)}`;
  const dupCount = pushAndCount(duplicateHistory, dupKey, ts, config.duplicateWindowMs);
  if (dupCount >= config.duplicateThreshold) {
    return { level: 'strong_ad', reason: 'duplicate_burst', detail: `count=${dupCount}` };
  }

  // 强特征 2：非白名单域名链接（文本 + 原始 content 里的 href 一起查）
  const linkText = raw + '\n' + String(rawContent || '');
  const badHost = hasNonWhitelistLink(linkText);
  if (badHost) return { level: 'strong_ad', reason: 'non_whitelist_link', detail: badHost };

  // 强特征 3：手机号
  if (hasPhoneNumber(raw)) return { level: 'strong_ad', reason: 'phone_number' };

  // 强特征 4：微信号
  if (hasWechatId(raw)) return { level: 'strong_ad', reason: 'wechat_id' };

  // 强特征 5：二维码
  if (hasQrCodeHint(raw)) return { level: 'strong_ad', reason: 'qr_code' };

  // 弱特征：营销词汇 + 发送者入群 < 24 小时（未知入群时间按非新人处理，避免误伤）
  if (containsAny(raw, config.marketingWords)) {
    const joinedAt = joinTimes.get(`${chatId}|${senderId}`);
    if (joinedAt && ts - joinedAt < config.newcomerMs) {
      return { level: 'weak_ad', reason: 'marketing_newcomer' };
    }
  }

  return { level: 'normal', reason: '' };
}

// 供 moderation 等模块复用：发送者是否为该群群主/用户管理员（与撤回白名单同源、同缓存）。
// facts 拉取失败返回 false（不豁免）——豁免必须以确认的管理员身份为准。
export async function isChatAdmin(chatId, openId) {
  if (!chatId || !openId) return false;
  const facts = await getChatFacts(chatId);
  return facts.ok && facts.adminUserIds.has(openId);
}

// 撤回豁免判定（比 isChatAdmin 更保守）：群信息不可用时也豁免——宁可漏撤，不误撤管理员。
export async function isRecallExempt(chatId, openId) {
  if (!chatId || !openId) return false;
  const facts = await getChatFacts(chatId);
  return !facts.ok || facts.adminUserIds.has(openId);
}

// 踢出卡片裁决人：bot 管理员，或管理员日志群内的成员/群管理员。
// 日志群即“工作人员”群：在群里点卡片按钮完成 裁决（移出/忽略）。
// 身份必须以确认的群信息为准；群信息拉取失败时不放行（宁可点不动，不冒误踢风险）。
export async function isKickAdjudicator(openId) {
  if (!openId) return false;
  if (ctx.adminOpenId && openId === ctx.adminOpenId) return true;
  if (!ctx.adminLogChatId) return false;
  const facts = await getChatFacts(ctx.adminLogChatId);
  if (!facts.ok) return false;
  return facts.memberNames.has(openId) || facts.adminUserIds.has(openId);
}

// ---------- 管理员日志群：只发送踢出确认卡片，不再推送撤回/刹车类文本留痕 ----------

function reasonLabel(reason) {
  return REASON_LABELS[reason] || reason;
}

// ---------- 动作路由 ----------
/**
 * 处理一条群消息。返回 true 表示已被广告模块接管（调用方应终止后续流程）。
 */
export async function handleAdMessage({
  text, messageId, chatId, chatType, senderOpenId, senderName = '', createTime, isReply, rawContent = '',
}) {
  if (!isAdRecallCandidate({ chatType, senderType: 'user', chatId })) return false;

  let verdict;
  try {
    verdict = await classifyMessage({ text, senderId: senderOpenId, chatId, createTime, isReply, rawContent });
  } catch (err) {
    ctx.log('error', 'ad-recall', `classify failed msg=${messageId?.slice(-8)}: ${err.message?.slice(0, 200)}`);
    return false;
  }
  if (verdict.level === 'normal') {
    // 白名单放行打点：让「检查了但被豁免」可见；普通无关消息不打，避免刷屏
    if (String(verdict.reason || '').startsWith('whitelist:')) {
      ctx.log('dim', 'ad-recall', `normal (${verdict.reason}) msg=${messageId?.slice(-8)} from=${senderName}(${senderOpenId?.slice(-8)})`);
    }
    return false;
  }

  ctx.log('info', 'ad-recall', `${verdict.level} (${verdict.reason}) from=${senderName}(${senderOpenId?.slice(-8)}) msg=${messageId?.slice(-8)} text="${summarize(text, 40)}"`);

  // ---- weak_ad：不撤回；在群内发统一风格的警示卡片提醒（日志群不发） ----
  if (verdict.level === 'weak_ad') {
    try {
      await sendCardMessage(chatId, buildRecallNoticeCard(reasonLabel(verdict.reason), '⚠️ 群消息提醒'));
    } catch (err) {
      ctx.log('warn', 'ad-recall', `提醒卡片发送失败 msg=${messageId?.slice(-8)}: ${err.message?.slice(0, 150)}`);
    }
    ctx.log('info', 'ad-recall', `weak_ad 观察记录 from=${senderOpenId?.slice(-8)} reason=${verdict.reason} msg=${messageId?.slice(-8)}`);
    return false;
  }

  // ---- strong_ad ----
  const now = Date.now();

  // 安全刹车：5 分钟内已实际撤回 ≥ 3 次 → 暂停自动撤回（仅记本地日志，不发日志群）
  const brakeCount = countRecent(brakeHistory, senderOpenId, now, config.brakeWindowMs);
  if (brakeCount >= config.brakeLimit) {
    ctx.log('warn', 'ad-recall', `刹车触发：${senderOpenId?.slice(-8)} 5分钟内已撤回 ${brakeCount} 次，暂停自动撤回 msg=${messageId?.slice(-8)}`);
    // 刹车触发同样计入踢出计数（刷屏已确认，撤回虽已暂停）
    await noteViolationAndMaybeAsk({ chatId, senderOpenId, senderName, reason: verdict.reason, text });
    return true;
  }

  // 权限预检仅作参考：本地 owner_id/bot_manager_id_list 判定不覆盖群创建者等身份，
  // 曾出现 bot 实际可撤（API 成功）但预检误判放弃的情况 → 预检不通过也直接尝试撤回，以飞书 API 真实结果为准
  const facts = await getChatFacts(chatId);
  if (facts.ok && !facts.botCanRecall) {
    ctx.log('info', 'ad-recall', `权限预检提示非群主/管理员（chat=${chatId?.slice(-8)}），仍尝试撤回 msg=${messageId?.slice(-8)}`);
  } else if (!facts.ok) {
    ctx.log('warn', 'ad-recall', `权限预检接口失败（chat=${chatId?.slice(-8)}），降级为直接尝试撤回 msg=${messageId?.slice(-8)}`);
  }

  // 撤回：DELETE /open-apis/im/v1/messages/{message_id}
  const result = await recallMessageDetailed(messageId);
  if (!result.ok) {
    const known = RECALL_ERROR_HINTS[result.code];
    ctx.log('error', 'ad-recall', `撤回失败 msg=${messageId} code=${result.code}${known ? ` (${known})` : ''} ${result.msg?.slice(0, 150)}`);
    return true;
  }

  // 撤回成功：计数 + 群内就地发送提醒卡片（原因 + 底部警示；日志群只发踢出卡片）
  pushAndCount(brakeHistory, senderOpenId, now, config.brakeWindowMs);
  ctx.log('ok', 'ad-recall', `已撤回 msg=${messageId} sender=${senderName}(${senderOpenId?.slice(-8)}) reason=${verdict.reason}`);
  try {
    await sendCardMessage(chatId, buildRecallNoticeCard(reasonLabel(verdict.reason)));
  } catch (err) {
    ctx.log('warn', 'ad-recall', `撤回提醒卡片发送失败 msg=${messageId?.slice(-8)}: ${err.message?.slice(0, 150)}`);
  }
  // 撤回成功 → 计入踢出计数（双窗口），达阈值弹管理员确认卡片
  await noteViolationAndMaybeAsk({ chatId, senderOpenId, senderName, reason: verdict.reason, text });
  return true;
}

// ---------- 违规踢出（管理员卡片确认；bot 永不自动踢人） ----------
const violationHistory = new Map(); // openId → [{ts, reason, text}]（24h 窗口内，双阈值统计 + 证据展示）
const kickCases = new Map();        // caseId → 案例对象（持久化到磁盘，重启后 pending 卡片仍可裁决）
const KICK_CASES_FILE = join(homedir(), '.feishu-bot', 'kick-cases.json');

// pending 永久保留；已结案留痕 7 天（与 sweeper 清理策略一致）
function persistKickCases() {
  const now = Date.now();
  const data = [];
  for (const c of kickCases.values()) {
    if (c.status === 'pending' || (c.resolvedAt && now - c.resolvedAt < 7 * 24 * 3600 * 1000)) data.push(c);
  }
  try { writeFileSync(KICK_CASES_FILE, JSON.stringify(data, null, 2)); } catch {}
}

function loadKickCases() {
  try {
    const saved = JSON.parse(readFileSync(KICK_CASES_FILE, 'utf-8'));
    if (Array.isArray(saved)) {
      for (const c of saved) {
        if (c?.id && c?.status) kickCases.set(c.id, c);
      }
    }
    if (kickCases.size) ctx.log('info', 'ad-recall', `restored ${kickCases.size} kick case(s)（pending 卡片重启后仍可裁决）`);
  } catch {}
}

function fmtViolationTs(ts) {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

// 群内警示卡片（统一警告样式：标题 + 原因 + 底部灰色小字警示；不带消息摘要）。
// 供 strong_ad 撤回提醒、weak_ad 观察提醒与 moderation 撤回提醒共用，
// 群内不再出现“几行文字”式的纯文本警告。
export function buildRecallNoticeCard(reasonText, title = '⚠️ 消息已被自动撤回') {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**原因：**${reasonText}` } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '请遵守群规；再次违规将被累计记录，多次违规可能被移出群聊' }] },
    ],
  };
}

function kickCardSections(kase) {
  const lines = kase.evidence.map((e, i) => `${i + 1}. ${fmtViolationTs(e.ts)} ${e.reason}${e.text ? `：${e.text}` : ''}`);
  return [
    { tag: 'div', text: { tag: 'lark_md', content: `**用户：**${kase.targetName}（\`${String(kase.targetOpenId).slice(-8)}\`）\n**群聊：**${kase.chatName || String(kase.chatId).slice(-8)}` } },
    { tag: 'div', text: { tag: 'lark_md', content: `**违规：**10分钟内 ${kase.burst} 次 / 24小时内 ${kase.daily} 次\n**记录：**\n${lines.join('\n')}` } },
  ];
}

function buildKickCard(kase) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: '🚨 违规用户待处理' } },
    elements: [
      ...kickCardSections(kase),
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '🔴 移出群聊' }, type: 'danger', value: { adk: 'kick', caseId: kase.id } },
        { tag: 'button', text: { tag: 'plain_text', content: '⚪ 忽略本次' }, type: 'default', value: { adk: 'ignore', caseId: kase.id } },
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '卡片永久有效；bot 不会自动踢人，移出以本卡片点击为准；忽略仅本次，计数保留' }] },
    ],
  };
}

function buildKickCardResolved(kase) {
  const kicked = kase.status === 'kicked';
  return {
    config: { wide_screen_mode: true },
    header: { template: kicked ? 'green' : 'grey', title: { tag: 'plain_text', content: kicked ? '✅ 已移出群聊' : '⚪ 已忽略' } },
    elements: [
      ...kickCardSections(kase),
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: kicked
        ? `✅ **已移出群聊** · 处理人：${kase.resolvedBy} · ${fmtViolationTs(kase.resolvedAt)}`
        : `⚪ **已忽略（仅本次，计数保留）** · 处理人：${kase.resolvedBy} · ${fmtViolationTs(kase.resolvedAt)}` } },
    ],
  };
}

// 撤回成功 / 刹车触发后调用：双窗口计数 → 达阈值弹管理员确认卡片（绝不自动踢）
async function noteViolationAndMaybeAsk({ chatId, senderOpenId, senderName = '', reason, text }) {
  try {
    if (!config.kick.enabled || !chatId || !senderOpenId?.startsWith('ou_')) return;
    if (senderOpenId === ctx.adminOpenId) return;          // bot 管理员永不进入踢出流程
    if (await isChatAdmin(chatId, senderOpenId)) return;    // 群主/群管理员永不进入踢出流程

    const now = Date.now();
    const kept = (violationHistory.get(senderOpenId) || []).filter(e => now - e.ts < config.kick.dailyWindowMs);
    kept.push({ ts: now, reason: reasonLabel(reason), text: summarize(text, 50) });
    violationHistory.set(senderOpenId, kept);
    const burst = kept.filter(e => now - e.ts < config.kick.burstWindowMs).length;
    const daily = kept.length;
    ctx.log('info', 'ad-recall', `violation counted ${senderOpenId?.slice(-8)} burst=${burst}/${config.kick.burstThreshold} daily=${daily}/${config.kick.dailyThreshold}`);

    if (burst < config.kick.burstThreshold && daily < config.kick.dailyThreshold) return;
    for (const c of kickCases.values()) {
      if (c.targetOpenId === senderOpenId && c.status === 'pending') {
        ctx.log('info', 'ad-recall', `踢出确认卡片待处理中（case=${c.id}），新违规仅记录`);
        return;
      }
    }
    const pendingCount = [...kickCases.values()].filter(c => c.status === 'pending').length;
    if (pendingCount >= config.kick.maxPendingCases) {
      ctx.log('warn', 'ad-recall', `待处理踢出卡片已达上限 ${config.kick.maxPendingCases}，${senderName || senderOpenId.slice(-8)} 的新违规仅记录不弹卡片`);
      return;
    }

    const kase = {
      id: `k${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      chatId, targetOpenId: senderOpenId,
      targetName: senderName || senderOpenId.slice(-8),
      chatName: '', evidence: kept.slice(-8),
      burst, daily, status: 'pending', cardMessageId: '', createdAt: now,
    };
    kase.chatName = (await getChatFacts(chatId)).chatName || '';
    if (ctx.adminLogChatId) {
      kase.cardMessageId = (await sendCardMessage(ctx.adminLogChatId, buildKickCard(kase))).messageId;
    } else if (ctx.adminOpenId) {
      kase.cardMessageId = (await sendCardMessage(ctx.adminOpenId, buildKickCard(kase), 'open_id')).messageId;
    } else {
      ctx.log('warn', 'ad-recall', '未配置 adminLogChatId/管理员，踢出确认卡片未发送');
      return;
    }
    kickCases.set(kase.id, kase);
    persistKickCases();
    ctx.log('ok', 'ad-recall', `踢出确认卡片已发送 case=${kase.id} target=${kase.targetName}(${senderOpenId?.slice(-8)}) burst=${burst} daily=${daily}`);
  } catch (err) {
    const body = err.response?.data ? ` body=${JSON.stringify(err.response.data).slice(0, 200)}` : '';
    ctx.log('error', 'ad-recall', `踢出流程异常: ${err.message?.slice(0, 200)}${body}`);
  }
}

// 卡片按钮回调（index.js 的 card.action.trigger 转发到这里）；返回 {ok, msg}
export async function handleKickCardAction({ caseId, action, operatorOpenId, operatorName = '' }) {
  const kase = kickCases.get(caseId);
  const who = operatorName || operatorOpenId?.slice(-8) || '';
  if (!kase) return { ok: false, msg: '案例不存在（bot 可能重启过），请人工处理' };
  if (kase.status !== 'pending') return { ok: true, msg: `该案例已处理（${kase.status === 'kicked' ? '已移出' : '已忽略'}）` };

  if (action === 'ignore') {
    kase.status = 'ignored';
    kase.resolvedBy = who;
    kase.resolvedAt = Date.now();
    persistKickCases();
    ctx.log('ok', 'ad-recall', `案例已忽略 case=${caseId} by=${who}（计数保留）`);
    await updateCardMessageSafe(kase);
    return { ok: true, msg: '已忽略本次，计数保留' };
  }

  if (action === 'kick') {
    // 双保险：身份可能在发卡后发生变化，执行前再查一次
    if (kase.targetOpenId === ctx.adminOpenId) return { ok: false, msg: '目标为 bot 管理员，拒绝执行' };
    if (await isChatAdmin(kase.chatId, kase.targetOpenId)) return { ok: false, msg: '目标现为群主/群管理员，拒绝执行' };
    try {
      await removeChatMembers(kase.chatId, [kase.targetOpenId]);
      kase.status = 'kicked';
      kase.resolvedBy = who;
      kase.resolvedAt = Date.now();
      violationHistory.delete(kase.targetOpenId);
      persistKickCases();
      ctx.log('ok', 'ad-recall', `已移出群聊 case=${caseId} target=${kase.targetOpenId.slice(-8)} by=${who}`);
      await updateCardMessageSafe(kase);
      return { ok: true, msg: '已移出群聊' };
    } catch (err) {
      const body = err.response?.data ? ` body=${JSON.stringify(err.response.data).slice(0, 200)}` : '';
      ctx.log('error', 'ad-recall', `移出失败 case=${caseId}: ${err.message?.slice(0, 200)}${body}`);
      return { ok: false, msg: `移出失败：${(err.response?.data?.msg || err.message || '').slice(0, 100)}` };
    }
  }
  return { ok: false, msg: '未知操作' };
}

async function updateCardMessageSafe(kase) {
  if (!kase.cardMessageId) return;
  try {
    await updateCardMessage(kase.cardMessageId, buildKickCardResolved(kase));
  } catch (err) {
    ctx.log('warn', 'ad-recall', `卡片状态更新失败 case=${kase.id}: ${err.message?.slice(0, 150)}`);
  }
}

// ---------- 周期清理，防止 Map 无限增长 ----------
let sweeperStarted = false;
function startSweeper() {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of brakeHistory) {
      const kept = arr.filter(t => now - t < config.brakeWindowMs);
      if (kept.length) brakeHistory.set(k, kept); else brakeHistory.delete(k);
    }
    for (const [k, arr] of duplicateHistory) {
      const kept = arr.filter(t => now - t < config.duplicateWindowMs);
      if (kept.length) duplicateHistory.set(k, kept); else duplicateHistory.delete(k);
    }
    for (const [k, ts] of joinTimes) {
      if (now - ts > 7 * 24 * 3600 * 1000) joinTimes.delete(k);
    }
    for (const [k, v] of chatFactsCache) {
      if (now - v.fetchedAt >= config.chatFactsTtlMs) chatFactsCache.delete(k);
    }
    // 踢出：窗口外违规清零；已结案案例留痕 7 天后清理（pending 永不清）
    for (const [k, arr] of violationHistory) {
      const kept = arr.filter(e => now - e.ts < config.kick.dailyWindowMs);
      if (kept.length) violationHistory.set(k, kept); else violationHistory.delete(k);
    }
    for (const [id, c] of kickCases) {
      if (c.status !== 'pending' && now - c.resolvedAt > 7 * 24 * 3600 * 1000) kickCases.delete(id);
    }
  }, 60 * 1000);
  timer.unref?.();
}
startSweeper();
