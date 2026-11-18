// 二维码检测链路验证（qrImage）：走 src/qrcode.js → qrcode-worker.js 的真实 worker 路径。
//
// 用途：升级 jsqr/zbar-wasm/pngjs/jpeg-js 前后的回归。需 Node 20+（本地/CI 运行，
// npm install 含 devDependencies——qrcode 为 devDep，容器镜像 --omit=dev 不含它）。
// 覆盖（断言钉到引擎/路径级别）：
//   base 扫描（zbar）/ JPEG 解码 / 灰度 PNG / 反色码（jsQR attemptBoth）/
//   大图小码（降采样 base 命中）/ 超大图超小码（zbar-hires 补扫分支）/
//   噪声图超时熔断（timedOut 必置位，事件循环保护）/ 解压炸弹预检（oversized 跳过）/
//   不支持格式跳过（WebP）。
// 产出：outputs/qr-verify-report.json + 控制台摘要；任一断言失败退出码 1。
//
// 用法：node scripts/qr-verify.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { detectQrcodeImage } from '../src/qrcode.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORT_FILE = join(PROJECT_ROOT, 'outputs', 'qr-verify-report.json');

// ---------- fixture 构造 ----------
function makeCanvas(w, h, [r, g, b] = [255, 255, 255]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

// 把 QR 矩阵画到画布上；(x, y) 是码左上角；dark 是模块颜色（反色码传 [255,255,255] 配深色底）
function paintQr(canvas, qr, x, y, modulePx, dark = [0, 0, 0]) {
  const size = qr.modules.size;
  const m = qr.modules.data;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!m[r * size + c]) continue;
      for (let dy = 0; dy < modulePx; dy++) {
        for (let dx = 0; dx < modulePx; dx++) {
          const px = ((y + r * modulePx + dy) * canvas.width + (x + c * modulePx + dx)) * 4;
          canvas.data[px] = dark[0]; canvas.data[px + 1] = dark[1]; canvas.data[px + 2] = dark[2];
        }
      }
    }
  }
  return canvas;
}

function toPng(canvas) {
  const png = new PNG({ width: canvas.width, height: canvas.height });
  canvas.data.copy(png.data);
  return PNG.sync.write(png);
}

// 灰度 PNG（colorType 0）：pngjs 不支持写调色板(colorType 3)，灰度可写；写失败则该 fixture 记 skipped
function toGrayPng(canvas) {
  const png = new PNG({ width: canvas.width, height: canvas.height, colorType: 0, inputColorType: 0, bitDepth: 8 });
  const gray = Buffer.alloc(canvas.width * canvas.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (canvas.data[i * 4] * 306 + canvas.data[i * 4 + 1] * 601 + canvas.data[i * 4 + 2] * 117) >> 10;
  }
  gray.copy(png.data);
  return PNG.sync.write(png);
}

function toJpeg(canvas, quality = 90) {
  return jpeg.encode({ data: canvas.data, width: canvas.width, height: canvas.height }, quality).data;
}

// 确定性噪声（xorshift32）：保证用例跨机器可复现，避免 randomBytes 的偶发平坦区
function noiseCanvas(w, h, seed = 0x2a2a2a2a) {
  const data = Buffer.alloc(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    data[i] = s & 0xff; data[i + 1] = (s >>> 8) & 0xff; data[i + 2] = (s >>> 16) & 0xff; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

// 解压炸弹样张：合法 PNG 头（IHDR 声明超大尺寸）+ 立即 IEND，总 ~57 字节。
// 预检在读 IHDR 后即拦截，永远不该走到 pngjs 的无上限分配。
function bombPng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8); // CRC 填 0：预检在 pngjs 解析之前拦截，CRC 无关紧要
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}

async function qrOf(text) {
  return qrcode.create(text, { errorCorrectionLevel: 'M' });
}

// 居中画码的辅助：返回画好的画布
function canvasWithQr(canvasSide, modulePx, qr, opts = {}) {
  const canvas = makeCanvas(canvasSide, canvasSide, opts.bg);
  const size = qr.modules.size * modulePx;
  paintQr(canvas, qr, Math.floor((canvasSide - size) / 2), Math.floor((canvasSide - size) / 2), modulePx, opts.dark);
  return canvas;
}

// ---------- 用例 ----------
const results = [];
let failed = 0;
let skippedCount = 0;

async function run(name, buffer, expect, opts = {}) {
  const t0 = Date.now();
  let result;
  let error = '';
  try {
    result = await detectQrcodeImage(buffer, opts);
  } catch (err) {
    error = err?.message || String(err);
    result = { found: false, error };
  }
  const wallMs = Date.now() - t0;
  const pass = expect(result, wallMs);
  if (!pass) failed++;
  results.push({ name, pass, wallMs, expect: expect.toString().replace(/\s+/g, ' ').slice(0, 120), result });
  const flag = pass ? '✅' : '❌';
  const info = result.skipped ? `skipped=${result.skipped}` : result.found
    ? `engine=${result.engine} ${result.format} ${result.width}x${result.height}`
    : `${result.format || '?'} ${result.timedOut ? 'timedOut' : 'miss'}`;
  console.log(`${flag} ${name.padEnd(26)} ${info}  worker=${result.ms ?? '-'}ms wall=${wallMs}ms${error ? ` err=${error.slice(0, 80)}` : ''}`);
  return result;
}

// 1. 基准 PNG：600x600 中央 QR（截图场景主形态）——钉 base 路径引擎为 zbar
{
  const canvas = canvasWithQr(600, 8, await qrOf('https://example.com/qr-verify-basic'));
  await run('png-600-center', toPng(canvas), r => r.found === true && r.engine === 'zbar');
}
// 2. JPEG q90（手机拍照/转发场景；jpeg-js 解码路径）
{
  const canvas = canvasWithQr(600, 8, await qrOf('https://example.com/qr-verify-jpeg'));
  await run('jpeg-600-q90', toJpeg(canvas, 90), r => r.found === true && r.engine === 'zbar');
}
// 3. 灰度 PNG（pngjs 读非 RGBA PNG 的归一化路径）；pngjs 写灰度失败时显式记 skipped（不静默计通过）
{
  try {
    const canvas = canvasWithQr(600, 8, await qrOf('https://example.com/qr-verify-gray'));
    const buf = toGrayPng(canvas);
    await run('png-600-gray', buf, r => r.found === true);
  } catch (err) {
    skippedCount++;
    console.log(`⏭️  png-600-gray SKIPPED（pngjs 写灰度失败: ${err.message.slice(0, 80)}）`);
    results.push({ name: 'png-600-gray', pass: null, skipped: true, note: String(err.message).slice(0, 120) });
  }
}
// 4. 反色码：深色底白模块（深色模式截图常见；zbar 不反色，靠 jsQR attemptBoth 兜住）
{
  const canvas = canvasWithQr(600, 8, await qrOf('https://example.com/qr-verify-inverted'), { bg: [17, 17, 17], dark: [240, 240, 240] });
  await run('png-600-inverted', toPng(canvas), r => r.found === true && r.engine === 'jsqr');
}
// 5. 大图小码（base 命中）：3000x3000 白底中央 ~145px QR，降采样到 1600 后模块 ~3.9px，zbar base 即中
{
  const canvas = canvasWithQr(3000, 5, await qrOf('https://example.com/qr-verify-small'));
  await run('png-3000-small-qr', toPng(canvas), r => r.found === true && r.engine === 'zbar', { timeoutMs: 6000 });
}
// 6. 超大图超小码（钉 zbar-hires 分支）：4000x4000 中央模块 4px 的码——
//    base(1600) 降采样后模块 1.6px（<2px 检出悬崖，zbar/jsQR 双 miss），
//    hires(2500) 模块 2.5px，只有补扫分支能救
{
  const canvas = canvasWithQr(4000, 4, await qrOf('https://example.com/qr-verify-hires'));
  await run('png-4000-tiny-qr', toPng(canvas), r => r.found === true && r.engine === 'zbar-hires', { timeoutMs: 8000 });
}
// 7. 小模块码：干净 PNG 原生小图、模块 2px（jsQR 强项，钉不到引擎，found 即可）
{
  const qr = await qrOf('https://example.com/qr-verify-tiny');
  const m = qr.modules.size;
  const px = 2;
  const side = m * px + 8 * px; // 两侧各留 ≥4 模块 quiet zone
  const canvas = makeCanvas(side, side);
  paintQr(canvas, qr, 4 * px, 4 * px, px);
  await run('png-tiny-module-2px', toPng(canvas), r => r.found === true);
}
// 8. 噪声图 + 超时熔断（事件循环保护）：800ms 预算必须兜住且 timedOut 必须置位——
//    zbar(~0.2s) 先完，jsQR 在噪声 1400² 上必超预算被 terminate
{
  const buf = toPng(noiseCanvas(1400, 1400));
  await run('png-noise-timeout-800ms', buf,
    (r, wallMs) => r.found === false && r.timedOut === true && wallMs < 2600,
    { timeoutMs: 800 });
}
// 9. 解压炸弹（PNG 解码无上限分配的预检拦截）：57 字节声明 30000x30000 的 PNG 必须秒回 oversized
{
  await run('png-bomb-30000px', bombPng(30000, 30000),
    (r, wallMs) => r.found === false && r.skipped === 'oversized' && wallMs < 3000);
}
// 10. 不支持格式：WebP 魔数 → 秒回 skipped（不算命中也不算错误）
{
  const webp = Buffer.alloc(64, 0);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  await run('webp-magic-skip', webp, r => r.found === false && r.skipped === 'unsupported:webp');
}

// ---------- 报告 ----------
const report = {
  time: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  allPassed: failed === 0,
  failed,
  skipped: skippedCount,
  results,
};
await mkdir(join(PROJECT_ROOT, 'outputs'), { recursive: true });
await writeFile(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
const skippedNote = skippedCount ? `（另 ${skippedCount} 项 skipped）` : '';
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}${skippedNote} — 报告: outputs/qr-verify-report.json`);
process.exit(failed === 0 ? 0 : 1);
