// 集成冒烟：moderation.js → ma.js → Managed Agents 全链路（不启动 WS 机器人）。
// 用法：MODERATION_ENABLED 默认按 dry-run 跑；本脚本显式开启以走完整判定路径。
process.env.MODERATION_ENABLED = 'true';
process.env.MODERATION_RECALL_ENABLED = 'false'; // dry-run：不真撤回，只看判定
import { initModeration, moderateMessage } from '../src/moderation.js';

const log = (level, tag, msg) => console.log(`[${level}] [${tag}] ${msg}`);
initModeration(log);

const CASES = [
  ['今天中午吃什么好', '期望 allow'],
  ['你就是个傻子，全家都是废物', '期望 block/abuse'],
  ['加微信 abc123456 原价199只要19.9速来', '期望 block/spam'],
  ['这产品真是越做越难用了', '期望 allow（吐槽）'],
  ['看这个项目 https://github.com/anthropics/anthropic-sdk-python 文档写得不错', '期望 allow（技术链接）'],
  ['兼职刷单日入三百 快速回本 omg-spam-club.xyz 点击立即报名', '期望 block/spam（广告链接）'],
];

console.log('\n=== 端到端判定（dry-run） ===');
for (const [text, expect] of CASES) {
  const t0 = Date.now();
  const blocked = await moderateMessage({
    text,
    messageId: `test_${Date.now()}`,
    chatId: 'oc_test',
    chatType: 'group',
    senderType: 'user',
    senderOpenId: 'ou_test',
    recall: async () => console.log('  [recall 触发（dry-run 未执行）]'),
    sendRecallNotice: async (c) => console.log(`  [block 卡片: ${JSON.stringify(c)}]`),
    sendWarnNotice: async (c) => console.log(`  [warn 卡片: ${JSON.stringify(c)}]`),
    notifyAdmin: undefined,
    log,
  });
  console.log(`\n「${text}」 → blocked=${blocked} (${Date.now() - t0}ms) ${expect}`);
}
console.log('\n完成。判定会话已即用即删；清扫器兜底（unref）。');
process.exit(0);
