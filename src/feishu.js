// 飞书 API 封装

import lark from '@larksuiteoapi/node-sdk';
import { join, basename } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { createWriteStream, createReadStream } from 'fs';

let client = null;

export function initFeishuClient(appId, appSecret) {
  client = new lark.Client({ appId, appSecret });
  return client;
}

export function getClient() {
  if (!client) throw new Error('Feishu client not initialized.');
  return client;
}

// 飞书 text 消息不渲染 markdown：发送前把常见 markdown 语法降级为可读纯文本
function toPlainText(text) {
  if (typeof text !== 'string' || !text) return text;

  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };
  const fromCode = code => { try { return String.fromCodePoint(code); } catch { return ''; } };

  // 行内 markdown → 纯文本（仅作用于非代码行）
  const inline = s => s
    .replace(/^#{1,6}\s+(.+)$/, '$1')                                // # 标题 → 正文
    .replace(/\*\*(.+?)\*\*/g, '$1')                                 // **加粗** → 加粗
    .replace(/~~(.+?)~~/g, '$1')                                     // ~~删除线~~ → 删除线
    .replace(/`([^`\n]+)`/g, '$1')                                   // `行内代码` → 行内代码
    .replace(/!\[([^\]]*)\]\([^)\s]*\)/g, (m, alt) => alt ? `[图片:${alt}]` : '[图片]') // ![alt](url)
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, t, u) => (t && t !== u) ? `${t} (${u})` : u) // [文字](url) → 文字 (url)
    .replace(/^>\s?/, '')                                            // 行首引用符 >
    .replace(/<img[^>]*>/gi, '[图片]')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => fromCode(parseInt(h, 16)))  // 数字 HTML 实体还原
    .replace(/&#(\d+);/g, (m, d) => fromCode(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|nbsp);/g, (m, n) => entities[n]);

  // 逐行处理：去代码围栏行，代码块内容原样保留；去表格分隔行 |---|---|
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { out.push(line); continue; }
    if (/^\s*\|[-:| ]+\|\s*$/.test(line)) continue;
    out.push(inline(line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 文本消息 content：{"text": "..."}（发送前清洗 markdown）
function toTextContent(text) {
  return JSON.stringify({ text: toPlainText(text) });
}

/**
 * 回复消息（话题线程中），纯文本
 */
export async function replyTextMessage(messageId, text) {
  const resp = await getClient().im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'text',
      content: toTextContent(text),
    },
  });
  return { messageId: resp.data.message_id };
}

/**
 * 回复消息（话题线程中），纯文本
 */
export async function replyMessage(messageId, text) {
  const resp = await getClient().im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'text',
      content: toTextContent(text),
    },
  });
  return { messageId: resp.data.message_id };
}

/**
 * 给消息添加表情（如 Typing）
 */
export async function addReaction(messageId, emojiType) {
  const resp = await getClient().im.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: emojiType } },
  });
  return { reactionId: resp?.data?.reaction_id };
}

/**
 * 删除消息上的表情
 */
export async function deleteReaction(messageId, reactionId) {
  await getClient().im.messageReaction.delete({
    path: { message_id: messageId, reaction_id: reactionId },
  });
}

/**
 * 更新已发送的消息内容
 */
export async function updateMessage(messageId, text) {
  await getClient().im.message.patch({
    path: { message_id: messageId },
    data: {
      content: toTextContent(text),
    },
  });
}

/**
 * 撤回消息。撤回群内他人消息时，机器人必须是群主、管理员或创建者。
 */
export async function recallMessage(messageId) {
  if (!messageId?.startsWith('om_')) throw new Error('invalid message_id');
  const resp = await getClient().im.message.delete({
    path: { message_id: messageId },
  });
  if (resp?.code && resp.code !== 0) throw new Error(resp.msg || `Feishu error ${resp.code}`);
  return resp?.data || {};
}

/**
 * 撤回消息（详细版）：返回 { ok, code, msg } 而不是抛错，
 * 供广告撤回模块捕获 230026（无权限）/ 230009（超时限）/ 230050（消息不可见）等错误码写日志。
 * 对应 DELETE /open-apis/im/v1/messages/{message_id}。
 */
export async function recallMessageDetailed(messageId) {
  if (!messageId?.startsWith('om_')) return { ok: false, code: -1, msg: 'invalid message_id' };
  try {
    const resp = await getClient().im.message.delete({
      path: { message_id: messageId },
    });
    if (resp?.code && resp.code !== 0) {
      return { ok: false, code: resp.code, msg: resp.msg || `Feishu error ${resp.code}` };
    }
    return { ok: true, code: 0, msg: '' };
  } catch (err) {
    return {
      ok: false,
      code: err?.code ?? err?.response?.data?.code ?? -1,
      msg: err?.msg || err?.message || 'unknown error',
    };
  }
}

/**
 * 主动发送消息到群聊（用于撤回原因通知等）
 */
export async function sendChatMessage(chatId, text) {
  if (!chatId?.startsWith('oc_')) throw new Error('invalid chat_id');
  const resp = await getClient().im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: toTextContent(text),
    },
  });
  return { messageId: resp.data.message_id };
}

/**
 * 主动发消息给用户（用于定时任务等场景）
 */
export async function sendDirectMessage(userId, text) {
  const resp = await getClient().im.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: userId,
      msg_type: 'text',
      content: toTextContent(text),
    },
  });
  return { messageId: resp.data.message_id };
}

/**
 * 拉取消息里的 @ 用户，优先使用事件 mentions 字段，post 内容作为兜底。
 */
export function extractMessageMentions(rawMsg) {
  const byOpenId = new Map();

  function addMention(openId, name = '', key = '') {
    if (!openId || !openId.startsWith('ou_')) return;
    const existing = byOpenId.get(openId) || { openId, name, key };
    if (!existing.name && name) existing.name = name;
    if (!existing.key && key) existing.key = key;
    byOpenId.set(openId, existing);
  }

  for (const mention of rawMsg?.mentions || []) {
    addMention(mention?.id?.open_id, mention?.name, mention?.key);
  }

  try {
    const content = JSON.parse(rawMsg?.content || '{}');
    if (rawMsg?.message_type === 'post') {
      const locale = content.zh_cn || content.en_us || content.ja_jp || content;
      for (const paragraph of locale?.content || []) {
        if (!Array.isArray(paragraph)) continue;
        for (const element of paragraph) {
          if (element?.tag === 'at' && element.user_id) {
            addMention(element.user_id, element.user_name || '');
          }
        }
      }
    }
  } catch {}

  return [...byOpenId.values()];
}

/**
 * 添加群成员。openIds 最多 50 个。
 */
export async function addChatMembers(chatId, openIds) {
  if (!chatId?.startsWith('oc_')) throw new Error('invalid chat_id');
  if (!Array.isArray(openIds) || openIds.length === 0 || openIds.length > 50) {
    throw new Error('用户数量必须在 1-50 之间');
  }

  const resp = await getClient().im.chatMembers.create({
    path: { chat_id: chatId },
    params: { member_id_type: 'open_id' },
    data: { id_list: openIds },
  });
  if (resp?.code && resp.code !== 0) throw new Error(resp.msg || `Feishu error ${resp.code}`);
  return resp?.data || {};
}

/**
 * 移除群成员。openIds 最多 50 个。
 */
export async function removeChatMembers(chatId, openIds) {
  if (!chatId?.startsWith('oc_')) throw new Error('invalid chat_id');
  if (!Array.isArray(openIds) || openIds.length === 0 || openIds.length > 50) {
    throw new Error('用户数量必须在 1-50 之间');
  }

  const resp = await getClient().im.chatMembers.delete({
    path: { chat_id: chatId },
    params: { member_id_type: 'open_id' },
    data: { id_list: openIds },
  });
  if (resp?.code && resp.code !== 0) throw new Error(resp.msg || `Feishu error ${resp.code}`);
  return resp?.data || {};
}

/**
 * 指定群管理员。用户可使用 open_id/user_id/union_id；机器人使用 app_id。
 */
export async function addChatManagers(chatId, managerIds, managerIdType = 'open_id') {
  const validIdTypes = new Set(['open_id', 'user_id', 'union_id', 'app_id']);
  if (!chatId?.startsWith('oc_')) throw new Error('invalid chat_id');
  if (!validIdTypes.has(managerIdType)) throw new Error('invalid member_id_type');
  if (!Array.isArray(managerIds) || managerIds.length === 0 || managerIds.length > 50) {
    throw new Error('管理员数量必须在 1-50 之间');
  }
  if (managerIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('invalid manager id');
  }

  const resp = await getClient().im.chatManagers.addManagers({
    path: { chat_id: chatId },
    params: { member_id_type: managerIdType },
    data: { manager_ids: managerIds.map(id => id.trim()) },
  });
  if (resp?.code && resp.code !== 0) throw new Error(resp.msg || `Feishu error ${resp.code}`);
  return resp?.data || {};
}

/**
 * 提取事件中的消息文本
 */
function extractPostText(content) {
  // 两种格式：
  // 1. 带语言包裹: { "zh_cn": { "title": "", "content": [...] } }
  // 2. 直接结构:   { "title": "", "content": [...] }
  let locale = content;
  if (content.content) {
    locale = content;
  } else {
    locale = content.zh_cn || content.en_us || content.ja_jp || Object.values(content).find(v => v && typeof v === 'object' && v.content);
  }
  if (!locale || !Array.isArray(locale.content)) return '';
  const lines = [];
  if (locale.title) lines.push(locale.title);
  for (const paragraph of locale.content) {
    if (!Array.isArray(paragraph)) continue;
    const line = paragraph.map(el => {
      if (el.tag === 'text') return el.text || '';
      if (el.tag === 'a') return el.text || el.href || '';
      if (el.tag === 'at') return el.user_id ? `@${el.user_id}` : '';
      return '';
    }).join('');
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/**
 * 获取单条消息内容（用于 topic 场景获取原始消息）
 * 飞书 im.message.get 返回结构和事件结构不同：
 *   事件: msg.message_type, msg.content
 *   API:  msg.body.content_type, msg.body.content
 */
export async function getOriginalMessage(messageId, logFn) {
  try {
    const resp = await getClient().im.message.get({
      path: { message_id: messageId },
    });
    const msg = resp?.data?.items?.[0];
    if (!msg) {
      logFn?.('warn', 'topic-api', `no items in response`);
      return null;
    }
    // 兼容两种结构：API 返回用 body.content/body.content_type，事件用 content/message_type
    const msgType = msg.body?.content_type || msg.message_type || '';
    const rawContent = msg.body?.content || msg.content || '{}';
    logFn?.('info', 'topic-api', `msgType=${msgType} content=${rawContent.slice(0, 200)}`);

    let text = '';
    const content = JSON.parse(rawContent);
    // 统一按内容结构解析，不依赖 msgType（API 可能不返回 type）
    if (content.text !== undefined) {
      // 纯文本消息
      text = content.text || '';
    } else if (content.elements) {
      // 卡片/interactive 消息：从 elements 提取纯文本
      const elements = content.elements || [];
      const parts = [];
      for (const row of elements) {
        const elArr = Array.isArray(row) ? row : [row];
        for (const el of elArr) {
          if (el.tag === 'text') parts.push(el.text || '');
          else if (el.tag === 'a') parts.push(el.text || el.href || '');
        }
      }
      text = parts.join('') || '[卡片消息]';
    } else if (content.title !== undefined || content.content !== undefined) {
      // post 富文本消息
      text = extractPostText(content);
    } else if (content.file_name) {
      text = `[附件: ${content.file_name}]`;
    } else if (content.image_key) {
      text = '[图片]';
    }
    const senderOpenId = msg.sender?.sender_id?.open_id || '';
    return { text, senderOpenId, messageType: msgType, createTime: msg.create_time };
  } catch (err) {
    logFn?.('error', 'topic-api', `error: ${err.message?.slice(0, 300)}`);
    return null;
  }
}

export function extractMessageText(data) {
  const msg = data?.message;
  if (!msg) return '';
  try {
    const content = JSON.parse(msg.content || '{}');
    if (msg.message_type === 'text') {
      return content.text || '';
    }
    if (msg.message_type === 'post') {
      return extractPostText(content);
    }
    if (msg.message_type === 'file') {
      return `[附件: ${content.file_name || '未知文件'}]`;
    }
    if (msg.message_type === 'image') {
      return `[图片]`;
    }
  } catch {
    return msg.content || '';
  }
  return '';
}

/**
 * 提取消息中的所有附件规格（fileKey / fileName / type）
 * 覆盖三种来源：
 *   1. 独立 image 消息（message_type=image）
 *   2. 独立 file 消息（message_type=file）
 *   3. post 富文本消息内嵌的 img / file 元素
 *      —— 飞书话题（topic）里"图文混排"消息是 post 类型，图片作为
 *         {tag:'img', image_key} 内嵌，不会被 message_type=image 捕获，
 *         必须遍历 post.content 单独提取，否则话题里的图片永远读不到。
 */
export function extractAttachmentSpecs(rawMsg) {
  const msgType = rawMsg?.message_type;
  const specs = [];
  try {
    const content = JSON.parse(rawMsg?.content || '{}');
    if (msgType === 'image') {
      if (content.image_key) specs.push({ fileKey: content.image_key, fileName: `image_${content.image_key.slice(-16)}.png`, type: 'image' });
    } else if (msgType === 'file') {
      if (content.file_key) specs.push({ fileKey: content.file_key, fileName: content.file_name || `file_${content.file_key.slice(-16)}`, type: 'file' });
    } else if (msgType === 'post') {
      const locale = content.zh_cn || content.en_us || content.ja_jp || content;
      if (Array.isArray(locale?.content)) {
        let imgIdx = 0;
        let fileIdx = 0;
        for (const para of locale.content) {
          if (!Array.isArray(para)) continue;
          for (const el of para) {
            if (el?.tag === 'img' && el.image_key) {
              imgIdx++;
              specs.push({ fileKey: el.image_key, fileName: `image_${imgIdx}_${el.image_key.slice(-16)}.png`, type: 'image' });
            } else if (el?.tag === 'file' && el.file_key) {
              fileIdx++;
              specs.push({ fileKey: el.file_key, fileName: el.file_name || `file_${fileIdx}_${el.file_key.slice(-16)}`, type: 'file' });
            }
          }
        }
      }
    }
  } catch {}
  return specs;
}

export async function downloadMessageFile(messageId, fileKey, fileName, saveDir, fileType = 'file') {
  await mkdir(saveDir, { recursive: true });
  const savePath = join(saveDir, fileName);

  const resp = await getClient().im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: fileType },
  });

  // SDK 文件下载响应: { writeFile, getReadableStream, headers }
  // 没有 resp.data — 直接用 resp.writeFile() 写盘
  if (resp?.writeFile && typeof resp.writeFile === 'function') {
    await resp.writeFile(savePath);
  } else if (resp?.getReadableStream && typeof resp.getReadableStream === 'function') {
    const stream = resp.getReadableStream();
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(savePath);
      stream.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
  } else {
    throw new Error('Unexpected download response: no writeFile or getReadableStream');
  }

  return savePath;
}

// 文件扩展名 → 飞书 im file_type（飞书无 html 枚举，一律用 stream 兜底）
const FILE_TYPE_MAP = {
  pdf: 'pdf',
  doc: 'opus', docx: 'opus',
  xls: 'sheet', xlsx: 'sheet',
  ppt: 'slide', pptx: 'slide',
  mp4: 'mp4', mov: 'mp4',
  html: 'stream', htm: 'stream',
  txt: 'stream', csv: 'stream', md: 'stream', json: 'stream',
};
export function feishuFileType(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  return FILE_TYPE_MAP[ext] || 'stream';
}

/**
 * 上传文件到飞书，返回 file_key（用于发 file 类型消息）
 */
export async function uploadFile(filePath, fileType) {
  const resp = await getClient().im.file.create({
    data: {
      file_type: fileType || feishuFileType(filePath),
      file_name: basename(filePath),
      file: createReadStream(filePath),
    },
  });
  // node-sdk file.create 返回 file_key 可能在 resp.data.file_key 或 resp 顶层，兼容两种
  const fileKey = resp?.data?.file_key || resp?.file_key || resp?.fileKey;
  if (!fileKey) {
    throw new Error(`uploadFile failed: ${JSON.stringify(resp).slice(0, 200)}`);
  }
  return fileKey;
}

/**
 * 回复文件消息给对方（在话题线程中）
 */
export async function replyWithFile(messageId, filePath, fileType) {
  const fileKey = await uploadFile(filePath, fileType);
  const resp = await getClient().im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
  return { messageId: resp.data.message_id, fileKey };
}
