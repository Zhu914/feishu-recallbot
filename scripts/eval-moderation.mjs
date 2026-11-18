// 谐音/缩写脏话检测评测器：
//   node scripts/eval-moderation.mjs --layer det            # 确定性层（词表+归一化），离线、零成本
//   node scripts/eval-moderation.mjs --layer ma             # MA 全链路（glm-5.3-flashx），逐条真实调用
//   node scripts/eval-moderation.mjs --layer ma --policy old  # 用旧版 4 行 policy 跑（A/B 对照）
//   可加 --tag homophone / --id ng / --limit 10 过滤。
// 判定档位与线上对应：block=撤回+计踢，warn=仅提醒卡，allow=放行。
// 评测集：config/moderation-eval.jsonl（策略参数入 git）。报告落 outputs/。
// 注意：MA 模式会把审计写进 outputs/（MODERATION_AUDIT_FILE 重定向），不污染线上审计文件。

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const layer = getArg('layer') || 'det';
const policyMode = getArg('policy') || 'new'; // new=config/moderation.json（默认），old=旧版4行policy
const tagFilter = getArg('tag');
const idFilter = getArg('id');
const limit = Number(getArg('limit')) || Infinity;

// —— env 先于一切 MA 相关调用设置（moderation.js 在 initModeration() 时读 env）——
process.env.MODERATION_ENABLED = 'true';
process.env.MODERATION_RECALL_ENABLED = 'true'; // recall 桩为 no-op，只为让 shouldRecall 路径完整走通
process.env.MODERATION_NOTIFY_ADMIN = 'true';   // notifyAdmin 桩用于捕获 decision/confidence
process.env.MODERATION_AUDIT_FILE = 'outputs/moderation-eval-audit.jsonl';
if (policyMode === 'old') {
  process.env.MODERATION_POLICY = [
    '拦截明确违法违规、严重辱骂或人身攻击、骚扰、色情低俗、暴力恐吓、垃圾广告、诈骗、泄露敏感个人信息的内容。',
    '链接按意图判断：正常交流中的技术/资料分享链接（GitHub、博客、文档、新闻等）应 allow；导流、推销、兼职刷单、收费服务、博彩色情等链接属于垃圾广告，应 block。',
    '不确定但可能违规时返回 review，不直接 block。',
    '普通批评、抱怨、讽刺、玩笑、观点分歧，且没有攻击特定人或群体时返回 allow。',
  ].join('\n');
}

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CASES_FILE = new URL('../config/moderation-eval.jsonl', import.meta.url);

const cases = readFileSync(CASES_FILE, 'utf-8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  .filter((c) => !tagFilter || c.tag === tagFilter)
  .filter((c) => !idFilter || c.id.startsWith(idFilter))
  .slice(0, limit);

const results = [];

if (layer === 'det' || layer === 'pipeline') {
  const { detectProfanityWord, classifyNetdiskText, classifyShortLinkText } = await import('../src/ad-recall.js');
  const cfg = JSON.parse(readFileSync(new URL('../config/ad-recall.json', import.meta.url), 'utf-8'));
  const homophones = cfg.profanity?.homophones || {};
  // 网盘层参数：diversionWords 留空用内置默认；hosts 为追加语义，config 非空时评测只跑 config 列表
  //（与生产「默认+追加」合并有差异，但追加项与默认表同一匹配实现，风险低）
  const ndWords = cfg.netdisk?.diversionWords?.length ? cfg.netdisk.diversionWords : undefined;
  const ndHosts = cfg.netdisk?.hosts?.length ? cfg.netdisk.hosts : undefined;
  // 短链层参数：hosts 为覆盖语义（非空=整体替换默认表，与生产一致）；diversionWords 缺省共用 netdisk 的表
  const slWords = cfg.shortLink?.diversionWords?.length ? cfg.shortLink.diversionWords : ndWords;
  const slHosts = cfg.shortLink?.hosts?.length ? cfg.shortLink.hosts : undefined;
  const slAlone = ['warn', 'recall', 'pass'].includes(cfg.shortLink?.aloneAction) ? cfg.shortLink.aloneAction : 'warn';
  for (const c of cases) {
    if (c.tag === 'netdisk' || c.tag === 'shortlink') {
      // 网盘/短链桶走各自纯函数（与生产 classifyMessage 同一实现；mode 降档不在评测范围）
      const r = c.tag === 'netdisk'
        ? classifyNetdiskText(c.text, ndWords, ndHosts)
        : classifyShortLinkText(c.text, slWords, slHosts, slAlone);
      const got = r.level === 'strong' ? 'block' : r.level === 'warn' ? 'warn' : 'det-pass';
      results.push({ ...c, got, hit: r.host ? `${r.host}${r.word ? ` +${r.word}` : ''}` : '', ms: 0 });
      continue;
    }
    const strongHit = detectProfanityWord(c.text, cfg.profanity.words, homophones);
    const weakHit = strongHit ? '' : detectProfanityWord(c.text, cfg.profanity.warnWords, homophones);
    const got = strongHit ? 'block' : weakHit ? 'warn' : 'det-pass';
    results.push({ ...c, got, hit: strongHit || weakHit, ms: 0 });
  }
}

let maStatus = null;
let runMaCase; // (case) => Promise<{got, ms, captured}>
if (layer === 'ma' || layer === 'pipeline') {
  const { initModeration, moderateMessage } = await import('../src/moderation.js');
  const log = (level, tag, msg) => { if (level === 'error') console.error(`  [${tag}] ${msg}`); };
  maStatus = initModeration(log);
  console.log(`# MA model=${maStatus.model} threshold=${maStatus.confidenceThreshold} warn=${maStatus.warnThreshold} policy来源=${maStatus.policySource ?? '未知'}(${maStatus.policyLength ?? '?'}字)`);
  runMaCase = async (c) => {
    let captured = null; // {decision, confidence}，从 notifyAdmin 桩里抓
    const t0 = Date.now();
    const blocked = await moderateMessage({
      text: c.text,
      messageId: `eval_${c.id}`,
      chatId: 'oc_eval',
      chatType: 'group',
      senderType: 'user',
      senderOpenId: 'ou_eval',
      recall: async () => {}, // 桩：不真撤回
      sendRecallNotice: async (cls) => { captured = cls; },
      sendWarnNotice: async (cls) => { captured = cls; },
      notifyAdmin: async (message) => {
        const d = message.match(/decision: (\w+)/)?.[1];
        const cf = Number(message.match(/confidence: ([\d.]+)/)?.[1]);
        if (d) captured = { decision: d, confidence: Number.isFinite(cf) ? cf : 0 };
      },
      log,
    });
    const ms = Date.now() - t0;
    let got = 'allow';
    if (blocked) got = 'block';
    else if (captured) {
      const { decision, confidence } = captured;
      if (decision === 'block' && confidence >= maStatus.confidenceThreshold) got = 'block';
      else if ((decision === 'block' || decision === 'review') && confidence >= maStatus.warnThreshold) got = 'warn';
      else if (decision === 'block') got = 'warn'; // block 但低置信：线上 below-threshold 只留审计，评测按 warn 口径观察
    }
    return { got, ms, captured: captured ? `${captured.decision}/${captured.confidence}` : '' };
  };
}

if (layer === 'pipeline') {
  // 生产链路模拟：确定性层先拦截（命中即终审，warn 档跳过 AI——与 index.js 词表优先语义一致），
  // 只有 det-pass 的消息才进 MA。MA 调用量 = det 漏网数，评测成本也和生产漏网率对齐。
  for (const r of results) {
    if (r.got !== 'det-pass') continue;
    const { got, ms, captured } = await runMaCase(r);
    r.got = got;
    r.ms = ms;
    r.captured = captured;
  }
} else if (layer === 'ma') {
  for (const c of cases) {
    const { got, ms, captured } = await runMaCase(c);
    results.push({ ...c, got, ms, captured });
  }
} else if (layer !== 'det') {
  console.error(`未知 layer: ${layer}（det | ma | pipeline）`);
  process.exit(2);
}

// —— 评分 ——
// det 层约定：expect=block/warn 且 note 标「考察MA」→ det-miss 属预期；其余正例必须命中。
// 负例：det block = 硬误报（危险，撤回+计踢）；det warn = 软误报（提醒卡）；
//       ng11（你妈基线）/ng12/ng13（引用语境）为已知词表层局限，单独归类不算回归。
const KNOWN_SOFT = new Set(['ng11', 'ng22', 'ng23']);
// det 层网盘/短链提醒档用例：MA 层 allow 属预期（生产中该档 warned 跳过 AI），不算 miss
const KNOWN_DET_WARN = new Set(['nd03', 'nd04', 'sl03', 'sl04', 'sl05', 'sl06']);
const KNOWN_QUOTE = new Set(['ng12', 'ng13']);
const rows = results.map((r) => {
  let verdict;
  if (r.expect === 'allow') {
    if (r.got === 'allow' || r.got === 'det-pass') verdict = 'pass';
    else if (r.got === 'block') verdict = KNOWN_QUOTE.has(r.id) ? 'known-quote-fp' : 'HARD-FP';
    else verdict = KNOWN_SOFT.has(r.id) ? 'known-soft-fp' : 'soft-fp';
  } else if (r.got === r.expect) verdict = 'pass';
  else if (r.got === 'det-pass' && /考察MA/.test(r.note || '')) verdict = 'pass(ma-scope)';
  else if (r.got === 'allow' && r.expect === 'warn') verdict = KNOWN_DET_WARN.has(r.id) ? 'known-det-warn' : 'miss(ma)';
  else if (r.got === 'allow') verdict = layer === 'det' ? 'det-miss' : 'MISS';
  else if (r.got === 'warn' && r.expect === 'block') verdict = 'under-block';
  else if (r.got === 'block' && r.expect === 'warn') verdict = 'over-block';
  else verdict = 'diff';
  return { id: r.id, tag: r.tag, expect: r.expect, got: r.got, verdict, hit: r.hit || '', ms: r.ms, text: r.text };
});

const count = (pred) => rows.filter(pred).length;
const hardFp = count((r) => r.verdict === 'HARD-FP');
const softFp = count((r) => r.verdict === 'soft-fp');
const misses = count((r) => r.verdict === 'det-miss' || r.verdict === 'MISS');
const passes = count((r) => r.verdict.startsWith('pass'));
const positives = rows.filter((r) => r.expect !== 'allow');

console.log(`\n=== 评测结果 layer=${layer} policy=${policyMode} cases=${rows.length} ===`);
console.log(`pass=${passes}/${rows.length}  正例漏检=${misses}/${positives.length}  硬误报(block档)=${hardFp}  软误报(warn档)=${softFp}  已知局限=${count((r) => r.verdict.startsWith('known'))}`);
if (positives.length) {
  const byTag = {};
  for (const r of positives) {
    byTag[r.tag] = byTag[r.tag] || { n: 0, hit: 0 };
    byTag[r.tag].n++;
    if (r.verdict.startsWith('pass')) byTag[r.tag].hit++;
  }
  console.log('正例分桶:', Object.entries(byTag).map(([t, v]) => `${t}=${v.hit}/${v.n}`).join('  '));
}
const bad = rows.filter((r) => !r.verdict.startsWith('pass') && !r.verdict.startsWith('known'));
if (bad.length) {
  console.log('\n未达预期:');
  for (const r of bad) console.log(`  [${r.verdict}] ${r.id}(${r.tag}) expect=${r.expect} got=${r.got}${r.hit ? ` 命中=${r.hit}` : ''} 「${r.text}」`);
}
if (layer === 'ma' || layer === 'pipeline') {
  const lat = rows.filter((r) => r.ms > 0).map((r) => r.ms).sort((a, b) => a - b);
  if (lat.length) {
    const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? 0;
    console.log(`\nMA延迟(仅实际调用): P50=${pct(50)}ms P95=${pct(95)}ms max=${lat[lat.length - 1]}ms`);
  }
}

// 报告落盘（项目规则：生成物进 outputs/）
mkdirSync(new URL('../outputs/', import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const reportFile = `moderation-eval-${layer}-${policyMode}-${stamp}.json`;
writeFileSync(new URL(`../outputs/${reportFile}`, import.meta.url), JSON.stringify({ layer, policy: policyMode, rows }, null, 2));
console.log(`\n报告: outputs/${reportFile}`);

// 退出码：硬误报（撤回+计踢级）或 block 档真漏检（det 层正例未命中 / pipeline 层 allow）才算失败；
// under-block（降级为提醒）/ over-block / miss(ma)（warn 档软漏）只报告不拦退出——
// 提醒卡误发或少发的代价远低于撤回误伤。
const blockMiss = count((r) => r.verdict === 'MISS' || r.verdict === 'det-miss');
process.exit(hardFp > 0 || blockMiss > 0 ? 1 : 0);
