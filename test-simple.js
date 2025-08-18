const { app, desktopCapturer, systemPreferences } = require('electron');

async function testScreenCapture() {
  console.log('=== 测试屏幕截图功能 ===');
  
  try {
    // 检查权限
    if (process.platform === 'darwin') {
      const hasScreenAccess = systemPreferences.getMediaAccessStatus('screen');
      console.log('屏幕录制权限状态:', hasScreenAccess);
      
      if (hasScreenAccess !== 'granted') {
        console.log('请求屏幕录制权限...');
        const granted = await systemPreferences.askForMediaAccess('screen');
        console.log('权限请求结果:', granted);
      }
    }
    
    // 尝试获取屏幕源
    console.log('尝试获取屏幕源...');
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'], 
      fetchWindowIcons: false,
      thumbnailSize: { width: 0, height: 0 }
    });
    
    console.log('成功获取屏幕源，数量:', sources.length);
    sources.forEach((source, index) => {
      console.log(`屏幕源 ${index + 1}:`, {
        id: source.id,
        name: source.name,
        display_id: source.display_id
      });
    });
    
    return sources;
    
  } catch (error) {
    console.error('测试失败:', error);
    throw error;
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  app.whenReady().then(() => {
    testScreenCapture()
      .then(() => {
        console.log('测试完成');
        app.quit();
      })
      .catch((error) => {
        console.error('测试失败:', error);
        app.quit();
      });
  });
}

module.exports = { testScreenCapture }; 