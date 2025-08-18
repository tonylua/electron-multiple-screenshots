const {
  app, BrowserWindow, ipcMain, screen,
  desktopCapturer, systemPreferences, globalShortcut,
} = require('electron');
const path = require('path');

let mainWindow;
let captureWindows = [];

app.on('ready', async () => {
  // 检查屏幕录制权限
  if (process.platform === 'darwin') {
    const hasScreenAccess = systemPreferences.getMediaAccessStatus('screen');
    console.log('屏幕录制权限状态:', hasScreenAccess);
    
    if (hasScreenAccess !== 'granted') {
      console.log('请求屏幕录制权限...');
      try {
        const granted = await systemPreferences.askForMediaAccess('screen');
        console.log('屏幕录制权限请求结果:', granted);
        
        if (!granted) {
          console.log('权限被拒绝，尝试其他方法...');
          // 在开发模式下，尝试使用系统截图作为备选方案
          await checkSystemScreenshotPermission();
        }
      } catch (error) {
        console.error('请求屏幕录制权限失败:', error);
        await checkSystemScreenshotPermission();
      }
    }
  }

  registerScreenshotShortcut();

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: { 
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.openDevTools({ mode: 'right' });
});

// 检查系统截图权限
async function checkSystemScreenshotPermission() {
  try {
    console.log('检查系统截图权限...');
    
    // 尝试使用系统命令检查权限
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
      // 检查是否有屏幕录制权限
      const { stdout } = await execAsync('tccutil query ScreenCapture com.apple.Terminal');
      console.log('系统截图权限检查结果:', stdout);
      
      if (stdout.includes('allowed')) {
        console.log('系统截图权限已授予');
        return true;
      } else {
        console.log('系统截图权限未授予，需要手动授权');
        showPermissionInstructions();
        return false;
      }
    } catch (error) {
      console.log('无法检查系统权限，可能需要手动授权');
      showPermissionInstructions();
      return false;
    }
  } catch (error) {
    console.error('检查系统截图权限失败:', error);
    return false;
  }
}

// 显示权限授权说明
function showPermissionInstructions() {
  const instructions = `
    🚨 需要屏幕录制权限！
    
    请按以下步骤操作：
    
    1. 打开 系统偏好设置 > 安全性与隐私 > 隐私
    2. 选择左侧的 "屏幕录制"
    3. 点击锁图标解锁设置
    4. 找到并勾选以下应用之一：
       - Terminal (如果通过终端启动)
       - 或者重新构建应用包后使用
    
    或者，你可以：
    1. 运行 npm run pack 构建应用包
    2. 在 dist/mac 目录中找到 .app 文件
    3. 双击运行，系统会提示授权
    
    注意：开发模式下直接运行 electron . 可能无法获得正确权限
  `;
  
  console.log(instructions);
  
  // 如果主窗口已创建，显示通知
  if (mainWindow) {
    mainWindow.webContents.executeJavaScript(`
      alert(\`${instructions.replace(/\n/g, '\\n')}\`);
    `);
  }
}

ipcMain.on('open-capture', () => {
  // 关闭之前的截图窗口
  captureWindows.forEach(win => {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });
  captureWindows = [];

  const displays = screen.getAllDisplays();
  console.log('创建截图窗口，显示器数量:', displays.length);

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
        enableRemoteModule: false
      }
    });

    captureWindow.setIgnoreMouseEvents(false);
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

// 添加一个简单的测试IPC处理
ipcMain.handle('test-desktop-capturer', async () => {
  try {
    console.log('=== 测试 desktopCapturer ===');
    console.log('desktopCapturer 对象存在:', !!desktopCapturer);
    console.log('desktopCapturer 类型:', typeof desktopCapturer);
    console.log('getSources 方法存在:', !!desktopCapturer.getSources);
    console.log('getSources 方法类型:', typeof desktopCapturer.getSources);
    
    if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
      throw new Error('desktopCapturer 或 getSources 方法不可用');
    }
    
    // 尝试最简单的调用
    console.log('尝试最简单的 getSources 调用...');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    console.log('成功获取屏幕源，数量:', sources.length);
    
    return {
      success: true,
      sourceCount: sources.length,
      sources: sources.map(s => ({ id: s.id, name: s.name }))
    };
    
  } catch (error) {
    console.error('测试 desktopCapturer 失败:', error);
    return {
      success: false,
      error: error.message || '未知错误',
      errorType: typeof error,
      errorObject: error
    };
  }
});

// 添加获取显示器信息的IPC处理
ipcMain.handle('get-displays', () => {
  try {
    const displays = screen.getAllDisplays();
    console.log('获取显示器信息成功，数量:', displays.length);
    
    return displays.map(display => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: display.internal
    }));
  } catch (error) {
    console.error('获取显示器信息失败:', error);
    throw error;
  }
});

// 添加获取屏幕源的IPC处理
ipcMain.handle('get-screen-sources', async () => {
  try {
    console.log('开始获取屏幕源...');
    console.log('desktopCapturer 对象:', desktopCapturer);
    console.log('desktopCapturer.getSources 方法:', typeof desktopCapturer.getSources);
    
    // 检查是否有屏幕录制权限
    console.log('尝试第一次获取屏幕源...');
    const hasScreenAccess = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false });
    console.log('第一次获取成功，数量:', hasScreenAccess.length);
    
    // 重新获取详细的屏幕源信息
    console.log('尝试第二次获取屏幕源...');
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'], 
      fetchWindowIcons: false,
      thumbnailSize: { width: 0, height: 0 } // 不获取缩略图以提高性能
    });
    
    console.log('第二次获取成功，数量:', sources.length);
    
    const result = sources.map(source => ({
      id: source.id,
      name: source.name,
      display_id: source.display_id
    }));
    
    console.log('处理后的屏幕源:', result);
    return result;
    
  } catch (error) {
    console.error('获取屏幕源失败:', error);
    console.error('错误类型:', typeof error);
    console.error('错误对象:', error);
    console.error('错误堆栈:', error.stack);
    
    // 如果 desktopCapturer 失败，尝试使用系统截图
    console.log('尝试使用系统截图作为备选方案...');
    return await trySystemScreenshot();
  }
});

// 尝试使用系统截图
async function trySystemScreenshot() {
  try {
    console.log('使用系统截图功能...');
    
    // 在 macOS 上，我们可以使用系统命令来截图
    if (process.platform === 'darwin') {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      // 获取桌面路径
      const desktopPath = path.join(require('os').homedir(), 'Desktop');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = path.join(desktopPath, `screenshot-${timestamp}.png`);
      
      // 使用系统截图命令
      await execAsync(`screencapture -x "${screenshotPath}"`);
      
      console.log('系统截图成功:', screenshotPath);
      
      // 返回一个模拟的屏幕源，表示使用系统截图
      return [{
        id: 'system-screenshot',
        name: 'System Screenshot',
        display_id: 'system',
        systemPath: screenshotPath
      }];
    }
    
    throw new Error('当前平台不支持系统截图');
    
  } catch (error) {
    console.error('系统截图也失败:', error);
    throw new Error('无法获取屏幕源，请检查权限设置或使用系统截图功能');
  }
}

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

ipcMain.on('capture-region', (event, rect) => {
  console.log('收到截图区域:', rect);
  mainWindow.webContents.send('do-capture', rect);
  
  // 关闭所有截图窗口
  captureWindows.forEach(win => {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });
  captureWindows = [];
});

ipcMain.on('capture-complete', (event, dataUrl) => {
  console.log('截图完成，发送结果到主窗口:', dataUrl);
  mainWindow.webContents.send('capture-result', { type: 'capture-result', dataUrl });
});

ipcMain.on('capture-error', (event, errorMessage) => {
  console.log('截图出错，发送错误信息到主窗口:', errorMessage);
  mainWindow.webContents.send('capture-result', { type: 'capture-error', error: errorMessage });
});

ipcMain.on('capture-esc', (event) => {
  console.log('取消截图');
  // 关闭之前的截图窗口
  captureWindows.forEach(win => {
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

// 获取所有屏幕组成的虚拟桌面范围
// function getVirtualBounds() {
//   const displays = screen.getAllDisplays();
//   let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

//   displays.forEach(d => {
//     minX = Math.min(minX, d.bounds.x);
//     minY = Math.min(minY, d.bounds.y);
//     maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
//     maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
//   });

//   return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
// }

// 注册截图快捷键
function registerScreenshotShortcut() {
  // 截图的快捷键
  const SCREENSHOT_SHORTCUT_KEY = 'Command+Shift+K';
  // 取消截图快捷键
  const ESC_SCREENSHOT_SHORTCUT_KEY = 'Esc';

  globalShortcut.register(SCREENSHOT_SHORTCUT_KEY, () => {
    ipcMain.emit('open-capture');
  });

  globalShortcut.register(ESC_SCREENSHOT_SHORTCUT_KEY, () => {
    ipcMain.emit('capture-esc');
  });

  // if (!success) {
  //   console.warn('⚠️[DevTools] Failed to register secret shortcut');
  // } else {
  //   console.log(`✅[DevTools] Succeed to register secret shortcut`);
  // }
}
