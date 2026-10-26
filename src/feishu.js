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

// 解析 markdown 表格行
function parseTableRow(line) {
  return line.split('|').slice(1, -1).map(c => c.trim());
}

// 单个 markdown 表格 → 飞书卡片 table 元素
function mdTableToCardElement(headerLine, dataLines) {
  const headers = parseTableRow(headerLine);
  const columns = headers.map((name, i) => ({
    name: `c${i}`,
    display_name: name,
    data_type: 'lark_md',
    width: 'auto',
  }));
  const rows = dataLines.map(line => {
    const cells = parseTableRow(line);
    const row = {};
    columns.forEach((col, i) => { row[col.name] = cells[i] || ''; });
    return row;
  });
  return {
    tag: 'table',
    page_size: Math.min(rows.length, 20),
    row_height: 'low',
    header_style: { bold: true, background_style: 'blue', align: 'left' },
    columns,
    rows,
  };
}

// Unicode box-drawing 表格 → Markdown pipe table（让 buildCardElements 能识别并渲染为飞书卡片表格）
function convertBoxTables(text) {
  const isBoxLine = s => s && /^[┌┐└┘┬┴├┤┼│─]/.test(s.trim());

  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    if (!isBoxLine(lines[i])) {
      result.push(lines[i]);
      i++;
      continue;
    }

    const blockStart = i;
    while (i < lines.length && isBoxLine(lines[i])) i++;
    const block = lines.slice(blockStart, i);

    // 提取数据行（以 │ 开头的行）
    const dataRows = block.filter(line => line.trim().startsWith('│'));
    if (dataRows.length === 0) {
      result.push(...block);
      continue;
    }

    // 按可见 │ 分割单元格
    const rows = dataRows.map(line => {
      const t = line.trim();
      const parts = t.split('│');
      if (parts[0] === '') parts.shift();
      if (t.endsWith('│') && parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
      return parts.map(c => c.trim());
    });

    // 分离标题行（1 列）和数据行（2+ 列）
    const titles = [];
    const tableRows = [];
    for (const row of rows) {
      if (row.length === 1) titles.push(row[0]);
      else tableRows.push(row);
    }

    for (const t of titles) {
      if (t) result.push(`**${t}**`);
    }

    if (tableRows.length > 0) {
      const cols = tableRows[0].length;
      result.push('| ' + tableRows[0].join(' | ') + ' |');
      result.push('| ' + tableRows[0].map(() => '---').join(' | ') + ' |');
      for (let r = 1; r < tableRows.length; r++) {
        const padded = tableRows[r].length < cols
          ? tableRows[r].concat(Array(cols - tableRows[r].length).fill(''))
          : tableRows[r];
        result.push('| ' + padded.join(' | ') + ' |');
      }
    }
  }

  return result.join('\n');
}

// 清洗飞书卡片不支持的 markdown：图片语法、超长 URL、HTML 标签
function sanitizeForCard(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]')                        // ![alt](url) → [alt]
    .replace(/\[([^\]]*)\]\(https?:\/\/[^\s)]{200,}\)/g, '$1')         // [text](超长URL) → text
    .replace(/<img[^>]*>/gi, '')                                        // strip <img> tags
    .replace(/<[^>]+>/g, m => /^<(https?:\/\/|\/)/.test(m) ? m : '')  // strip non-link HTML tags
    .replace(/&#x[0-9a-fA-F]+;/g, '')                                  // strip HTML entities
    .trim();
}

// 拆分文本为 markdown 元素 + table 元素的混合数组
function buildCardElements(text) {
  text = sanitizeForCard(convertBoxTables(text));
  const elements = [];
  const lines = text.split('\n');
  let i = 0;
  const isPipeRow = s => /^\|.+\|$/.test(s);
  const isSepRow = s => /^\|[-:| ]+\|$/.test(s);

  while (i < lines.length) {
    if (i + 2 < lines.length && isPipeRow(lines[i]) && isSepRow(lines[i + 1]) && isPipeRow(lines[i + 2])) {
      // 表格开始：表头 + 分隔 + 至少一行数据
      const headerLine = lines[i];
      const dataLines = [];
      let j = i + 2;
      while (j < lines.length && isPipeRow(lines[j])) { dataLines.push(lines[j]); j++; }
      elements.push(mdTableToCardElement(headerLine, dataLines));
      i = j;
    } else {
      const buf = [];
      while (i < lines.length) {
        if (i + 2 < lines.length && isPipeRow(lines[i]) && isSepRow(lines[i + 1]) && isPipeRow(lines[i + 2])) break;
        buf.push(lines[i]);
        i++;
      }
      const content = buf.join('\n').trim().replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
      if (content) elements.push({ tag: 'markdown', content });
    }
  }
  return elements.length > 0 ? elements : [{ tag: 'markdown', content: text }];
}

// 消息卡片：混合 markdown + table 元素
function toCardContent(text) {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: buildCardElements(text),
  });
}

/**
 * 回复消息（话题线程中），纯文本（卡片发送 400 时的降级方案）
 */
export async function replyTextMessage(messageId, text) {
  const resp = await getClient().im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
  return { messageId: resp.data.message_id };
}

/**
 * 回复消息（话题线程中），使用 interactive 卡片渲染 markdown
 */
export async function replyMessage(messageId, text) {
  const resp = await getClient().im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'interactive',
      content: toCardContent(text),
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
      content: toCardContent(text),
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
 * 主动发消息给用户（用于定时任务等场景）
 */
export async function sendDirectMessage(userId, text) {
  const resp = await getClient().im.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: userId,
      msg_type: 'interactive',
      content: toCardContent(text),
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
