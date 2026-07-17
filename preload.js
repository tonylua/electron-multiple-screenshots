const { ipcRenderer, contextBridge } = require('electron');

// 监听截图结果，并通过回调函数通知渲染进程
ipcRenderer.on('capture-result', (event, data) => {
  console.log('preload 收到截图结果:', data);
  if (window.captureResultCallback) {
    window.captureResultCallback(data);
  }
});

// 暴露给渲染进程的API
const api = {
  startCapture: () => {
    ipcRenderer.send('open-capture');
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
  },
};

// 使用 contextBridge 暴露 API
contextBridge.exposeInMainWorld('electronAPI', api);
