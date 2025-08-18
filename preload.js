const { ipcRenderer, contextBridge } = require('electron');

// 截图逻辑
ipcRenderer.on('do-capture', async (e, rect) => {
  try {
    console.log('开始截图流程...');
    console.log('截图区域信息:', rect);
    
    // 通过IPC获取屏幕源和显示器信息
    const [sources, displays] = await Promise.all([
      ipcRenderer.invoke('get-screen-sources'),
      ipcRenderer.invoke('get-displays')
    ]);

    console.log('获取到的屏幕源:', sources);
    console.log('获取到的显示器:', displays);

    // 检查是否使用系统截图
    if (sources.length === 1 && sources[0].id === 'system-screenshot') {
      console.log('使用系统截图功能');
      
      // 通过IPC发送系统截图结果
      const systemPath = sources[0].systemPath;
      ipcRenderer.send('capture-complete', `file://${systemPath}`);
      return;
    }

    // 计算虚拟桌面边界
    const minX = Math.min(...displays.map(d => d.bounds.x));
    const minY = Math.min(...displays.map(d => d.bounds.y));
    const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
    const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));

    const totalWidth = maxX - minX;
    const totalHeight = maxY - minY;

    console.log('虚拟桌面边界:', { minX, minY, maxX, maxY, totalWidth, totalHeight });

    // 创建虚拟大画布
    let canvas = document.createElement('canvas');
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    let ctx = canvas.getContext('2d');

    // 先填充黑色背景，便于调试
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, totalWidth, totalHeight);

    // 遍历屏幕源，拼接到虚拟画布
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const display = displays[i]; // 按索引顺序匹配
      
      console.log(`处理第 ${i + 1} 个屏幕源:`, source.name);
      console.log(`对应显示器:`, display ? display.bounds : '未找到');
      
      if (!display) {
        console.warn(`第 ${i + 1} 个屏幕源没有对应的显示器`);
        continue;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: source.id,
            },
          },
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('视频加载超时'));
          }, 10000);

          video.onloadedmetadata = async () => {
            clearTimeout(timeout);
            try {
              await video.play();
              
              console.log(`绘制屏幕 ${i + 1} 到画布:`, {
                sourceBounds: { x: display.bounds.x - minX, y: display.bounds.y - minY, width: display.bounds.width, height: display.bounds.height },
                videoSize: { width: video.videoWidth, height: video.videoHeight }
              });

              ctx.drawImage(
                video,
                display.bounds.x - minX,
                display.bounds.y - minY,
                display.bounds.width,
                display.bounds.height
              );

              stream.getTracks().forEach(t => t.stop());
              resolve();
            } catch (error) {
              reject(error);
            }
          };

          video.onerror = (error) => {
            clearTimeout(timeout);
            reject(error);
          };
        });

      } catch (error) {
        console.error(`处理屏幕源 ${source.name} 时出错:`, error);
      }
    }

    // 按选区裁剪
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = rect.width;
    cropCanvas.height = rect.height;
    
    // 确保裁剪坐标在画布范围内
    const cropX = Math.max(0, rect.x - minX);
    const cropY = Math.max(0, rect.y - minY);
    const cropWidth = Math.min(rect.width, totalWidth - cropX);
    const cropHeight = Math.min(rect.height, totalHeight - cropY);
    
    console.log('裁剪参数:', { cropX, cropY, cropWidth, cropHeight });
    
    if (cropWidth <= 0 || cropHeight <= 0) {
      throw new Error('裁剪区域无效');
    }
    
    cropCanvas
      .getContext('2d')
      .drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const dataUrl = cropCanvas.toDataURL('image/png');
    console.log('跨屏幕截图完成');

    // 通过IPC将截图结果发送到主窗口
    ipcRenderer.send('capture-complete', dataUrl);

  } catch (error) {
    console.error('截图过程中发生错误:', error);
    
    // 通过IPC发送错误信息到主窗口
    ipcRenderer.send('capture-error', error.message);
  }
});

// 监听截图结果，并通过回调函数通知渲染进程
ipcRenderer.on('capture-result', (event, data) => {
  console.log('preload 收到截图结果:', data);
  
  // 通过回调函数通知渲染进程
  if (window.captureResultCallback) {
    window.captureResultCallback(data);
  }
});

// 暴露给渲染进程的API
const api = {
  startCapture: () => {
    ipcRenderer.send('open-capture');
  },
  
  testDesktopCapturer: async () => {
    try {
      const result = await ipcRenderer.invoke('test-desktop-capturer');
      return result;
    } catch (error) {
      console.error('测试 desktopCapturer 失败:', error);
      return {
        success: false,
        error: error.message || '未知错误',
        errorType: typeof error
      };
    }
  },

  copyImageToClipboard: async (dataUrl) => {
    try {
      const result = await ipcRenderer.invoke('copy-image-to-clipboard', dataUrl);
      return result;
    } catch (error) {
      console.error('复制到剪贴板失败:', error);
      return { success: false, error: error.message };
    }
  },

  // 设置截图结果回调函数
  setCaptureResultCallback: (callback) => {
    window.captureResultCallback = callback;
  },

  // 获取显示器信息
  getDisplays: async () => {
    try {
      const result = await ipcRenderer.invoke('get-displays');
      return result;
    } catch (error) {
      console.error('获取显示器信息失败:', error);
      return [];
    }
  },

  // 发送开始拖拽事件
  sendStartDrag: (startInfo) => {
    ipcRenderer.send('start-drag', startInfo);
  },

  // 发送拖拽更新事件
  sendUpdateDrag: (dragInfo) => {
    ipcRenderer.send('update-drag', dragInfo);
  },

  // 发送截图区域信息
  sendCaptureRegion: (rect) => {
    ipcRenderer.send('capture-region', rect);
  },

  // 设置跨显示器拖拽开始回调
  onCrossDisplayDragStart: (callback) => {
    ipcRenderer.on('cross-display-drag-start', (event, startInfo) => {
      callback(startInfo);
    });
  },

  // 设置跨显示器拖拽更新回调
  onCrossDisplayDragUpdate: (callback) => {
    ipcRenderer.on('cross-display-drag-update', (event, dragInfo) => {
      callback(dragInfo);
    });
  }
};

// 使用 contextBridge 暴露 API
contextBridge.exposeInMainWorld('electronAPI', api);
