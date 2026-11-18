// 最后一轮：试 speed=fast 和 glm-5.3-flashx，各测 5 条，选最优配置。
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

const listed = await api('/v1/agents?limit=100');
const agent = (listed.json?.data || []).find(a => a?.name === AGENT_NAME);

async function tryPatch(patch, label) {
  const r = await api(`/v1/agents/${agent.id}`, 'POST', patch);
  console.log(`[patch] ${label} → ${r.status}`);
  if (r.status >= 300) { console.log('  ' + JSON.stringify(r.json).slice(0, 160)); return false; }
  const check = await api(`/v1/agents/${agent.id}`);
  console.log('  生效: ' + JSON.stringify(check.json?.model || check.json?.data?.model));
  return true;
}

async function bench(n = 5) {
  const texts = ['今天中午吃什么', '加微信 abc123456 低价卖课速来', '这产品越做越难用', '有事打我电话 13812345678', '哈哈哈哈😂'];
  const totals = [];
  for (const text of texts) {
    const t0 = Date.now();
    const c = await api('/v1/sessions', 'POST', { agent: agent.id, environment_id: ENVIRONMENT_ID, title: 'ma-verify' });
    const sid = c.json?.id;
    await api(`/v1/sessions/${sid}/events`, 'POST', { events: [{ type: 'user.message', content: [{ type: 'text', text: `<message>${JSON.stringify(text)}</message>` }] }] });
    let idle = false, out = '';
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !idle) {
      await sleep(500);
      const h = await api(`/v1/sessions/${sid}/events?limit=100&order=asc`);
      for (const ev of (h.json?.data || [])) {
        if (ev?.type === 'agent.message') out = (ev.content || []).map(b => b.text || '').join('');
        if (ev?.type === 'session.status_idle') idle = true;
      }
    }
    const total = Date.now() - t0;
    totals.push(total);
    let dec = 'PARSE-FAIL';
    try { dec = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || 'null')?.decision || 'PARSE-FAIL'; } catch {}
    api(`/v1/sessions/${sid}`, 'DELETE').catch(() => {});
    console.log(`    total=${String(total).padStart(6)}ms → ${dec}`);
    await sleep(800);
  }
  const s = [...totals].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length * 0.5)], max: s[s.length - 1] };
}

// 变体 A：speed=fast
console.log('=== 变体 A: speed=fast, effort=low, glm-5.3-flash ===');
if (await tryPatch({ model: { id: 'glm-5.3-flash', effort: { type: 'low' }, speed: 'fast' } }, 'speed=fast')) {
  const a = await bench();
  console.log(`  A 结果: P50=${a.p50}ms max=${a.max}ms`);
}

// 变体 B：flashx
console.log('\n=== 变体 B: model=glm-5.3-flashx, effort=low, speed=standard ===');
if (await tryPatch({ model: { id: 'glm-5.3-flashx', effort: { type: 'low' }, speed: 'standard' } }, 'flashx')) {
  const b = await bench();
  console.log(`  B 结果: P50=${b.p50}ms max=${b.max}ms`);
}
