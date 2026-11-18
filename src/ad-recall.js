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
import { getClient, recallMessageDetailed, removeChatMembers, sendCardMessage, replyCardMessage, updateCardMessage, extractAttachmentSpecs, downloadMessageResourceBuffer } from './feishu.js';
import { detectQrcodeImage } from './qrcode.js';

// DELETE /open-apis/im/v1/messages/{message_id} 重点关注错误码
const RECALL_ERROR_HINTS = {
  230026: '机器人没有权限撤回该消息（需为群主/管理员/群创建者，或只能撤回自己发送的消息）',
  230009: '消息发出时间过长，超出企业设置的撤回时限',
  230050: '该消息对当前操作者不可见',
};

const REASON_LABELS = {
  phone_number: '包含手机号',
  wechat_id: '包含微信号',
  qr_code: '包含二维码',
  duplicate_burst: '5分钟内相同文本发送≥3次',
  solitaire: '发起接龙（本群禁止）',
  profanity: '包含不文明发言',
  gray_profanity: '包含不友善词汇，请注意言辞',
  moderation: 'AI 审核违规（撤回）',
  vote: '发起群投票（仅群主/管理员可发起）',
  netdisk_ad: '网盘链接引流',
  netdisk_warn: '包含网盘链接，请说明资源内容（请勿用于引流推广）',
  shortlink_ad: '短链接引流',
  shortlink_warn: '包含短链接，请说明内容来源（请勿用于引流推广）',
};

// 确定性脏话词表：只收录无歧义的辱骂词（命中即 strong_ad 撤回）。
// 灰度词（白痴/弱智/脑残等可能在正常语境出现）不进词表，由 AI 审核（moderation）兜底识别。
const DEFAULT_PROFANITY_WORDS = [
  '傻逼', '傻b', 'sb', '二逼', '傻吊', '傻屌',
  '草泥马', '草你妈', '操你妈', '肏你妈', '日你妈', '干你妈', '你妈死了', 'nmsl',
  '妈卖批', '狗日的', '王八蛋', '婊子', '贱人', '贱货', '杂种',
];

// 网盘引流：域名与引流词默认值（须在下方 let config 字面量之前定义，避免 TDZ；
// 域名列表只收已知网盘 host，不做通用链接检测——2026-11-16 通用黑名单误伤 GitHub 的前车之鉴）
const DEFAULT_NETDISK_HOSTS = [
  'pan.baidu.com', 'pan.quark.cn', 'pan.quark.com', 'quark.cn',
  'aliyundrive.com', 'alipan.com', '123pan.com', '123684.com',
  'lanzou.com', 'lanzoux.com', 'lanzouy.com', 'lanzouq.com', 'lanzoup.com', 'lanzn.com',
  'wenshushu.cn', 'cowtransfer.com',
];
const DEFAULT_NETDISK_DIVERSION_WORDS = ['进群', '加群', '资源群', '公众号', '每日更新', '收费代找'];

// 短链域名表（与网盘同一套 host 匹配；永不解链——不对短链发起任何网络请求）。
// 分两组：通用短链服务（正常群友极少用）+ 平台分享短链（正常分享高发，误伤风险来源，
// 裸链默认只提醒；hosts 非空则整体覆盖本表，可按需删除平台域名）。
const DEFAULT_SHORTLINK_HOSTS = [
  'bit.ly', 'tinyurl.com', 'is.gd', 'cutt.ly', 'shorturl.at', 'rb.gy',
  'ow.ly', 't.co', 'tiny.cc', 'bit.do', 'dwz.cn', 'suo.im',
  't.cn', 'b23.tv', 'v.douyin.com', 'url.cn',
];

let config = {
  enabled: false,
  internalTerms: [],
  duplicateWindowMs: 5 * 60 * 1000,
  duplicateThreshold: 3,
  brakeWindowMs: 5 * 60 * 1000,
  brakeLimit: 3,
  chatFactsTtlMs: 5 * 60 * 1000,
  excludedChats: [],
  profanity: {
    enabled: false,
    words: DEFAULT_PROFANITY_WORDS,
    warnWords: [],
  },
  voteControl: {
    enabled: true,
  },
  qrImage: {
    enabled: false,
    maxImageBytes: 10 * 1024 * 1024,
    downloadTimeoutMs: 10000,
    maxImagesPerMessage: 4,
    timeoutMs: 4000,
    maxDimension: 2000,
  },
  netdisk: {
    enabled: false,
    mode: 'off',
    hosts: DEFAULT_NETDISK_HOSTS,
    diversionWords: DEFAULT_NETDISK_DIVERSION_WORDS,
  },
  shortLink: {
    enabled: false,
    mode: 'off',
    aloneAction: 'warn',
    hosts: DEFAULT_SHORTLINK_HOSTS,
    diversionWords: DEFAULT_NETDISK_DIVERSION_WORDS,
  },
  kick: {
    enabled: false,
    burstThreshold: 3,
    burstWindowMs: 10 * 60 * 1000,
    dailyThreshold: 8,
    dailyWindowMs: 24 * 3600 * 1000,
    maxPendingCases: 10,
    pendingExpireMs: 3600000,
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
    internalTerms: fileConfig.internalTerms || [],
    duplicateWindowMs: Number(fileConfig.duplicateWindowMs) || 5 * 60 * 1000,
    duplicateThreshold: Number(fileConfig.duplicateThreshold) || 3,
    brakeWindowMs: Number(fileConfig.brakeWindowMs) || 5 * 60 * 1000,
    brakeLimit: fileConfig.brakeLimit === 0 ? 0 : (Number(fileConfig.brakeLimit) || 3), // 0 = 关闭安全刹车
    excludedChats: Array.isArray(fileConfig.excludedChats) ? fileConfig.excludedChats.filter(c => typeof c === 'string' && c.startsWith('oc_')) : [],
    profanity: {
      enabled: fileConfig.profanity?.enabled === true,
      words: Array.isArray(fileConfig.profanity?.words) && fileConfig.profanity.words.length
        ? fileConfig.profanity.words.map(w => String(w || '').trim()).filter(Boolean)
        : DEFAULT_PROFANITY_WORDS,
      warnWords: Array.isArray(fileConfig.profanity?.warnWords)
        ? fileConfig.profanity.warnWords.map(w => String(w || '').trim()).filter(Boolean)
        : [],
      // 谐音字映射（单字→单字，如 煞→傻）：归一化后仍需命中完整词条才触发，不做逐字替换式匹配
      homophones: normalizeHomophones(fileConfig.profanity?.homophones),
    },
    voteControl: {
      enabled: fileConfig.voteControl?.enabled !== false,
    },
    netdisk: {
      enabled: fileConfig.netdisk?.enabled === true,
      mode: ['warn', 'recall'].includes(fileConfig.netdisk?.mode) ? fileConfig.netdisk.mode : 'off',
      hosts: mergeNetdiskHosts(fileConfig.netdisk?.hosts),
      diversionWords: fileConfig.netdisk?.diversionWords?.length
        ? fileConfig.netdisk.diversionWords.map(w => String(w || '').trim()).filter(Boolean)
        : DEFAULT_NETDISK_DIVERSION_WORDS,
    },
    shortLink: {
      enabled: fileConfig.shortLink?.enabled === true,
      mode: ['warn', 'recall'].includes(fileConfig.shortLink?.mode) ? fileConfig.shortLink.mode : 'off',
      aloneAction: ['warn', 'recall', 'pass'].includes(fileConfig.shortLink?.aloneAction) ? fileConfig.shortLink.aloneAction : 'warn',
      // hosts 语义与 netdisk 相反：非空则整体覆盖默认表（便于删掉误伤的平台域名），空则用默认
      hosts: (() => { const vh = validHosts(fileConfig.shortLink?.hosts); return vh.length ? vh : DEFAULT_SHORTLINK_HOSTS; })(),
      // 引流词缺省与 netdisk 共用一张表（netdisk 配了就用它的，否则内置默认）
      diversionWords: fileConfig.shortLink?.diversionWords?.length
        ? fileConfig.shortLink.diversionWords.map(w => String(w || '').trim()).filter(Boolean)
        : (fileConfig.netdisk?.diversionWords?.length
          ? fileConfig.netdisk.diversionWords.map(w => String(w || '').trim()).filter(Boolean)
          : DEFAULT_NETDISK_DIVERSION_WORDS),
    },
    qrImage: {
      enabled: fileConfig.qrImage?.enabled === true,
      maxImageBytes: Number(fileConfig.qrImage?.maxImageBytes) || 10 * 1024 * 1024,
      downloadTimeoutMs: Number(fileConfig.qrImage?.downloadTimeoutMs) || 10000,
      maxImagesPerMessage: Number(fileConfig.qrImage?.maxImagesPerMessage) || 4,
      timeoutMs: Number(fileConfig.qrImage?.timeoutMs) || 4000,
      maxDimension: Number(fileConfig.qrImage?.maxDimension) || 2000,
    },
    kick: {
      enabled: fileConfig.kick?.enabled === true,
      burstThreshold: Number(fileConfig.kick?.burstThreshold) || 3,
      burstWindowMs: Number(fileConfig.kick?.burstWindowMs) || 10 * 60 * 1000,
      dailyThreshold: Number(fileConfig.kick?.dailyThreshold) || 8,
      dailyWindowMs: Number(fileConfig.kick?.dailyWindowMs) || 24 * 3600 * 1000,
      maxPendingCases: Number(fileConfig.kick?.maxPendingCases) || 10,
      pendingExpireMs: Number(fileConfig.kick?.pendingExpireMs) || 3600000,
    },
  };
  log('info', 'ad-recall', `initialized enabled=${config.enabled} allGroups=${ctx.allGroups} ` +
    `internalTerms=${config.internalTerms.length} ` +
    `voteControl=${config.voteControl.enabled} ` +
    `netdisk=${config.netdisk.enabled ? config.netdisk.mode : 'off'} ` +
    `shortLink=${config.shortLink.enabled ? `${config.shortLink.mode}/alone=${config.shortLink.aloneAction}` : 'off'} ` +
    `qrImage=${config.qrImage.enabled ? `on(maxDim=${config.qrImage.maxDimension},timeout=${config.qrImage.timeoutMs}ms)` : 'off'} ` +
    `profanity=${config.profanity.enabled ? `${config.profanity.words.length}词+${config.profanity.warnWords.length}灰度+谐音映射${Object.keys(config.profanity.homophones).length}` : 'off'} ` +
    `adminLog=${ctx.adminLogChatId ? ctx.adminLogChatId.slice(-8) : (adminOpenId ? 'admin-dm' : 'NONE')}`);
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

// ---------- 网盘链接引流（2026-11-17） ----------
// 网盘链接本身大量是正常分享（资料/数据集/工具包），不能像手机号/微信号那样单独成立强特征
// （2026-11-16 通用链接黑名单误伤 GitHub/博客链接的前车之鉴）；「网盘链接 × 引流话术」组合
// 才无歧义。档位由 config.netdisk.mode 控制：off 不启用 / warn 全部降为提醒 / recall 完整矩阵。

// 主机名列表 → 匹配正则（网盘/短链共用）：左边界排除字母数字与连字符（防 myquark.cn 误中，
// 允许 www./子域前缀与中文等上下文字符），右边界防 quark.cnxx 之类误拼；域名点号转义。
function buildHostRe(hosts) {
  const parts = (Array.isArray(hosts) ? hosts : [])
    .map(h => String(h || '').trim().toLowerCase())
    .filter(Boolean)
    .map(h => h.replace(/\./g, '\\.'));
  if (!parts.length) return null;
  return new RegExp(`(?:^|[^a-z0-9-])(${parts.join('|')})(?![a-z0-9-])`);
}

/**
 * 纯检测函数（无 config 依赖）：网盘链接 × 引流话术。
 * 返回 { level: 'strong'|'warn'|'', host, word }：strong=链接+引流词（无歧义广告）；warn=仅链接。
 * 供 classifyMessage 与离线评测（scripts/eval-moderation.mjs）共用，保证线上与评测同一套判定。
 */
export function classifyNetdiskText(text, diversionWords = DEFAULT_NETDISK_DIVERSION_WORDS, hosts = DEFAULT_NETDISK_HOSTS) {
  const re = buildHostRe(hosts);
  if (!re) return { level: '', host: '', word: '' };
  const normalized = String(text || '').toLowerCase().replace(ZERO_WIDTH_RE, '');
  const m = normalized.match(re);
  if (!m) return { level: '', host: '', word: '' };
  const word = (Array.isArray(diversionWords) ? diversionWords : [])
    .find(w => w && normalized.includes(String(w).toLowerCase())) || '';
  return { level: word ? 'strong' : 'warn', host: m[1], word };
}

/**
 * 纯检测函数（无 config 依赖）：短链域名 × 引流话术（与网盘共用 host 匹配与引流词，永不解链）。
 * 返回 { level: 'strong'|'warn'|'', host, word }：strong=短链+引流词（无歧义广告）；
 * 裸短链按 aloneAction：warn=提醒 / recall=同 strong / pass=确定性层不管（交 AI 文案判定）。
 */
export function classifyShortLinkText(text, diversionWords = DEFAULT_NETDISK_DIVERSION_WORDS, hosts = DEFAULT_SHORTLINK_HOSTS, aloneAction = 'warn') {
  const re = buildHostRe(hosts);
  if (!re) return { level: '', host: '', word: '' };
  const normalized = String(text || '').toLowerCase().replace(ZERO_WIDTH_RE, '');
  const m = normalized.match(re);
  if (!m) return { level: '', host: '', word: '' };
  const word = (Array.isArray(diversionWords) ? diversionWords : [])
    .find(w => w && normalized.includes(String(w).toLowerCase())) || '';
  if (word) return { level: 'strong', host: m[1], word };
  const level = aloneAction === 'recall' ? 'strong' : aloneAction === 'warn' ? 'warn' : '';
  return { level, host: m[1], word: '' };
}

// host 配置清洗：只收形如域名的字符串（防配置写坏正则）
function validHosts(raw) {
  return Array.isArray(raw)
    ? raw.map(h => String(h || '').trim().toLowerCase()).filter(h => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h))
    : [];
}

// config 追加 host（网盘语义）：内置默认 + 配置补充（去重）
function mergeNetdiskHosts(raw) {
  return [...new Set([...DEFAULT_NETDISK_HOSTS, ...validHosts(raw)])];
}

function containsAny(text, words) {
  const lower = text.toLowerCase();
  return words.some(w => w && lower.includes(w.toLowerCase()));
}

// 词表匹配：中文词对「去分隔符文本」做子串匹配（防"傻 逼"/"傻.逼"变体）；
// 纯字母数字词按独立词边界匹配（防 "usb 接口" 误中 "sb"）。
//
// 变体归一化（2026-11，谐音/缩写脏话检测；同月对抗复查后 v2）：
// - NFKC 全角折叠（ｓｂ → sb）+ 零宽字符剥离，两条匹配路径同时生效。
// - 纯拉丁词条：逐词构造「分隔容忍正则」——字符之间允许 ≤2 个任意非字母数字字符
//   （n-m-s-l / n·m·s·l / n$m$s$l / s b / sha bi 都能命中），首字符边界 (^|[^a-z0-9])
//   保证不会从词中间起配：class b 的 s 前面是字母、不命中；也不会熔接相邻 token
//   （"cnm nmsl" 两个词各自独立命中，v1 全局坍缩曾把它们拼成 cnmnmsl 导致双双漏检）。
// - 拉丁路径的数字谐音只保留安全交替 o0/l1/e3/a@/s$/i1（nms1→nmsl、sh@bi→shabi）。
//   刻意不做 5→s/8→b："58元/5.8级/17:58/三星s8/5b铅笔" 都会误中 sb（block 档=撤回+计踢）。
//   s8/傻8 的数字变形：混排词条走 compact 路径仍全量 leet（傻8→傻b 命中），
//   纯拉丁 s8 交给 MA 语境判定。
// - 谐音字映射（config homophones，如 煞→傻/哔→逼/艹→操）：仅做字符归一，
//   归一后仍必须命中完整词条才会触发（"买支笔"不会因 笔→逼 误中任何词）。
// - 拆字类高频形态（女马/尸八）按词条收录在 warnWords 档：block 档子串匹配会误伤
//   「美女马上/儿女马上/验尸，八小时」等正常搭配，降为提醒卡档位。
const LEET_DIGIT_MAP = { '0': 'o', '1': 'l', '3': 'e', '5': 's', '8': 'b' };
const LEET_RE = /[01358]/g;
const ZERO_WIDTH_RE = /[​-‏⁠﻿]/g;
// compact 分隔符集与拉丁路径的间隔类保持一致的超集：|@$#=+/ 等 v1 遗漏的规避符已并入
const COMPACT_SEP_RE = /[\s.,!?。！？，、~*_\-·'“”‘’「」『』【】《》〈〉()[\]{}|@$#=+/\\]+/g;
// 拉丁字符的安全数字/符号交替（不含 5→s、8→b：见上方注释）
const LATIN_CHAR_ALT = { o: '[o0]', l: '[l1]', e: '[e3]', a: '[a@]', s: '[s$]', i: '[i1]' };

function escapeReChar(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

// homophones 配置清洗：只接受「单字 → 单字」的映射，其余丢弃并在日志中留痕
function normalizeHomophones(raw) {
  const map = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    const val = String(v || '').trim();
    if ([...key].length === 1 && [...val].length === 1) map[key] = val;
  }
  return map;
}

const latinReCache = new Map();
function buildLatinRe(word) {
  let re = latinReCache.get(word);
  if (re !== undefined) return re;
  const parts = [];
  for (const ch of word) {
    if (LATIN_CHAR_ALT[ch]) parts.push(LATIN_CHAR_ALT[ch]);
    else if (/[a-z0-9]/.test(ch)) parts.push(ch);
  }
  re = parts.length ? new RegExp(`(^|[^a-z0-9])${parts.join('([^a-z0-9]{0,2})')}([^a-z0-9]|$)`) : null;
  latinReCache.set(word, re);
  return re;
}

/**
 * 纯检测函数（无 config 依赖）：返回命中的词条，未命中返回 ''。
 * 供 findWordIn 与离线评测（scripts/eval-moderation.mjs）共用，保证线上与评测同一套归一化。
 */
export function detectProfanityWord(text, words, homophones = {}) {
  if (!Array.isArray(words) || words.length === 0) return '';
  const raw = String(text || '').toLowerCase().normalize('NFKC').replace(ZERO_WIDTH_RE, '');
  // compact 过全量 leet：混排词条（傻b）要能接住 傻8/傻5 之类的数字变形（中文语境无 58元 类碰撞面）
  let compact = raw
    .replace(LEET_RE, (d) => LEET_DIGIT_MAP[d])
    .replace(COMPACT_SEP_RE, '');
  if (compact && homophones && Object.keys(homophones).length) {
    const pattern = Object.keys(homophones).map(escapeReChar).join('');
    compact = compact.replace(new RegExp(`[${pattern}]`, 'g'), (c) => homophones[c] || c);
  }
  for (const word of words) {
    const t = String(word || '').toLowerCase().trim().replace(/\s+/g, '');
    if (!t) continue;
    if (/^[a-z0-9]+$/.test(t)) {
      const re = buildLatinRe(t);
      if (re && re.test(raw)) return word;
    } else if (compact.includes(t)) {
      return word;
    }
  }
  return '';
}

function findWordIn(text, words) {
  if (!config.profanity.enabled || !Array.isArray(words) || words.length === 0) return '';
  return detectProfanityWord(text, words, config.profanity.homophones);
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
    // ok 只看 im.chat.get：管理员名单/owner_id 全来自它。若 chat.get 失败而 is_in_chat 成功时
    // 置 ok=true，名单为空却生效，群主/群管理员会失去豁免且被缓存 5 分钟（误撤风险）——
    // 必须按「群信息获取失败 → 保守豁免」处理（宁漏勿误）。
    entry.ok = !!chatResp;
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

// 提醒/撤回提示卡：优先以回复形式发到原消息的话题里（root 优先，避免回复已撤回消息失败），
// 回复失败（如消息已撤回且无 root）时降级为群内单独发卡，保证提示不丢。
async function sendNoticeCard({ chatId, messageId, rootId = '' }, card) {
  const replyTarget = (rootId && rootId.startsWith('om_')) ? rootId : messageId;
  if (replyTarget?.startsWith('om_')) {
    try {
      return await replyCardMessage(replyTarget, card);
    } catch (err) {
      ctx.log('dim', 'notice', `话题回复卡片失败，降级群发 msg=${String(replyTarget).slice(-8)}: ${err.message?.slice(0, 120)}`);
    }
  }
  return sendCardMessage(chatId, card);
}

// ---------- 接龙识别 ----------
// 覆盖两种形态：
// 1. 文本接龙：以 “#接龙”/“接龙” 开头，或首行含“接龙”且正文为多行序号列表
// 2. 原生接龙消息：卡片 title 为“接龙”，含“立即接龙/查看全部接龙”按钮或“参加群接龙”文案
//    （结构实测：{"title":"接龙","elements":[[...],[{"tag":"button","text":"立即接龙"},...]]}）
function looksLikeSolitaire(text, rawContent) {
  const t = String(text || '').trim();
  if (t) {
    // 文本接龙：首行以「接龙」（可带 # 前缀）开头，且其后至少 2 个编号报名行。
    // 仅首行前缀不足以判定——单独发「接龙」两个字或「接龙是什么」是正常聊天
    // （2026-11-16 收紧：原先 /^#*\s*接龙/ 前缀即命中，误撤普通消息）。
    const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
    const numbered = lines.slice(1).filter(l => /^(\d{1,3}[、.．)\s]|[①-⑩])/.test(l)).length;
    if (lines.length && /^#*\s*接龙/.test(lines[0]) && numbered >= 2) return true;
  }
  // 卡片接龙（群员用飞书「接龙」功能发布）：按卡片结构特征识别，与文本无关
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

  // 强特征（确定性）：脏话词表命中即撤回；灰度辱骂词由 AI 审核（moderation）兜底
  const profanityHit = findWordIn(raw, config.profanity.words);
  if (profanityHit) {
    return { level: 'strong_ad', reason: 'profanity', detail: profanityHit };
  }

  // 灰度词（如死字词，语境歧义大）：只提醒不撤回，不计违规
  const grayHit = findWordIn(raw, config.profanity.warnWords);
  if (grayHit) {
    return { level: 'weak_ad', reason: 'gray_profanity', detail: grayHit };
  }

  const ts = Number(createTime) || Date.now();

  // 强特征 1：5 分钟内相同文本发送 ≥ 3 次（同群同发送者）。
  // 占位文本不参与：所有 image 消息的可提取文本都是常量 '[图片]'（'[附件: …]' 同理），
  // 而 sticker/语音/视频/分享卡片等提取为空串 ''——它们全部共享同一 dupKey，
  // 会把正常连发图片/表情包误判成刷屏误撤；图片类违规由 qrImage/AI 审核链路处理。
  const isPlaceholderText = raw === '' || raw === '[图片]' || /^\[附件: .*\]$/.test(raw);
  const dupKey = `${chatId}|${senderId}|${stableHash(raw)}`;
  const dupCount = isPlaceholderText ? 0 : pushAndCount(duplicateHistory, dupKey, ts, config.duplicateWindowMs);
  if (dupCount >= config.duplicateThreshold) {
    return { level: 'strong_ad', reason: 'duplicate_burst', detail: `count=${dupCount}` };
  }

  // 链接不再做强特征（2026-11-16）：域名白名单误伤正常技术交流（GitHub/博客/文档等），
  // 改由 AI 审核按上下文判断链接意图（moderation 的 spam 类目）；白名单机制整体移除。

  // 强特征 2：手机号
  if (hasPhoneNumber(raw)) return { level: 'strong_ad', reason: 'phone_number' };

  // 强特征 3：微信号
  if (hasWechatId(raw)) return { level: 'strong_ad', reason: 'wechat_id' };

  // 强特征 4：二维码
  if (hasQrCodeHint(raw)) return { level: 'strong_ad', reason: 'qr_code' };

  // 强特征 5 / 弱特征：网盘链接引流。社区约定正常网盘分享频率低 → 链接单独出现也提醒（weak，
  // 不撤回不计踢）；「链接 × 引流词」在 mode=recall 时撤回，mode=warn 时同样降为提醒观察。
  if (config.netdisk.enabled && config.netdisk.mode !== 'off') {
    const nd = classifyNetdiskText(raw, config.netdisk.diversionWords, config.netdisk.hosts);
    if (nd.level === 'strong') {
      const detail = `${nd.host}${nd.word ? ` + ${nd.word}` : ''}`;
      return config.netdisk.mode === 'recall'
        ? { level: 'strong_ad', reason: 'netdisk_ad', detail }
        : { level: 'weak_ad', reason: 'netdisk_warn', detail };
    }
    if (nd.level === 'warn') {
      return { level: 'weak_ad', reason: 'netdisk_warn', detail: nd.host };
    }
  }

  // 强特征 6 / 弱特征：短链域名引流（2026-11-17）。已知短链服务域名表匹配；永不解链——不对
  // 短链发起任何网络请求（解链有 SSRF/慢请求风险，二期如需须带全套防护另行评审）。
  // 「短链 × 引流词」组合无歧义 → strong；裸短链按 aloneAction（默认 warn 只提醒：
  // t.cn/b23.tv/v.douyin.com 等平台分享短链是正常分享高发区，直接撤回误伤代价高）。
  if (config.shortLink.enabled && config.shortLink.mode !== 'off') {
    const sl = classifyShortLinkText(raw, config.shortLink.diversionWords, config.shortLink.hosts, config.shortLink.aloneAction);
    if (sl.level === 'strong') {
      const detail = `${sl.host}${sl.word ? ` + ${sl.word}` : ''}`;
      return config.shortLink.mode === 'recall'
        ? { level: 'strong_ad', reason: 'shortlink_ad', detail }
        : { level: 'weak_ad', reason: 'shortlink_warn', detail };
    }
    if (sl.level === 'warn') {
      return { level: 'weak_ad', reason: 'shortlink_warn', detail: sl.host };
    }
  }

  // 营销词×新人弱特征与入群时间跟踪已于 2026-11-17 移除：营销词歧义大（"优惠/私聊"在正常
  // 聊天常见），广告意图整体让渡给 AI 审核按语境判断（moderation 的 ad_spam 类目）。

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

// ---------- 群投票管控（vote control） ----------
// 仅群主/群管理员（及 bot 管理员）可在群内发起投票；其他人发起的 vote 消息 → 撤回 + 群内提醒。
// 与广告撤回共用：群覆盖范围（allGroups/allowed chats/excludedChats）、群信息缓存（管理员名单）、
// 撤回接口与提醒卡片。bot 需为群主/管理员/创建者才能撤回他人消息，否则以飞书 API 报错码留痕。
export function isVoteControlCandidate({ chatType, senderType, chatId }) {
  return config.voteControl.enabled
    && chatType === 'group'
    && senderType === 'user'
    && !!chatId
    && !config.excludedChats.includes(chatId)
    && (ctx.allGroups || ctx.isChatAllowed(chatId));
}

/**
 * 处理一条群投票消息（msg_type=vote，content 为 {"topic","options"}）。
 * 返回 true 表示已被本模块接管（调用方应终止后续流程）；false 表示放行或功能未覆盖。
 */
export async function handleVoteMessage({
  messageId, chatId, chatType, senderOpenId, senderName = '', senderType, rawContent = '', rootId = '',
}) {
  if (!isVoteControlCandidate({ chatType, senderType, chatId })) return false;

  let topic = '';
  try { topic = JSON.parse(rawContent)?.topic || ''; } catch {}

  // 豁免：bot 管理员；群主/群管理员（群信息不可用时保守豁免，宁可不撤，不冒误撤管理员的险）
  if (senderOpenId && senderOpenId === ctx.adminOpenId) {
    ctx.log('dim', 'vote', `放行（bot管理员）msg=${messageId?.slice(-8)} from=${senderOpenId?.slice(-8)}`);
    return false;
  }
  if (await isRecallExempt(chatId, senderOpenId)) {
    ctx.log('dim', 'vote', `放行（群主/群管理员）msg=${messageId?.slice(-8)} from=${senderOpenId?.slice(-8)}`);
    return false;
  }

  ctx.log('info', 'vote', `非群主/管理员发起投票 from=${senderName}(${senderOpenId?.slice(-8)}) msg=${messageId?.slice(-8)} topic="${summarize(topic, 40)}" → 撤回`);

  const result = await recallMessageDetailed(messageId);
  if (!result.ok) {
    const known = RECALL_ERROR_HINTS[result.code];
    ctx.log('error', 'vote', `撤回投票失败 msg=${messageId} code=${result.code}${known ? ` (${known})` : ''} ${result.msg?.slice(0, 150)}`);
    return true;
  }

  ctx.log('ok', 'vote', `已撤回投票 msg=${messageId} sender=${senderName}(${senderOpenId?.slice(-8)}) topic="${summarize(topic, 40)}"`);
  try {
    await sendNoticeCard({ chatId, messageId, rootId }, buildRecallNoticeCard('群投票仅限群主或群管理员发起，如有需要请联系群管理员', '🗳️ 投票已被撤回'));
  } catch (err) {
    ctx.log('warn', 'vote', `投票撤回提醒卡片发送失败 msg=${messageId?.slice(-8)}: ${err.message?.slice(0, 150)}`);
  }
  // 撤回成功 → 与其他违规同源计入踢出双窗口（管理员豁免在 noteViolationAndMaybeAsk 内部生效）
  await noteViolationAndMaybeAsk({ chatId, senderOpenId, senderName, reason: 'vote', text: `群投票：${summarize(topic, 40)}` });
  return true;
}

// ---------- 管理员日志群：只发送踢出确认卡片，不再推送撤回/刹车类文本留痕 ----------

function reasonLabel(reason) {
  return REASON_LABELS[reason] || reason;
}

// 卡片文案：广告类特征不向群成员暴露具体判定细节，统一提示「疑似垃圾广告」；
// 辱骂/灰度词/接龙保留各自文案；日志仍记录精确 reason 便于管理员追溯。
const AD_REASONS = new Set(['phone_number', 'wechat_id', 'qr_code', 'duplicate_burst', 'netdisk_ad', 'shortlink_ad']);
function cardReasonLabel(reason) {
  return AD_REASONS.has(reason) ? '疑似垃圾广告或诈骗信息，请注意言辞' : reasonLabel(reason);
}

// ---------- 图像二维码检测（qrImage） ----------
// 只判定「消息里的图片是否存在二维码」，不解码内容、不做语义判断：命中即按 strong_ad/qr_code
// 走与文本广告特征完全相同的撤回链路（安全刹车、权限预检、警示卡片、踢出计数全复用）。
// 白名单（引用回复 / bot 管理员 / 群主 / 群管理员 / 群信息不可用保守豁免）在进入本函数前已过滤。
// 已知不覆盖：表情包（飞书 API 不支持下载表情包资源）、GIF/WebP（解码器只支持 PNG/JPEG，
// 未支持格式在日志中留痕 skipped=…，后续可按占比决定是否补 WebP 解码）。
async function detectQrInMessage({ messageId, msgType, rawContent }) {
  const specs = extractAttachmentSpecs({ message_type: msgType, content: rawContent })
    .filter(spec => spec.type === 'image')
    .slice(0, config.qrImage.maxImagesPerMessage);

  for (const spec of specs) {
    let buffer;
    try {
      buffer = await downloadMessageResourceBuffer(messageId, spec.fileKey, 'image', config.qrImage.maxImageBytes, config.qrImage.downloadTimeoutMs);
    } catch (err) {
      ctx.log('dim', 'qr', `图片下载失败跳过 msg=${messageId?.slice(-8)}: ${err.message?.slice(0, 120)}`);
      continue;
    }

    const result = await detectQrcodeImage(buffer, {
      timeoutMs: config.qrImage.timeoutMs,
      maxDimension: config.qrImage.maxDimension,
    });

    if (result.found) {
      ctx.log('ok', 'qr', `检测到二维码 ${result.format} ${result.width}x${result.height} engine=${result.engine} ${result.ms}ms msg=${messageId?.slice(-8)}`);
      return { found: true, detail: `${result.format} ${result.width}x${result.height} engine=${result.engine} ${result.ms}ms` };
    }
    ctx.log('dim', 'qr', `未检出 msg=${messageId?.slice(-8)} ${result.skipped ? `skipped=${result.skipped}` : `${result.format} ${result.width}x${result.height}`} ${result.ms}ms${result.timedOut ? ' (超时熔断按未检出处理)' : ''}`);
  }
  return { found: false };
}

// ---------- 动作路由 ----------
/**
 * 处理一条群消息。返回 { blocked, warned }：
 *   blocked=true  消息已被本模块接管/撤回（调用方应终止后续流程）
 *   warned=true   已在话题内发出提醒卡片（weak_ad；调用方可据此跳过 AI 审核的重复提醒）
 */
export async function handleAdMessage({
  text, messageId, chatId, chatType, senderOpenId, senderName = '', createTime, isReply, rawContent = '', rootId = '', msgType = '',
}) {
  if (!isAdRecallCandidate({ chatType, senderType: 'user', chatId })) return { blocked: false, warned: false };

  let verdict;
  try {
    verdict = await classifyMessage({ text, senderId: senderOpenId, chatId, createTime, isReply, rawContent });
  } catch (err) {
    ctx.log('error', 'ad-recall', `classify failed msg=${messageId?.slice(-8)}: ${err.message?.slice(0, 200)}`);
    return { blocked: false, warned: false };
  }

  // 图像二维码强特征：文本未触发撤回、且不在任何白名单（引用回复/管理员等，reason 以 whitelist: 前缀
  // 返回）时，对消息内图片（独立 image 或 post 内嵌图）做本地二维码检测；命中升级为 strong_ad 撤回。
  // weak_ad（营销词新人提醒）也可被升级：图片里真有二维码时提醒应让位于撤回。
  if (
    config.qrImage.enabled &&
    verdict.level !== 'strong_ad' &&
    !String(verdict.reason || '').startsWith('whitelist:') &&
    (msgType === 'image' || msgType === 'post')
  ) {
    const qr = await detectQrInMessage({ messageId, msgType, rawContent });
    if (qr.found) {
      ctx.log('info', 'ad-recall', `qr_image hit from=${senderName}(${senderOpenId?.slice(-8)}) msg=${messageId?.slice(-8)} detail=${qr.detail}`);
      verdict = { level: 'strong_ad', reason: 'qr_code', detail: `image ${qr.detail}` };
    }
  }

  if (verdict.level === 'normal') {
    // 白名单放行打点：让「检查了但被豁免」可见；普通无关消息不打，避免刷屏
    if (String(verdict.reason || '').startsWith('whitelist:')) {
      ctx.log('dim', 'ad-recall', `normal (${verdict.reason}) msg=${messageId?.slice(-8)} from=${senderName}(${senderOpenId?.slice(-8)})`);
    }
    return { blocked: false, warned: false };
  }

  ctx.log('info', 'ad-recall', `${verdict.level} (${verdict.reason}) from=${senderName}(${senderOpenId?.slice(-8)}) msg=${messageId?.slice(-8)} text="${summarize(text, 40)}"`);

  // ---- weak_ad：不撤回；在原消息话题内回复统一风格的警示卡片（日志群不发） ----
  if (verdict.level === 'weak_ad') {
    try {
      await sendNoticeCard({ chatId, messageId, rootId }, buildRecallNoticeCard(cardReasonLabel(verdict.reason), '⚠️ 群消息提醒'));
    } catch (err) {
      ctx.log('warn', 'ad-recall', `提醒卡片发送失败 msg=${messageId?.slice(-8)}: ${err.message?.slice(0, 150)}`);
    }
    ctx.log('info', 'ad-recall', `weak_ad 观察记录 from=${senderOpenId?.slice(-8)} reason=${verdict.reason} msg=${messageId?.slice(-8)}`);
    return { blocked: false, warned: true };
  }

  // ---- strong_ad ----
  const now = Date.now();

  // 安全刹车：0=关闭；否则 5 分钟内已实际撤回 ≥ brakeLimit 次 → 暂停自动撤回（仅记本地日志，不发日志群）
  const brakeCount = countRecent(brakeHistory, senderOpenId, now, config.brakeWindowMs);
  if (config.brakeLimit > 0 && brakeCount >= config.brakeLimit) {
    ctx.log('warn', 'ad-recall', `刹车触发：${senderOpenId?.slice(-8)} 5分钟内已撤回 ${brakeCount} 次，暂停自动撤回 msg=${messageId?.slice(-8)}`);
    // 刹车触发同样计入踢出计数（刷屏已确认，撤回虽已暂停）
    await noteViolationAndMaybeAsk({ chatId, senderOpenId, senderName, reason: verdict.reason, text });
    return { blocked: true, warned: false };
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
    return { blocked: true, warned: false };
  }

  // 撤回成功：计数 + 在原消息话题内回复提醒卡片（原因 + 底部警示；日志群只发踢出卡片）
  pushAndCount(brakeHistory, senderOpenId, now, config.brakeWindowMs);
  ctx.log('ok', 'ad-recall', `已撤回 msg=${messageId} sender=${senderName}(${senderOpenId?.slice(-8)}) reason=${verdict.reason}`);
  try {
    await sendNoticeCard({ chatId, messageId, rootId }, buildRecallNoticeCard(cardReasonLabel(verdict.reason)));
  } catch (err) {
    ctx.log('warn', 'ad-recall', `撤回提醒卡片发送失败 msg=${messageId?.slice(-8)}: ${err.message?.slice(0, 150)}`);
  }
  // 撤回成功 → 计入踢出计数（双窗口），达阈值弹管理员确认卡片
  await noteViolationAndMaybeAsk({ chatId, senderOpenId, senderName, reason: verdict.reason, text });
  return { blocked: true, warned: false };
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
  const expired = kase.status === 'expired';
  return {
    config: { wide_screen_mode: true },
    header: { template: kicked ? 'green' : 'grey', title: { tag: 'plain_text', content: kicked ? '✅ 已移出群聊' : expired ? '⏰ 已超时失效' : '⚪ 已忽略' } },
    elements: [
      ...kickCardSections(kase),
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: kicked
        ? `✅ **已移出群聊** · 处理人：${kase.resolvedBy} · ${fmtViolationTs(kase.resolvedAt)}`
        : expired
          ? `⏰ **超时未处理自动失效（计数保留）** · ${fmtViolationTs(kase.resolvedAt)} · 该用户再次达阈值会重新弹卡`
          : `⚪ **已忽略（仅本次，计数保留）** · 处理人：${kase.resolvedBy} · ${fmtViolationTs(kase.resolvedAt)}` } },
    ],
  };
}

// 撤回成功 / 刹车触发后调用：双窗口计数 → 达阈值弹管理员确认卡片（绝不自动踢）
export async function noteViolationAndMaybeAsk({ chatId, senderOpenId, senderName = '', reason, text }) {
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
        // 卡片超时未处理（默认 1 小时）→ 自动失效：计数保留、旧卡更新为超时样式，允许本次重新弹新卡
        if (Date.now() - c.createdAt >= config.kick.pendingExpireMs) {
          c.status = 'expired';
          c.resolvedAt = Date.now();
          c.resolvedBy = 'system（超时失效）';
          persistKickCases();
          ctx.log('warn', 'ad-recall', `踢出卡片超时未处理自动失效 case=${c.id}，达阈值重新弹卡`);
          await updateCardMessageSafe(c);
          break; // 继续走下方弹新卡流程
        }
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
  if (kase.status !== 'pending') {
    const label = kase.status === 'kicked' ? '已移出' : kase.status === 'expired' ? '已超时失效，请处理重新弹出的新卡片' : '已忽略';
    return { ok: true, msg: `该案例已处理（${label}）` };
  }

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
