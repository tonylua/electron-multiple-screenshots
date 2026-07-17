//! napi 导出层：把 DXGI 抓帧能力暴露给 Electron 主进程。
//!
//! 暴露的 API（camelCase 由 napi 自动转换）：
//!   - `listDisplays()`                 枚举显示器（同步，轻量：只建瞬时 factory 枚举，不抓帧）
//!   - `captureFrame(deviceName, opts)` 抓取指定屏当前帧，返回 Promise<FrameResult>（BGRA Buffer + 元信息）
//!   - `primeDisplays(names?)`          预热：建立常驻会话并抓帧丢弃，返回 Promise<number>
//!   - `dispose()`                      释放全部常驻会话
//!
//! 【线程模型】DXGI duplication 会话（含 D3D 设备）非 Send，且要求同一线程 Acquire/Release。
//! 若在 Electron 主线程同步抓帧，遇到全屏/GPU 状态切换时 `DuplicateOutput`/`AcquireNextFrame`
//! 会阻塞，直接冻结整个主进程（曾观测到单次 8.5s 卡死）。
//! 对策：所有抓帧操作交给一个**专用 DXGI 工作线程**（持有 CaptureManager，保证 COM 亲和性），
//! napi 侧用 AsyncTask（在 libuv 线程池执行 compute），通过 channel 把命令投递给工作线程并等结果。
//! 这样主线程永不阻塞，慢抓帧最多让某次 Promise 晚 resolve，UI 不冻结。

#![deny(clippy::all)]

mod dxgi;

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::OnceLock;
use std::thread;

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

use dxgi::{CaptureManager, DisplayMeta, Frame};

/// 默认抓帧超时（毫秒）。首帧可能需要一次合成器循环，给足余量。
const DEFAULT_TIMEOUT_MS: u32 = 300;

// ---------------------------------------------------------------------------
// 专用 DXGI 工作线程：所有会话操作都在这一个线程上执行，保证 COM 亲和性 + 不阻塞主线程。
// ---------------------------------------------------------------------------

enum Command {
    Capture {
        device: String,
        timeout: u32,
        resp: Sender<std::result::Result<Frame, String>>,
    },
    Prime {
        names: Option<Vec<String>>,
        resp: Sender<u32>,
    },
    Dispose {
        resp: Sender<()>,
    },
}

static SENDER: OnceLock<Sender<Command>> = OnceLock::new();

fn fmt_err(e: windows::core::Error) -> String {
    format!("DXGI capture failed: {} (0x{:08X})", e.message(), e.code().0)
}

/// 惰性启动工作线程并返回命令发送端。
fn sender() -> &'static Sender<Command> {
    SENDER.get_or_init(|| {
        let (tx, rx) = channel::<Command>();
        thread::Builder::new()
            .name("dxgi-capture".into())
            .spawn(move || worker_main(rx))
            .expect("spawn dxgi-capture worker thread");
        tx
    })
}

/// 工作线程主循环：独占 CaptureManager，串行处理命令。
fn worker_main(rx: Receiver<Command>) {
    let mut mgr = CaptureManager::new();
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Command::Capture {
                device,
                timeout,
                resp,
            } => {
                let r = mgr.capture(&device, timeout).map_err(fmt_err);
                let _ = resp.send(r);
            }
            Command::Prime { names, resp } => {
                let targets: Vec<String> = match names {
                    Some(n) if !n.is_empty() => n,
                    _ => CaptureManager::list_displays()
                        .map(|v| v.into_iter().map(|m| m.device_name).collect())
                        .unwrap_or_default(),
                };
                let mut primed = 0u32;
                for name in &targets {
                    if mgr.capture(name, DEFAULT_TIMEOUT_MS).is_ok() {
                        primed += 1;
                    }
                }
                let _ = resp.send(primed);
            }
            Command::Dispose { resp } => {
                mgr.dispose();
                let _ = resp.send(());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// JS 侧数据结构
// ---------------------------------------------------------------------------

/// 显示器信息，返回给 JS。
#[napi(object)]
pub struct DisplayInfo {
    /// GDI 设备名，如 `\\.\DISPLAY1`。与 Electron display 匹配的主键。
    pub device_name: String,
    /// 桌面左上角物理坐标（可为负）。
    pub left: i32,
    pub top: i32,
    /// 物理像素宽高（已计入旋转）。
    pub width: u32,
    pub height: u32,
    /// 有效 DPI 缩放（1.0 = 100%）。0 表示未知，上层回退到 Electron scaleFactor。
    pub dpi_scale: f64,
    /// 旋转角度：0 / 90 / 180 / 270。
    pub rotation: u32,
}

/// 抓帧选项。
#[napi(object)]
pub struct CaptureOptions {
    /// AcquireNextFrame 超时（毫秒）。缺省 300。
    pub timeout_ms: Option<u32>,
}

/// 一帧结果。
#[napi(object)]
pub struct FrameResult {
    /// BGRA8 紧凑像素（无行填充），长度 = width * height * 4。
    pub data: Buffer,
    /// 像素宽高（物理）。
    pub width: u32,
    pub height: u32,
    /// 旋转角度：0 / 90 / 180 / 270。
    pub rotation: u32,
    /// 有效 DPI 缩放（1.0 = 100%）。0 表示未知。
    pub dpi_scale: f64,
    /// 像素格式，固定 "bgra8"。便于上层无歧义构建 NativeImage。
    pub format: String,
}

impl From<DisplayMeta> for DisplayInfo {
    fn from(m: DisplayMeta) -> Self {
        DisplayInfo {
            device_name: m.device_name,
            left: m.left,
            top: m.top,
            width: m.width,
            height: m.height,
            dpi_scale: m.dpi_scale as f64,
            rotation: m.rotation,
        }
    }
}

impl From<Frame> for FrameResult {
    fn from(f: Frame) -> Self {
        FrameResult {
            data: f.data.into(),
            width: f.width,
            height: f.height,
            rotation: f.rotation,
            dpi_scale: f.dpi_scale as f64,
            format: "bgra8".to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// 异步任务（compute 在 libuv 线程池执行，转发给 DXGI 工作线程并等结果，主线程不阻塞）
// ---------------------------------------------------------------------------

pub struct CaptureTask {
    device: String,
    timeout: u32,
}

impl Task for CaptureTask {
    type Output = Frame;
    type JsValue = FrameResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let (tx, rx) = channel();
        sender()
            .send(Command::Capture {
                device: self.device.clone(),
                timeout: self.timeout,
                resp: tx,
            })
            .map_err(|_| Error::new(Status::GenericFailure, "dxgi worker unavailable"))?;
        match rx.recv() {
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(msg)) => Err(Error::new(Status::GenericFailure, msg)),
            Err(_) => Err(Error::new(Status::GenericFailure, "dxgi worker dropped")),
        }
    }

    fn resolve(&mut self, _env: Env, output: Frame) -> Result<Self::JsValue> {
        Ok(FrameResult::from(output))
    }
}

pub struct PrimeTask {
    names: Option<Vec<String>>,
}

impl Task for PrimeTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        let (tx, rx) = channel();
        sender()
            .send(Command::Prime {
                names: self.names.take(),
                resp: tx,
            })
            .map_err(|_| Error::new(Status::GenericFailure, "dxgi worker unavailable"))?;
        rx.recv()
            .map_err(|_| Error::new(Status::GenericFailure, "dxgi worker dropped"))
    }

    fn resolve(&mut self, _env: Env, output: u32) -> Result<Self::JsValue> {
        Ok(output)
    }
}

// ---------------------------------------------------------------------------
// napi 导出
// ---------------------------------------------------------------------------

/// 枚举所有显示器。同步、轻量（只建瞬时 factory 枚举，不触碰 duplication，不会阻塞）。
#[napi]
pub fn list_displays() -> Result<Vec<DisplayInfo>> {
    let metas = CaptureManager::list_displays()
        .map_err(|e| Error::new(Status::GenericFailure, fmt_err(e)))?;
    Ok(metas.into_iter().map(DisplayInfo::from).collect())
}

/// 抓取指定显示器的当前帧（异步）。会话按需建立并常驻复用。
///
/// `device_name` 取自 `listDisplays()` 的 `deviceName`。返回 Promise，不阻塞主线程。
#[napi]
pub fn capture_frame(
    device_name: String,
    options: Option<CaptureOptions>,
) -> AsyncTask<CaptureTask> {
    let timeout = options
        .and_then(|o| o.timeout_ms)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    AsyncTask::new(CaptureTask {
        device: device_name,
        timeout,
    })
}

/// 预热（异步）：为所有（或指定）显示器建立常驻 DXGI 会话并抓一帧丢弃，消化首次 priming 成本
/// （~200ms），使后续 `captureFrame` 命中缓存仅 ~10ms。返回成功预热的会话数。
///
/// `device_names` 省略则预热全部；传入则只预热指定屏（如排除 HUD 屏）。
#[napi]
pub fn prime_displays(device_names: Option<Vec<String>>) -> AsyncTask<PrimeTask> {
    AsyncTask::new(PrimeTask {
        names: device_names,
    })
}

/// 释放全部常驻抓帧会话（屏幕配置变化或退出时调用）。在工作线程上执行释放，保证 COM 正确性。
#[napi]
pub fn dispose() {
    if let Some(tx) = SENDER.get() {
        let (rtx, rrx) = channel();
        if tx.send(Command::Dispose { resp: rtx }).is_ok() {
            let _ = rrx.recv();
        }
    }
}
