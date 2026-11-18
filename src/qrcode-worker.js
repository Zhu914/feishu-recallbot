// 二维码检测 worker：跑在独立线程的同步 CPU 管线。
//
// 引擎与顺序（2026-11 实测基准，双引擎失败模式互补）：
//   1. zbar @ 基础分辨率（≤1600）—— 耗时只随尺寸走、对噪点免疫，是手机拍照/大倾角码的主力；
//      放在最前，保证不被 jsQR 的病态耗时饿死
//   2. 原图超尺寸时：zbar @ ≤2500 补扫 —— 兜住「大图里的小码」（降采样悬崖在模块 <2px）
//   3. jsQR @ 基础分辨率 —— 干净截图/小模块码最强（attemptBoth 覆盖反色码）；永不接触
//      超过 maxDimension 的原图（噪点原图 jsQR 实测可达 39s）
//
// 只上报 found / 引擎 / 格式 / 尺寸；二维码解码出的文本在本文件内即被丢弃，不出 worker。

import { parentPort, workerData } from 'node:worker_threads';
import jsQR from 'jsqr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { scanRGBABuffer } from '@undecaf/zbar-wasm';

const BASE_TARGET = 1600;  // 超尺寸图的降采样目标（模块 <2px 是检出悬崖，不再更低）
const HIRES_TARGET = 2500; // 「大图小码」zbar 补扫分辨率（不受 maxDimension 约束，见 README）
// 解码前像素预算：pngjs 在解析 IHDR 时就无上限地分配 4*w*h 内存（jpeg-js 尚有
// maxMemoryUsageInMB 兜底，PNG 完全裸奔），一个 ~250KB 的「小文件大头寸」PNG 就能把
// 整个进程 RSS 顶到 GB 级直至 OOM——worker 线程隔离救不了堆外 Buffer 分配。
// 预检只读几十字节头，超预算直接按未检出放行（宁漏勿误）。
const MAX_PIXELS = 40 * 1000 * 1000;

function sniffFormat(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.length > 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return 'unknown';
}

// 解码前从文件头读出声明的尺寸（PNG: IHDR 第 16-23 字节大端 u32；JPEG: 扫 SOF 帧头）。
// 读不出来返回 null（交给解码器自己处理/抛错，已被 try/catch 覆盖）。
function declaredPixels(buf, format) {
  try {
    if (format === 'png') {
      if (buf.length < 24) return null;
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return { w, h };
    }
    if (format === 'jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m === 0xff) { i++; continue; } // 填充字节
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // 无长度段
        const segLen = buf.readUInt16BE(i + 2);
        // SOF0/1/2…（不含 C4=DHT、C8=JPG、CC=DAC）：precision(1) height(2BE) width(2BE)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + segLen;
      }
      return null;
    }
  } catch {}
  return null;
}

function decodeImage(buf, format) {
  if (format === 'png') {
    const png = PNG.sync.read(buf); // 恒输出 4 通道 RGBA（灰度/调色板 PNG 同样）
    return { data: png.data, width: png.width, height: png.height };
  }
  if (format === 'jpeg') {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
    return { data: img.data, width: img.width, height: img.height };
  }
  return null;
}

// 箱式平均降采样：逐目的像素对源窗口求 RGB 均值，alpha 恒 255
function downscale({ data, width, height }, target) {
  const longest = Math.max(width, height);
  if (longest <= target) return { data, width, height };
  const nw = Math.max(1, Math.round((width * target) / longest));
  const nh = Math.max(1, Math.round((height * target) / longest));
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * height) / nh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * width) / nw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / nw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

// zbar-wasm 声明接收 Uint8ClampedArray；pngjs Buffer / jpeg-js Uint8Array 直接视图化，避免大拷贝
function toClamped(arr) {
  if (arr instanceof Uint8ClampedArray) return arr;
  try {
    return new Uint8ClampedArray(arr.buffer, arr.byteOffset, arr.byteLength);
  } catch {
    return new Uint8ClampedArray(arr);
  }
}

// 兼容 scanRGBABuffer 同步/异步两种返回形态；只认 ZBAR_QRCODE（zbar 还会报 EAN 等一维条码）
async function zbarFound(image) {
  try {
    const symbols = await scanRGBABuffer(toClamped(image.data), image.width, image.height);
    return (symbols || []).some(s => {
      const name = typeof s.typeName === 'function' ? s.typeName() : s.typeName;
      return name === 'ZBAR_QRCODE';
    });
  } catch {
    return false;
  }
}

// 只取布尔，解码文本（result.data）在这里被丢弃
function jsqrFound(image) {
  try {
    return !!jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  } catch {
    return false;
  }
}

async function run() {
  const { buffer, maxDimension } = workerData || {};
  const buf = Buffer.from(buffer || '');
  const format = sniffFormat(buf);
  if (format !== 'png' && format !== 'jpeg') {
    return { found: false, skipped: `unsupported:${format}` };
  }

  // 解压炸弹/异常头预检：声明尺寸非法或超像素预算 → 不进解码器
  const dims = declaredPixels(buf, format);
  if (dims && (!Number.isFinite(dims.w) || !Number.isFinite(dims.h) || dims.w <= 0 || dims.h <= 0 || dims.w * dims.h > MAX_PIXELS)) {
    return { found: false, skipped: 'oversized', format };
  }

  let image;
  try {
    image = decodeImage(buf, format);
  } catch {
    return { found: false, skipped: 'decode-error', format };
  }
  if (!image || !image.width || !image.height) {
    return { found: false, skipped: 'decode-error', format };
  }

  const oversized = Math.max(image.width, image.height) > maxDimension;
  const base = oversized ? downscale(image, Math.min(BASE_TARGET, maxDimension)) : image;

  if (await zbarFound(base)) return { found: true, engine: 'zbar', format, width: image.width, height: image.height };
  if (oversized) {
    const hires = downscale(image, HIRES_TARGET);
    if (hires !== base && (await zbarFound(hires))) {
      return { found: true, engine: 'zbar-hires', format, width: image.width, height: image.height };
    }
  }
  if (jsqrFound(base)) return { found: true, engine: 'jsqr', format, width: image.width, height: image.height };

  return { found: false, format, width: image.width, height: image.height };
}

parentPort?.postMessage(await run());
