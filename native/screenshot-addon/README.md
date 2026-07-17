# @magicenter/screenshot-addon

基于 **DXGI Desktop Duplication** 的 Windows 屏幕抓帧原生 addon（napi-rs / Rust），
用于替换 Electron `desktopCapturer.getSources` 那条 ~800ms 的重管线。

常驻抓帧会话下，二次抓帧实测 **~8–11ms**（对比 getSources ~800ms）。

## 能力

- 多屏枚举（device name / 物理坐标 / DPI 缩放 / 旋转）
- 逐屏常驻 duplication 会话，复用免重建
- 抓帧返回紧凑 BGRA8（已去 stride 行填充）+ 物理尺寸元信息
- 首帧空白（`LastPresentTime==0` priming 帧）自动跳过重试
- `ACCESS_LOST` / `ACCESS_DENIED`（分辨率切换、UAC、全屏独占）自动重建会话重试
- `WAIT_TIMEOUT`（画面无变化）复用上一帧

## API

```ts
listDisplays(): DisplayInfo[]
captureFrame(deviceName: string, options?: { timeoutMs?: number }): FrameResult
dispose(): void
```

- `DisplayInfo`: `{ deviceName, left, top, width, height, dpiScale, rotation }`
  坐标/尺寸均为**物理像素**；`dpiScale` 为 0 表示未知，上层回退到 Electron `scaleFactor`。
- `FrameResult`: `{ data: Buffer(BGRA8), width, height, rotation, dpiScale, format: "bgra8" }`
  `data.length === width * height * 4`。

### 与 Electron 坐标对接

DXGI 返回物理像素，Electron `display.bounds` 是 DIP（逻辑像素）。裁剪时按
`物理尺寸 / DIP bounds` 自算缩放系数（与现有 `ScreenshotCaptureSession.cropArea` 逻辑一致）。
显示器用 `deviceName`（`\\.\DISPLAYn`）匹配，比坐标匹配鲁棒（负坐标 / 镜像 / 竖屏不错位）。

## 构建

前置：VS 2022 + Windows SDK + MSVC 工具链。工程目录已 `rustup override` 到
`stable-x86_64-pc-windows-msvc`。

```
build-addon.bat      # 产出 screenshot.win32-x64-msvc.node + index.js + index.d.ts（release）
```

产物需针对 **Electron 的 Node ABI** 编译；Electron 升大版本（ABI 变化）后需重新构建。

## 冒烟测试

```
node smoke-test.js           # 枚举 + 抓帧 + 尺寸/byte 校验 + 会话复用耗时
SHOT_DEBUG=1 node smoke-test.js   # 打印每次 acquire 的 frame_info 诊断
```

## 集成注意

- `.node` 是原生模块，打包时必须 `asarUnpack`（不能从 asar 内直接加载）。
- 抓帧应在稳定线程上复用 duplication 对象；addon 用 thread-local 会话，
  配合 napi 默认在 libuv 主线程执行同步方法。
- 被 `setContentProtection(true)`（`WDA_EXCLUDEFROMCAPTURE`）保护的窗口，
  DXGI 抓帧同样会排除——选区/工具栏窗口不会进截图。
