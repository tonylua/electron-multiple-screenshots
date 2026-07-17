const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  nativeImage,
  globalShortcut,
} = require('electron');
const path = require('path');
const { loadScreenshotAddon, disposeScreenshotAddon } = require('./screenshotAddon');

let mainWindow;
let captureWindows = [];

app.on('ready', async () => {
  registerScreenshotShortcut();

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.openDevTools({ mode: 'right' });
});

ipcMain.on('open-capture', async () => {
  // 关闭之前的截图窗口
  captureWindows.forEach((win) => {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });
  captureWindows = [];

  const displays = screen.getAllDisplays();
  console.log('创建截图窗口，显示器数量:', displays.length);

  // 【预热】提前 prime DXGI 会话，避免首次抓帧 ~200ms 的 priming 延迟
  const addon = loadScreenshotAddon();
  if (addon && typeof addon.primeDisplays === 'function') {
    try {
      const primed = await addon.primeDisplays();
      console.log('[screenshot-addon] DXG 会话预热完成，屏数:', primed);
    } catch (e) {
      console.warn('[screenshot-addon] 预热失败（忽略）:', e.message);
    }
  }

  // 为每个显示器创建截图窗口
  displays.forEach((display, index) => {
    const captureWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      movable: false,
      resizable: false,
      fullscreen: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        enableRemoteModule: false,
      },
    });

    captureWindow.setIgnoreMouseEvents(false);

    // 修复多显示器不同 DPI 缩放下的窗口尺寸/比例错误
    captureWindow.setBounds(display.bounds);

    // 内容保护：排除自己的窗口，避免抓帧时把自己抓进去
    try {
      captureWindow.setContentProtection(true);
    } catch (e) {
      console.warn('setContentProtection 失败:', e.message);
    }

    // 置顶层级：screen-saver 级，确保盖住其他窗口
    captureWindow.setAlwaysOnTop(true, 'screen-saver');
    captureWindow.moveTop();
    captureWindow.focus();

    captureWindow.loadFile('capture.html');

    // 传递显示器信息到渲染进程
    captureWindow.webContents.on('did-finish-load', () => {
      captureWindow.webContents.executeJavaScript(`
        window.currentDisplay = ${JSON.stringify(display)};
        window.displayIndex = ${index};
        window.totalDisplays = ${displays.length};
        console.log('截图窗口 ${index + 1} 加载完成，显示器:', ${JSON.stringify(display)});
      `);
    });

    captureWindow.on('closed', () => {
      const winIndex = captureWindows.indexOf(captureWindow);
      if (winIndex > -1) {
        captureWindows.splice(winIndex, 1);
      }
    });

    captureWindows.push(captureWindow);
  });

  console.log(`创建了 ${captureWindows.length} 个截图窗口`);
});

// 【截图·核心】用 addon 抓单屏，裁剪出选区；主进程完成，无需 getUserMedia/desktopCapturer
async function captureWithAddon(area, displays) {
  const addon = loadScreenshotAddon();
  if (!addon) {
    throw new Error('screenshot_addon 未加载');
  }

  // 1) 用坐标命中目标显示器（选区起点位于哪块屏）
  const targetDisplay = displays.find((d) => {
    const b = d.bounds;
    return area.x >= b.x && area.x < b.x + b.width && area.y >= b.y && area.y < b.y + b.height;
  }) || displays[0];

  if (!targetDisplay) {
    throw new Error('未找到目标显示器');
  }

  // 2) 用 addon 枚举并匹配本屏（nativeOrigin 与 addon 的 left/top 匹配更鲁棒）
  const addonDisplays = addon.listDisplays();
  let matched = null;

  // 优先用 nativeOrigin（Electron 给出的物理原点）匹配 addon 的物理坐标
  const origin = targetDisplay.nativeOrigin;
  if (origin && typeof origin.x === 'number') {
    matched = addonDisplays.find((a) => a.left === origin.x && a.top === origin.y);
  }
  // 其次用 DIP bounds（在 100% 缩放时一致）
  if (!matched) {
    matched = addonDisplays.find(
      (a) => a.left === targetDisplay.bounds.x && a.top === targetDisplay.bounds.y
    );
  }
  if (!matched) {
    // 兜底：按数组下标（多屏顺序通常一致）
    const idx = displays.indexOf(targetDisplay);
    matched = addonDisplays[idx];
  }

  if (!matched) {
    throw new Error(`addon 未匹配到显示器: ${targetDisplay.id}`);
  }

  // 3) 抓帧（异步，工作线程执行，不阻塞主进程）
  const frame = await addon.captureFrame(matched.deviceName, { timeoutMs: 300 });
  if (!frame || !frame.data || frame.width <= 0 || frame.height <= 0) {
    throw new Error('addon 抓帧失败或返回空帧');
  }

  // 4) 构建 NativeImage（BGRA8 紧凑 Buffer，直接可用）
  let image = nativeImage.createFromBitmap(frame.data, {
    width: frame.width,
    height: frame.height,
  });

  // 5) 裁剪：把全局坐标选区换算到本屏像素坐标
  // 缩放系数 = 物理帧尺寸 / DIP bounds（addon 返回物理像素，Electron bounds 是 DIP）
  const scaleX = frame.width / targetDisplay.bounds.width;
  const scaleY = frame.height / targetDisplay.bounds.height;

  const localX = Math.max(0, Math.floor((area.x - targetDisplay.bounds.x) * scaleX));
  const localY = Math.max(0, Math.floor((area.y - targetDisplay.bounds.y) * scaleY));
  const cropW = Math.max(1, Math.floor(area.width * scaleX));
  const cropH = Math.max(1, Math.floor(area.height * scaleY));

  const boundedW = Math.min(cropW, Math.max(0, frame.width - localX));
  const boundedH = Math.min(cropH, Math.max(0, frame.height - localY));

  if (boundedW <= 0 || boundedH <= 0) {
    throw new Error('裁剪区域超出截图边界');
  }

  const cropped = image.crop({ x: localX, y: localY, width: boundedW, height: boundedH });
  return cropped.toDataURL();
}

ipcMain.on('capture-region', async (event, rect) => {
  console.log('收到截图区域:', rect);

  // 关闭所有截图窗口（已经抓到帧，尽早关闭 UI）
  captureWindows.forEach((win) => {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });
  captureWindows = [];

  const displays = screen.getAllDisplays();

  try {
    const dataUrl = await captureWithAddon(rect, displays);
    mainWindow.webContents.send('capture-result', { type: 'capture-result', dataUrl });
  } catch (error) {
    console.error('[capture-region] 截图失败:', error.message);
    mainWindow.webContents.send('capture-result', {
      type: 'capture-error',
      error: error.message || '截图失败',
    });
  }
});

ipcMain.on('capture-esc', (event) => {
  console.log('取消截图');
  captureWindows.forEach((win) => {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });
  captureWindows = [];
  mainWindow.webContents.send('capture-result', { type: 'capture-esc', msg: '用户已取消截图' });
});

// 添加复制图片到剪贴板的IPC处理
ipcMain.handle('copy-image-to-clipboard', async (event, dataUrl) => {
  try {
    console.log('复制图片到剪贴板...');

    // 将 dataURL 转换为 Buffer
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // 创建 NativeImage 对象
    const { nativeImage, clipboard } = require('electron');
    const image = nativeImage.createFromBuffer(imageBuffer);

    // 复制到剪贴板
    clipboard.writeImage(image);
    console.log('图片已复制到剪贴板');

    return { success: true, message: '图片已复制到剪贴板' };
  } catch (error) {
    console.error('复制到剪贴板失败:', error);
    return { success: false, error: error.message };
  }
});

// 添加跨显示器拖拽支持
ipcMain.on('start-drag', (event, startInfo) => {
  // 通知其他截图窗口开始拖拽
  captureWindows.forEach((win, index) => {
    if (win && !win.isDestroyed() && index !== startInfo.displayIndex) {
      win.webContents.send('cross-display-drag-start', startInfo);
    }
  });
});

ipcMain.on('update-drag', (event, dragInfo) => {
  // 通知其他截图窗口更新拖拽状态
  captureWindows.forEach((win, index) => {
    if (win && !win.isDestroyed() && index !== dragInfo.displayIndex) {
      win.webContents.send('cross-display-drag-update', dragInfo);
    }
  });
});

// 注册截图快捷键
function registerScreenshotShortcut() {
  const SCREENSHOT_SHORTCUT_KEY = 'CommandOrControl+Shift+K';
  const ESC_SCREENSHOT_SHORTCUT_KEY = 'Esc';

  globalShortcut.register(SCREENSHOT_SHORTCUT_KEY, () => {
    ipcMain.emit('open-capture');
  });

  globalShortcut.register(ESC_SCREENSHOT_SHORTCUT_KEY, () => {
    ipcMain.emit('capture-esc');
  });
}

// 退出时释放 addon 会话
app.on('will-quit', () => {
  disposeScreenshotAddon();
});
