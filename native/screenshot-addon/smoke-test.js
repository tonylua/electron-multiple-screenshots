// 冒烟测试：加载 addon，枚举显示器并抓一帧，打印元信息与像素校验。
// 用系统 Node 直接跑即可（addon 已针对本机 Node ABI 构建；Electron 侧仅 ABI 版本不同）。
const addon = require('./index.js')

console.log('=== listDisplays ===')
const displays = addon.listDisplays()
console.log(JSON.stringify(displays, null, 2))

if (!displays.length) {
  console.error('没有枚举到显示器')
  process.exit(1)
}

for (const d of displays) {
  const t0 = Date.now()
  try {
    const frame = addon.captureFrame(d.deviceName, { timeoutMs: 300 })
    const cost = Date.now() - t0
    const expected = frame.width * frame.height * 4
    const ok = frame.data.length === expected
    // 采样中心像素，确认不是全黑（简单 sanity check）
    const mid = (Math.floor(frame.height / 2) * frame.width + Math.floor(frame.width / 2)) * 4
    const [b, g, r, a] = [frame.data[mid], frame.data[mid + 1], frame.data[mid + 2], frame.data[mid + 3]]
    console.log(`\n=== captureFrame ${d.deviceName} ===`)
    console.log(`  ${frame.width}x${frame.height} rot=${frame.rotation} dpi=${frame.dpiScale} fmt=${frame.format}`)
    console.log(`  bytes=${frame.data.length} expected=${expected} match=${ok}`)
    console.log(`  center BGRA=(${b},${g},${r},${a})  耗时=${cost}ms`)
  } catch (e) {
    console.error(`\n抓帧失败 ${d.deviceName}:`, e.message)
  }
}

// 第二次抓帧测常驻会话复用（应更快）
if (displays.length) {
  const d = displays[0]
  const t0 = Date.now()
  addon.captureFrame(d.deviceName, { timeoutMs: 300 })
  console.log(`\n复用会话二次抓帧 ${d.deviceName} 耗时=${Date.now() - t0}ms`)
}

addon.dispose()
console.log('\n=== dispose done ===')
