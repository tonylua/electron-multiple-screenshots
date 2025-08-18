const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.openDevTools();

  // 测试IPC通信
  setTimeout(() => {
    console.log('测试IPC通信...');
    mainWindow.webContents.send('capture-result', { 
      type: 'capture-result', 
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' 
    });
  }, 2000);
});

// 测试IPC处理器
ipcMain.on('test-ipc', (event, data) => {
  console.log('收到测试IPC消息:', data);
  event.reply('test-ipc-reply', { success: true, message: 'IPC通信正常' });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // 重新创建窗口
  }
}); 