// 探测 Agent 定义结构 + 尝试关闭 thinking 并复测延迟。
// 只做三件事：GET agent 看真实形状 → 按候选形状更新 → 跑 5 个判定对比 turn 耗时。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_KEY = readFileSync(join(PROJECT_ROOT, '.secrets/zhipu.key'), 'utf-8').trim();
const BASE_URL = 'https://agent-api.bigmodel.cn/api/agent/managed';
const ENVIRONMENT_ID = 'env_01a19a33-a188-7206-8903-59eeddcb5731';
const AGENT_NAME = 'moderation-classifier-verify';

const headers = {
  'Authorization': `Bearer ${API_KEY}`,
  'zai-version': '2026-05-26',
  'zai-beta': 'managed-agents-2026-09-22',
  'content-type': 'application/json',
};
async function api(path, method = 'GET', body) {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: res.status, json };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. 找到现有 agent 并打印完整定义
const listed = await api('/v1/agents?limit=100');
const items = listed.json?.data || listed.json?.items || [];
const agent = items.find(a => a?.name === AGENT_NAME);
console.log('=== 当前 agent 定义（完整） ===');
console.log(JSON.stringify(agent, null, 2));

// 2. 候选更新形状：试图关 thinking / 降 effort（400 即换下一个）
const candidates = [
  { model: { name: 'glm-5.3-flash', thinking: { type: 'disabled' } } },
  { model: { name: 'glm-5.3-flash', thinking: { enabled: false } } },
  { model: { name: 'glm-5.3-flash', effort: 'low' } },
  { thinking: { type: 'disabled' } },
  { effort: 'low' },
];
let updated = null;
for (const patch of candidates) {
  const r = await api(`/v1/agents/${agent.id}`, 'POST', patch);
  console.log(`\n尝试 ${JSON.stringify(patch)} → ${r.status}`);
  if (r.status === 200 || r.status === 201) { updated = r.json; break; }
  console.log(JSON.stringify(r.json).slice(0, 200));
}
if (updated) {
  console.log('更新成功，最新定义:');
  console.log(JSON.stringify(updated, null, 2).slice(0, 800));
} else {
  console.log('所有候选形状都被拒，thinking 开关待查文档（问研发）');
}

// 3. 复测：5 个判定看 turn 耗时
const SYSTEM = agent?.system || 'You are a strict content-moderation classifier.';
async function judge(text) {
  const t0 = Date.now();
  const c = await api('/v1/sessions', 'POST', { agent: agent.id, environment_id: ENVIRONMENT_ID, title: 'ma-verify' });
  const sid = c.json?.id;
  const t1 = Date.now();
  await api(`/v1/sessions/${sid}/events`, 'POST', { events: [{ type: 'user.message', content: [{ type: 'text', text: `<message>${JSON.stringify(text)}</message>` }] }] });
  const t2 = Date.now();
  let idle = false, out = '', thinking = '';
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !idle) {
    await sleep(500);
    const h = await api(`/v1/sessions/${sid}/events?limit=100&order=asc`);
    for (const ev of (h.json?.data || [])) {
      if (ev?.type === 'agent.message') out = (ev.content || []).map(b => b.text || '').join('');
      if (ev?.type === 'agent.thinking') thinking = (ev.content || []).map(b => b.text || '').join('');
      if (ev?.type === 'session.status_idle') idle = true;
    }
  }
  const t3 = Date.now();
  api(`/v1/sessions/${sid}`, 'DELETE').catch(() => {});
  return { create: t1 - t0, turn: t3 - t2, total: t3 - t0, idle, out: out.slice(0, 80), thought: thinking.slice(0, 40) };
}
console.log('\n=== 复测 5 条（看 turn 是否下降 / thinking 是否消失） ===');
for (let i = 0; i < 5; i++) {
  const r = await judge(['今天吃什么', '加微信低价卖课速来', '这功能真难用', '打我电话13812345678', '哈哈哈哈'][i]);
  console.log(`  create=${String(r.create).padStart(4)}ms turn=${String(r.turn).padStart(5)}ms thinking="${r.thought}" → ${r.out}`);
  await sleep(800);
}
