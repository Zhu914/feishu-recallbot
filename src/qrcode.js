// 图片二维码检测（主线程封装）：每张图一个临时 worker 线程 + 超时熔断。
//
// 为什么必须进 worker：解码与扫描（pngjs / jpeg-js / zbar / jsQR）全部是同步 CPU 密集代码，
// 实测噪声图上 jsQR 最坏耗时可达 30s+（见 scripts/qr-verify.mjs 基准），直接跑在主线程会
// 卡死串行消息队列与 WS 心跳。worker + timeoutMs 熔断把单张图的最坏耗时钉死在预算内。
//
// 只回答「图片里是否存在二维码」（found），不解读内容：二维码的解码文本在 worker 内部
// 即被丢弃，主线程与日志只出现 格式/尺寸/引擎/耗时 这类诊断信息。

import { Worker } from 'node:worker_threads';

/**
 * 检测一张图片（PNG/JPEG 原始字节）中是否含有二维码。
 * 任何失败（不支持的格式、解码异常、worker 崩溃、超时）都 resolve 为 found:false —— 宁漏勿误。
 * @param {Buffer|Uint8Array} buffer 图片原始字节
 * @param {{timeoutMs?: number, maxDimension?: number}} opts
 *   timeoutMs     单图总预算（含 worker 启动），超时 terminate 并按未检出处理
 *   maxDimension  超过此最长边的图先降采样再扫（jsQR 永不接触超过该尺寸的图）
 * @returns {Promise<{found: boolean, engine?: string, format?: string, width?: number,
 *   height?: number, skipped?: string, timedOut?: boolean, error?: string, ms: number}>}
 */
export function detectQrcodeImage(buffer, { timeoutMs = 4000, maxDimension = 2000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    let worker;
    try {
      worker = new Worker(new URL('./qrcode-worker.js', import.meta.url), {
        workerData: { buffer, maxDimension },
      });
    } catch (err) {
      resolve({ found: false, error: `worker spawn failed: ${err?.message || err}`, ms: 0 });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve({ ...result, ms: Date.now() - startedAt });
    };
    const timer = setTimeout(() => finish({ found: false, timedOut: true }), Math.max(500, timeoutMs));

    worker.on('message', finish);
    worker.on('error', (err) => finish({ found: false, error: String(err?.message || err).slice(0, 200) }));
    // 正常路径：worker postMessage 后自行退出；这里只兜「未发消息就退出」的异常
    worker.on('exit', (code) => finish({ found: false, error: `worker exited before result code=${code}` }));
  });
}
