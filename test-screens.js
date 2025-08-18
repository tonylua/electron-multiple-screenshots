const { screen, desktopCapturer } = require('electron');

async function testScreens() {
  console.log('=== 测试屏幕信息 ===');
  
  // 获取显示器信息
  const displays = screen.getAllDisplays();
  console.log('显示器数量:', displays.length);
  
  displays.forEach((display, index) => {
    console.log(`显示器 ${index + 1}:`, {
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: display.internal
    });
  });
  
  // 计算虚拟边界
  const minX = Math.min(...displays.map(d => d.bounds.x));
  const minY = Math.min(...displays.map(d => d.bounds.y));
  const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
  
  console.log('虚拟桌面边界:', {
    minX, minY, maxX, maxY,
    width: maxX - minX,
    height: maxY - minY
  });
  
  // 获取屏幕源
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    console.log('屏幕源数量:', sources.length);
    
    sources.forEach((source, index) => {
      console.log(`屏幕源 ${index + 1}:`, {
        id: source.id,
        name: source.name,
        display_id: source.display_id,
        thumbnail: source.thumbnail ? '有缩略图' : '无缩略图'
      });
    });
  } catch (error) {
    console.error('获取屏幕源失败:', error);
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  testScreens().catch(console.error);
}

module.exports = { testScreens }; 