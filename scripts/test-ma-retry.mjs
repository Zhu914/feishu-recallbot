// 重试路径专项测试。
// 模型太守规矩、无法用 prompt 逼它输出坏 JSON，所以用「计数式 validate」强制第一轮不合格：
//   validate 第 1 次调用必返 false → 触发同会话重试 → 第 2 回合应真实执行（多耗 3-6s）。
// 判定标准：
//   ① 重试日志出现（validate→retry 分支通了）
//   ② 重试后总耗时显著大于单回合（marker 生效：重试轮询等到了新的 status_idle，
//      而不是被第一回合旧 idle 立即截断——那种情况下重试只多花 ~0.5s）
import { judge, initMa } from '../src/ma.js';

const logs = [];
initMa((lvl, tag, msg) => logs.push(`[${tag}] ${msg}`));

let validations = 0;
const t0 = Date.now();
const out = await judge('今天中午吃什么好', {
  timeoutMs: 45_000,
  validate: () => {
    validations++;
    return validations > 1 ? true : false; // 第一次必拒绝，触发重试（若被再次调用则通过）
  },
});
const durationMs = Date.now() - t0;

console.log('最终输出:', JSON.stringify(out));
console.log('validate 调用次数:', validations, '（期望 1：judge 只在第一回合后调用）');
console.log('总耗时:', (durationMs / 1000).toFixed(1) + 's');
const retryLogged = logs.some(l => l.includes('同会话重试一次'));
console.log('重试日志出现:', retryLogged);

const failures = [];
if (!out) failures.push('返回 null（判定失败）');
if (!retryLogged) failures.push('重试未触发（validate 链路仍断）');
if (durationMs < 6000) failures.push(`总耗时仅 ${durationMs}ms——重试轮询疑似被旧 status_idle 截断（marker 失效）`);

if (failures.length) {
  console.error('\nFAIL:', failures.join('; '));
  console.error('日志:', logs.join('\n'));
  process.exit(1);
}
console.log('\nPASS: validate→重试→新回合输出 全链路正常');
process.exit(0);
