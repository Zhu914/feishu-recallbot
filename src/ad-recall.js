// 自动广告撤回模块（ad-recall）
// 链路：index.js im.message.receive_v1 → isAdRecallCandidate → handleAdMessage
//   ├─ classifyMessage：分级识别 strong_ad / weak_ad / normal
//   ├─ 权限预检：群成员接口（is_in_chat）+ 群信息（owner_id / bot_manager_id_list）确认机器人是群主/管理员
//   ├─ 动作路由：strong_ad → 撤回；weak_ad → 单聊提醒 + 管理员日志群上报；normal → 无动作
//   ├─ 安全刹车：同一 sender 5 分钟内被自动撤回 ≥ 2 次后暂停撤回，改发管理员告警
//   └─ 留痕：每次实际撤回后向管理员日志群推送 [自动撤回] 记录
//
// 计数器为进程内存实现（Map + 滑动窗口）；多实例部署时可替换为 Redis。

import { createHash } from 'crypto';
import { getClient, recallMessageDetailed, sendDirectMessage, sendChatMessage, replyMessage } from './feishu.js';

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
  brakeLimit: 2,
  chatFactsTtlMs: 5 * 60 * 1000,
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

export function initAdRecall({ log = () => {}, appId = '', adminOpenId = '', allGroups = false, isChatAllowed = () => false } = {}) {
  ctx = { log, appId, adminOpenId, adminLogChatId: process.env.AD_RECALL_ADMIN_LOG_CHAT_ID || '', allGroups, isChatAllowed };
  config = {
    ...config,
    enabled: process.env.AD_RECALL_ENABLED === 'true',
    domainWhitelist: splitList(process.env.AD_RECALL_DOMAIN_WHITELIST || DEFAULT_DOMAIN_WHITELIST),
    internalTerms: splitList(process.env.AD_RECALL_INTERNAL_TERMS),
    marketingWords: splitList(process.env.AD_RECALL_MARKETING_WORDS).length > 0
      ? splitList(process.env.AD_RECALL_MARKETING_WORDS)
      : DEFAULT_MARKETING_WORDS,
    duplicateWindowMs: Number(process.env.AD_RECALL_DUPLICATE_WINDOW_MS) || 5 * 60 * 1000,
    duplicateThreshold: Number(process.env.AD_RECALL_DUPLICATE_THRESHOLD) || 3,
    newcomerMs: (Number(process.env.AD_RECALL_NEWCOMER_HOURS) || 24) * 3600 * 1000,
    brakeWindowMs: Number(process.env.AD_RECALL_BRAKE_WINDOW_MS) || 5 * 60 * 1000,
    brakeLimit: Number(process.env.AD_RECALL_BRAKE_LIMIT) || 2,
  };
  log('info', 'ad-recall', `initialized enabled=${config.enabled} allGroups=${allGroups} ` +
    `whitelistDomains=${config.domainWhitelist.length} internalTerms=${config.internalTerms.length} ` +
    `marketingWords=${config.marketingWords.length} ` +
    `adminLog=${ctx.adminLogChatId ? ctx.adminLogChatId.slice(-8) : (adminOpenId ? 'admin-dm' : 'NONE')}`);
  log('info', 'ad-recall',
    '新人判定依赖 im.chat.member.user.added_v1 事件（需在开放平台订阅），未收到入群事件的成员按非新人处理');
  return config;
}

// ---------- 是否进入广告识别（入口门控） ----------
export function isAdRecallCandidate({ chatType, senderType, chatId }) {
  return config.enabled
    && chatType === 'group'
    && senderType === 'user'
    && !!chatId
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
  if (chatId && senderId) {
    const facts = await getChatFacts(chatId);
    if (facts.ok && facts.adminUserIds.has(senderId)) {
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

// ---------- 管理员日志群推送 ----------
async function pushAdminLog(lines) {
  const text = lines.filter(Boolean).join('\n');
  try {
    if (ctx.adminLogChatId) {
      await sendChatMessage(ctx.adminLogChatId, text);
    } else if (ctx.adminOpenId) {
      await sendDirectMessage(ctx.adminOpenId, text);
    } else {
      ctx.log('warn', 'ad-recall', '未配置 AD_RECALL_ADMIN_LOG_CHAT_ID / 管理员，日志未推送');
    }
  } catch (err) {
    ctx.log('warn', 'ad-recall', `管理员日志推送失败: ${err.message?.slice(0, 150)}`);
  }
}

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
  if (verdict.level === 'normal') return false;

  ctx.log('info', 'ad-recall', `${verdict.level} (${verdict.reason}) from=${senderName}(${senderOpenId?.slice(-8)}) msg=${messageId?.slice(-8)} text="${summarize(text, 40)}"`);

  // ---- weak_ad：不撤回；在发送者消息下回复提醒 + 管理员日志群记录 ----
  if (verdict.level === 'weak_ad') {
    try {
      await replyMessage(messageId, [
        '⚠️ 群消息提醒',
        '您在群内发送的消息包含营销推广相关内容，已被系统记录观察。',
        '请遵守群规，避免发布广告、二维码或联系方式；多次触发将转交管理员处理。',
      ].join('\n'));
    } catch (err) {
      ctx.log('warn', 'ad-recall', `提醒回复发送失败 msg=${messageId?.slice(-8)}: ${err.message?.slice(0, 150)}`);
    }
    const [who, where] = await Promise.all([describeSender(chatId, senderOpenId, senderName), chatLabel(chatId)]);
    const summary = summarize(text, 50);
    const lines = [
      '📋 疑似广告，已标记观察（未撤回）',
      `发送者：${who}`,
      `所在群：${where}`,
      `原因：${reasonLabel(verdict.reason)}`,
    ];
    if (summary) lines.push(`内容摘要：${summary}`);
    await pushAdminLog(lines);
    return false;
  }

  // ---- strong_ad ----
  const now = Date.now();

  // 安全刹车：5 分钟内已实际撤回 ≥ 2 次 → 暂停自动撤回，发管理员告警卡片
  const brakeCount = countRecent(brakeHistory, senderOpenId, now, config.brakeWindowMs);
  if (brakeCount >= config.brakeLimit) {
    ctx.log('warn', 'ad-recall', `刹车触发：${senderOpenId?.slice(-8)} 5分钟内已撤回 ${brakeCount} 次，暂停自动撤回 msg=${messageId?.slice(-8)}`);
    const [who, where] = await Promise.all([describeSender(chatId, senderOpenId, senderName), chatLabel(chatId)]);
    const summary = summarize(text, 50);
    const lines = [
      '🛑 自动撤回已触发安全刹车',
      `发送者：${who}`,
      `所在群：${where}`,
      `该用户 ${Math.round(config.brakeWindowMs / 60000)} 分钟内已被自动撤回 ${brakeCount} 次，已暂停对其自动撤回，请人工处理。`,
      `原因：${reasonLabel(verdict.reason)}`,
    ];
    if (summary) lines.push(`内容摘要：${summary}`);
    await pushAdminLog(lines);
    return true;
  }

  // 权限预检：确认机器人是该群群主/管理员且仍在群内
  const facts = await getChatFacts(chatId);
  if (facts.ok && !facts.botCanRecall) {
    ctx.log('warn', 'ad-recall', `权限预检未通过：机器人非群主/管理员（chat=${chatId?.slice(-8)}），跳过撤回 msg=${messageId?.slice(-8)}`);
    const [who, where] = await Promise.all([describeSender(chatId, senderOpenId, senderName), chatLabel(chatId)]);
    const summary = summarize(text, 50);
    const lines = [
      '⚠️ 无法自动撤回：机器人不是该群的管理员，请人工处理',
      `所在群：${where}`,
      `发送者：${who}`,
      `原因：${reasonLabel(verdict.reason)}`,
    ];
    if (summary) lines.push(`内容摘要：${summary}`);
    await pushAdminLog(lines);
    return true;
  }
  if (!facts.ok) {
    ctx.log('warn', 'ad-recall', `权限预检接口失败（chat=${chatId?.slice(-8)}），降级为直接尝试撤回 msg=${messageId?.slice(-8)}`);
  }

  // 撤回：DELETE /open-apis/im/v1/messages/{message_id}
  const result = await recallMessageDetailed(messageId);
  if (!result.ok) {
    const known = RECALL_ERROR_HINTS[result.code];
    ctx.log('error', 'ad-recall', `撤回失败 msg=${messageId} code=${result.code}${known ? ` (${known})` : ''} ${result.msg?.slice(0, 150)}`);
    const [who, where] = await Promise.all([describeSender(chatId, senderOpenId, senderName), chatLabel(chatId)]);
    const summary = summarize(text, 50);
    const lines = [
      '❌ 自动撤回失败，请人工处理',
      `发送者：${who}`,
      `所在群：${where}`,
      `失败原因：${known || `错误码 ${result.code}`}`,
      `判定原因：${reasonLabel(verdict.reason)}`,
    ];
    if (summary) lines.push(`内容摘要：${summary}`);
    await pushAdminLog(lines);
    return true;
  }

  // 撤回成功：计数 + 留痕
  pushAndCount(brakeHistory, senderOpenId, now, config.brakeWindowMs);
  ctx.log('ok', 'ad-recall', `已撤回 msg=${messageId} sender=${senderName}(${senderOpenId?.slice(-8)}) reason=${verdict.reason}`);
  const [who, where] = await Promise.all([describeSender(chatId, senderOpenId, senderName), chatLabel(chatId)]);
  const summary = summarize(text, 50);
  const lines = [
    '⚠️ 已自动撤回一条消息',
    `发送者：${who}`,
    `所在群：${where}`,
    `原因：${reasonLabel(verdict.reason)}`,
  ];
  if (summary) lines.push(`内容摘要：${summary}`);
  await pushAdminLog(lines);
  return true;
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
  }, 60 * 1000);
  timer.unref?.();
}
startSweeper();
