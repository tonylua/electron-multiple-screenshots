// [截图·DXGI addon] 原生抓帧模块加载器（主进程 / CommonJS）。
//
// 用 DXGI Desktop Duplication 原生 addon 取代 desktopCapturer + getUserMedia 那条 ~800ms 的管线；
// 常驻会话下二次抓帧 ~10ms。addon 是主进程原生模块，抓帧逻辑因此从 preload/渲染进程搬到主进程。
//
// addon 接口（见 native/screenshot-addon/src/lib.rs）：
//   listDisplays(): DisplayInfo[]
//     DisplayInfo = { deviceName, left, top, width, height, dpiScale, rotation }  // 均为物理像素
//   captureFrame(deviceName, { timeoutMs? }): Promise<FrameResult>
//     FrameResult = { data: Buffer(BGRA8), width, height, rotation, dpiScale, format:"bgra8" }
//   primeDisplays(deviceNames?): Promise<number>   // 预热常驻会话，消化首次 ~200ms priming
//   dispose(): void                                // 释放全部常驻会话

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const ADDON_FILE_NAME = 'screenshot_addon.node';

let cachedAddon = null;
let loadAttempted = false;

// 候选路径：开发态在工程根 resources/ 下；打包态经 extraResources 落到 process.resourcesPath。
function candidatePaths() {
  const candidates = [];
  try {
    candidates.push(path.join(process.resourcesPath || '', ADDON_FILE_NAME));
  } catch (_) {
    /* ignore */
  }
  try {
    candidates.push(path.join(app.getAppPath(), 'resources', ADDON_FILE_NAME));
  } catch (_) {
    /* ignore */
  }
  candidates.push(path.join(__dirname, 'resources', ADDON_FILE_NAME));
  return candidates.filter(Boolean);
}

/**
 * 加载 DXGI 抓帧 addon。幂等：仅首次尝试，结果缓存。
 * 失败返回 null（Windows 专用；非 Windows / 文件缺失 / 接口不完整都返回 null）。
 */
function loadScreenshotAddon() {
  if (loadAttempted) {
    return cachedAddon;
  }
  loadAttempted = true;

  if (process.platform !== 'win32') {
    console.warn('[screenshot-addon] 非 Windows 平台，DXGI 抓帧不可用');
    return null;
  }

  const tried = [];
  for (const addonPath of candidatePaths()) {
    tried.push(addonPath);
    if (!fs.existsSync(addonPath)) {
      continue;
    }
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const addon = require(addonPath);
      if (
        !addon ||
        typeof addon.listDisplays !== 'function' ||
        typeof addon.captureFrame !== 'function' ||
        typeof addon.dispose !== 'function'
      ) {
        console.error('[screenshot-addon] addon 接口不完整:', addonPath);
        continue;
      }
      cachedAddon = addon;
      console.log('[screenshot-addon] addon 加载成功:', addonPath);
      return cachedAddon;
    } catch (error) {
      console.error(
        '[screenshot-addon] addon 加载失败:',
        addonPath,
        error instanceof Error ? error.message : error
      );
    }
  }

  console.error('[screenshot-addon] 未找到可用 addon，尝试过以下路径:\n' + tried.join('\n'));
  return null;
}

/** 释放 addon 常驻抓帧会话（应用退出时调用）。失败静默。 */
function disposeScreenshotAddon() {
  if (!cachedAddon) return;
  try {
    cachedAddon.dispose();
  } catch (error) {
    console.warn('[screenshot-addon] dispose 失败:', error);
  }
}

module.exports = { loadScreenshotAddon, disposeScreenshotAddon };
