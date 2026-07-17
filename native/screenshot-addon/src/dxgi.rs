//! DXGI Desktop Duplication 抓帧核心。
//!
//! 设计要点（充分考虑 Windows 多屏 / 不同分辨率 / 缩放比 / 旋转）：
//!
//! 1. **物理像素**：DXGI 交付的纹理尺寸恒为显示器物理分辨率，与 Windows 缩放比无关。
//!    Electron 的 `display.bounds` 是 DIP（逻辑像素，已被 scaleFactor 除过），因此本层
//!    如实返回物理尺寸 + dpiScale + 桌面坐标，裁剪侧用 `物理尺寸 / DIP bounds` 自算系数。
//!
//! 2. **逐输出会话**：每个显示器一个 `IDXGIOutputDuplication`，常驻缓存复用，免去每次
//!    重建 duplication 对象的开销（那是 DXGI 侧的主要固定成本）。
//!
//! 3. **device name 匹配**：以 `DXGI_OUTPUT_DESC.DeviceName`（如 `\\.\DISPLAY1`）为主键，
//!    比用坐标匹配鲁棒（负坐标、镜像屏、竖屏都不会错位）。
//!
//! 4. **旋转**：竖屏时 `DXGI_MODE_ROTATION` 为 90/270，纹理宽高相对逻辑方向是交换的。
//!    本层如实返回像素宽高 + rotation，交由上层按需还原。
//!
//! 5. **稳健性**：`AcquireNextFrame` 的 `WAIT_TIMEOUT`（无变化）复用上一帧；
//!    `ACCESS_LOST`/`ACCESS_DENIED`（分辨率切换、UAC 弹出、全屏独占进入/退出）时释放并
//!    重建会话重试。绝不 panic，所有失败以 `Result` 上抛。
//!
//! 6. **DPI 感知**：仅用 `GetDpiForMonitor` 读值上报，绝不调用 `SetProcessDpiAwareness`，
//!    避免污染宿主 Electron 进程（其已设为 per-monitor v2）。

use std::collections::HashMap;
use std::time::Instant;

use windows::core::{Interface, Result as WinResult};
use windows::Win32::Foundation::{E_FAIL, HMODULE};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_MODE_ROTATION,
    DXGI_MODE_ROTATION_ROTATE90, DXGI_MODE_ROTATION_ROTATE180, DXGI_MODE_ROTATION_ROTATE270,
    DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1,
    IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_FOUND,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTPUT_DESC,
};
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

/// 单块显示器的元信息（物理坐标系 + DPI）。
#[derive(Clone, Debug)]
pub struct DisplayMeta {
    /// GDI 设备名，如 `\\.\DISPLAY1`，作为与 Electron display 匹配的主键。
    pub device_name: String,
    /// 桌面左上角物理坐标（可为负）。
    pub left: i32,
    pub top: i32,
    /// 物理像素宽高（已计入旋转，即抓帧纹理的实际尺寸）。
    pub width: u32,
    pub height: u32,
    /// 有效 DPI 缩放（96 = 100%）。0 表示未知。
    pub dpi_scale: f32,
    /// 旋转角度：0 / 90 / 180 / 270。
    pub rotation: u32,
    /// 该 output 在 factory 中的 (adapter_index, output_index)。
    /// 保留给未来「按索引快速重建」；当前 create_session 以 device_name 匹配，暂未读取。
    #[allow(dead_code)]
    adapter_index: u32,
    #[allow(dead_code)]
    output_index: u32,
}

/// 一帧抓取结果：BGRA 紧凑像素（已按 stride 去除行填充）。
pub struct Frame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub rotation: u32,
    pub dpi_scale: f32,
}

/// 单块显示器的常驻抓帧会话。
struct OutputSession {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    output1: IDXGIOutput1,
    duplication: Option<IDXGIOutputDuplication>,
    /// 上一帧的紧凑 BGRA 缓存，用于 WAIT_TIMEOUT（画面无变化）时复用。
    last_frame: Option<Frame>,
    meta: DisplayMeta,
}

/// 抓帧管理器：缓存每块屏的会话，供 napi 层调度。
pub struct CaptureManager {
    /// key = device_name。
    sessions: HashMap<String, OutputSession>,
}

fn rotation_to_deg(r: DXGI_MODE_ROTATION) -> u32 {
    match r {
        DXGI_MODE_ROTATION_ROTATE90 => 90,
        DXGI_MODE_ROTATION_ROTATE180 => 180,
        DXGI_MODE_ROTATION_ROTATE270 => 270,
        _ => 0,
    }
}

fn device_name_of(desc: &DXGI_OUTPUT_DESC) -> String {
    // DeviceName 是以 NUL 结尾的 UTF-16 定长数组。
    let raw = &desc.DeviceName;
    let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..end])
}

fn dpi_scale_of(monitor: HMONITOR) -> f32 {
    if monitor.0.is_null() {
        return 0.0;
    }
    let mut dpi_x: u32 = 0;
    let mut dpi_y: u32 = 0;
    // 失败（旧系统 / 无 shcore）时返回 0，让上层回退到 Electron 的 scaleFactor。
    match unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) } {
        Ok(()) if dpi_x > 0 => dpi_x as f32 / 96.0,
        _ => 0.0,
    }
}

/// 为单个 output 创建 D3D11 设备 + duplication 会话所需的元件。
fn build_meta(
    output: &IDXGIOutput,
    adapter_index: u32,
    output_index: u32,
) -> WinResult<DisplayMeta> {
    // windows 0.58：IDXGIOutput::GetDesc 无 out 参数，直接返回 Result<DXGI_OUTPUT_DESC>。
    let desc = unsafe { output.GetDesc()? };

    let coords = desc.DesktopCoordinates;
    let rotation = rotation_to_deg(desc.Rotation);
    // DesktopCoordinates 是逻辑（DIP）坐标；物理像素宽高从 duplication desc 或纹理拿。
    // 这里先用桌面坐标算出 DIP 宽高占位，真正的物理尺寸在抓帧时以纹理 desc 为准覆盖。
    let dip_width = (coords.right - coords.left).max(0) as u32;
    let dip_height = (coords.bottom - coords.top).max(0) as u32;

    Ok(DisplayMeta {
        device_name: device_name_of(&desc),
        left: coords.left,
        top: coords.top,
        width: dip_width,
        height: dip_height,
        dpi_scale: dpi_scale_of(desc.Monitor),
        rotation,
        adapter_index,
        output_index,
    })
}

/// 创建绑定到指定 adapter 的 D3D11 设备。
fn create_device(adapter: &IDXGIAdapter1) -> WinResult<(ID3D11Device, ID3D11DeviceContext)> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    let feature_levels = [D3D_FEATURE_LEVEL_11_0];

    unsafe {
        D3D11CreateDevice(
            adapter,
            // adapter 非空时驱动类型必须为 UNKNOWN。
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }

    match (device, context) {
        (Some(d), Some(c)) => Ok((d, c)),
        _ => Err(E_FAIL.into()),
    }
}

impl CaptureManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// 枚举所有显示器元信息（不建立 duplication 会话，轻量）。
    pub fn list_displays() -> WinResult<Vec<DisplayMeta>> {
        let mut result = Vec::new();
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };

        let mut adapter_index = 0u32;
        loop {
            let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
                Ok(a) => a,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(e),
            };

            let mut output_index = 0u32;
            loop {
                let output = match unsafe { adapter.EnumOutputs(output_index) } {
                    Ok(o) => o,
                    Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                    Err(e) => return Err(e),
                };
                if let Ok(meta) = build_meta(&output, adapter_index, output_index) {
                    result.push(meta);
                }
                output_index += 1;
            }
            adapter_index += 1;
        }

        Ok(result)
    }

    /// 抓取指定显示器的当前帧。会话缺失则建立，`ACCESS_LOST` 则重建重试。
    pub fn capture(&mut self, device_name: &str, timeout_ms: u32) -> WinResult<Frame> {
        // 命中缓存直接抓；未命中则新建会话。
        if !self.sessions.contains_key(device_name) {
            let session = Self::create_session(device_name)?;
            self.sessions.insert(device_name.to_string(), session);
        }

        // 第一次尝试；若 ACCESS_LOST 则重建会话再试一次。
        match self.capture_once(device_name, timeout_ms) {
            Ok(frame) => Ok(frame),
            Err(e) if is_recoverable(e.code()) => {
                // 释放旧会话，重建后重试一次。
                self.sessions.remove(device_name);
                let session = Self::create_session(device_name)?;
                self.sessions.insert(device_name.to_string(), session);
                self.capture_once(device_name, timeout_ms)
            }
            Err(e) => Err(e),
        }
    }

    /// 释放全部会话（用于 dispose / 屏幕配置变化后整体重建）。
    pub fn dispose(&mut self) {
        self.sessions.clear();
    }

    /// 按 device_name 定位 output，建立 D3D 设备 + duplication 会话。
    fn create_session(device_name: &str) -> WinResult<OutputSession> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };

        let mut adapter_index = 0u32;
        loop {
            let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
                Ok(a) => a,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(e),
            };

            let mut output_index = 0u32;
            loop {
                let output = match unsafe { adapter.EnumOutputs(output_index) } {
                    Ok(o) => o,
                    Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                    Err(e) => return Err(e),
                };

                let meta = match build_meta(&output, adapter_index, output_index) {
                    Ok(m) => m,
                    Err(_) => {
                        output_index += 1;
                        continue;
                    }
                };

                if meta.device_name != device_name {
                    output_index += 1;
                    continue;
                }

                // 命中目标显示器：建设备 + duplication。
                let (device, context) = create_device(&adapter)?;
                let output1: IDXGIOutput1 = output.cast()?;
                let duplication = unsafe { output1.DuplicateOutput(&device)? };

                return Ok(OutputSession {
                    device,
                    context,
                    output1,
                    duplication: Some(duplication),
                    last_frame: None,
                    meta,
                });
            }
            adapter_index += 1;
        }

        Err(DXGI_ERROR_NOT_FOUND.into())
    }

    fn capture_once(&mut self, device_name: &str, timeout_ms: u32) -> WinResult<Frame> {
        let session = self
            .sessions
            .get_mut(device_name)
            .ok_or_else(|| windows::core::Error::from(DXGI_ERROR_NOT_FOUND))?;

        session.acquire_frame(timeout_ms)
    }
}

impl OutputSession {
    /// 若 duplication 丢失则重建（同一 output）。
    fn ensure_duplication(&mut self) -> WinResult<()> {
        if self.duplication.is_none() {
            // DuplicateOutput 在全屏/GPU 模式切换时可能返回 DXGI_ERROR_UNSUPPORTED 或短暂失败。
            // 不阻塞重试，失败直接上抛由上层回退，避免同步卡住主线程。
            let dup = unsafe { self.output1.DuplicateOutput(&self.device)? };
            self.duplication = Some(dup);
        }
        Ok(())
    }

    fn acquire_frame(&mut self, timeout_ms: u32) -> WinResult<Frame> {
        self.ensure_duplication()?;
        let dup = self.duplication.as_ref().unwrap().clone();

        let debug = std::env::var("SHOT_DEBUG").is_ok();

        // 【DXGI 首帧空白】DuplicateOutput 后的首次 AcquireNextFrame 常返回一张
        // LastPresentTime==0 的“空/仅指针”帧：桌面图像尚未填充，直接拷会得到全 0。
        // 对策：在总预算 timeout_ms 内循环，丢弃 LastPresentTime==0 的帧，直到拿到
        // 有真实内容（LastPresentTime!=0）的帧。会话常驻 + hover 预热，此 priming 代价
        // 只在建会话时付一次；用户真正点击抓图时帧早已就绪，热路径零额外开销。
        let deadline = Instant::now() + std::time::Duration::from_millis(timeout_ms.max(1) as u64);
        // 每次 acquire 的等待上限：给足单帧合成时间，又能在静止屏上快速轮转。
        let per_wait_ms: u32 = 60;

        loop {
            let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;

            let acquire =
                unsafe { dup.AcquireNextFrame(per_wait_ms, &mut frame_info, &mut resource) };

            if debug {
                eprintln!(
                    "[dxgi] {} acquire={:?} lastPresent={} accumFrames={} rects={} ptrVisible={}",
                    self.meta.device_name,
                    acquire.as_ref().map(|_| "ok").map_err(|e| e.code().0),
                    frame_info.LastPresentTime,
                    frame_info.AccumulatedFrames,
                    frame_info.TotalMetadataBufferSize,
                    frame_info.PointerPosition.Visible.as_bool(),
                );
            }

            match acquire {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    // 本次等待窗口内无新帧。已有缓存帧则直接复用（画面无变化）。
                    unsafe { dup.ReleaseFrame().ok() };
                    if let Some(last) = &self.last_frame {
                        return Ok(last.clone());
                    }
                    // 尚无任何帧（priming 中）：预算未尽则继续，耗尽则上抛。
                    if Instant::now() >= deadline {
                        return Err(e);
                    }
                    continue;
                }
                Err(e) => {
                    // ACCESS_LOST 等：清掉 duplication，交由上层重建会话。
                    self.duplication = None;
                    return Err(e);
                }
            }

            // LastPresentTime==0：桌面图像未更新的空/仅指针帧。释放后重试（预算内）。
            if frame_info.LastPresentTime == 0 {
                unsafe { dup.ReleaseFrame().ok() };
                if Instant::now() >= deadline {
                    // 预算耗尽仍无真实帧：有缓存帧则用缓存，否则上抛让上层重试/重建。
                    if let Some(last) = &self.last_frame {
                        return Ok(last.clone());
                    }
                    return Err(DXGI_ERROR_WAIT_TIMEOUT.into());
                }
                continue;
            }

            // 拿到有内容的帧 → 转 ID3D11Texture2D 并拷出。
            let acquired_texture: ID3D11Texture2D = match resource.as_ref() {
                Some(r) => match r.cast() {
                    Ok(t) => t,
                    Err(e) => {
                        unsafe { dup.ReleaseFrame().ok() };
                        return Err(e);
                    }
                },
                None => {
                    unsafe { dup.ReleaseFrame().ok() };
                    return Err(E_FAIL.into());
                }
            };

            let copy_result = self.copy_to_cpu(&acquired_texture);

            // 无论成败都要释放帧，否则下次 AcquireNextFrame 会阻塞。
            unsafe { dup.ReleaseFrame().ok() };

            let frame = copy_result?;
            self.last_frame = Some(frame.clone());
            return Ok(frame);
        }
    }

    fn srgb_gamma_encode(linear: f32) -> u8 {
        let x = linear.clamp(0.0, 1.0);
        let encoded = if x <= 0.0031308 {
            x * 12.92
        } else {
            1.055 * x.powf(1.0 / 2.4) - 0.055
        };
        (encoded * 255.0).round() as u8
    }

    fn hdr_to_sdr_pixel(r: f32, g: f32, b: f32, _a: f32) -> [u8; 4] {
        const SDR_WHITE_LEVEL: f32 = 1.0;
        let scale = 1.0 / SDR_WHITE_LEVEL;
        let r_scaled = (r * scale).clamp(0.0, 1.0);
        let g_scaled = (g * scale).clamp(0.0, 1.0);
        let b_scaled = (b * scale).clamp(0.0, 1.0);
        [
            Self::srgb_gamma_encode(b_scaled),
            Self::srgb_gamma_encode(g_scaled),
            Self::srgb_gamma_encode(r_scaled),
            255,
        ]
    }

    fn copy_to_cpu_unorm(&self, src: &ID3D11Texture2D, width: u32, height: u32) -> WinResult<Frame> {
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };

        let mut staging: Option<ID3D11Texture2D> = None;
        unsafe {
            self.device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))?;
        }
        let staging = staging.ok_or_else(|| windows::core::Error::from(E_FAIL))?;

        unsafe {
            self.context.CopyResource(&staging, src);
        }

        let mut mapped = windows::Win32::Graphics::Direct3D11::D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }

        let row_pitch = mapped.RowPitch as usize;
        let tight_stride = (width as usize) * 4;
        let mut data = vec![0u8; tight_stride * height as usize];

        unsafe {
            let src_ptr = mapped.pData as *const u8;
            for row in 0..height as usize {
                let src_row = src_ptr.add(row * row_pitch);
                let dst_row = data.as_mut_ptr().add(row * tight_stride);
                std::ptr::copy_nonoverlapping(src_row, dst_row, tight_stride);
            }
            self.context.Unmap(&staging, 0);
        }

        for px in data.chunks_exact_mut(4) {
            px[3] = 255;
        }

        Ok(Frame {
            data,
            width,
            height,
            rotation: self.meta.rotation,
            dpi_scale: self.meta.dpi_scale,
        })
    }

    fn f16_to_f32(f16: u16) -> f32 {
        const SCALE_10: f32 = 1.0 / 1024.0;
        let sign = ((f16 >> 15) & 1) != 0;
        let exp = (f16 >> 10) & 0x1F;
        let frac = f16 & 0x3FF;

        if exp == 0 {
            if frac == 0 {
                return if sign { -0.0 } else { 0.0 };
            }
            let value = (frac as f32) * SCALE_10;
            let result = value * (2.0f32).powf(-14.0);
            return if sign { -result } else { result };
        }

        if exp == 31 {
            if frac == 0 {
                return if sign { f32::NEG_INFINITY } else { f32::INFINITY };
            }
            return f32::NAN;
        }

        let value = 1.0 + (frac as f32) * SCALE_10;
        let result = value * (2.0f32).powf(exp as f32 - 15.0);
        if sign { -result } else { result }
    }

    fn copy_to_cpu_float(&self, src: &ID3D11Texture2D, width: u32, height: u32) -> WinResult<Frame> {
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };

        let mut staging: Option<ID3D11Texture2D> = None;
        unsafe {
            self.device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))?;
        }
        let staging = staging.ok_or_else(|| windows::core::Error::from(E_FAIL))?;

        unsafe {
            self.context.CopyResource(&staging, src);
        }

        let mut mapped = windows::Win32::Graphics::Direct3D11::D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }

        let row_pitch = mapped.RowPitch as usize;
        let tight_stride = (width as usize) * 4;
        let mut data = vec![0u8; tight_stride * height as usize];

        unsafe {
            let src_ptr = mapped.pData as *const u16;
            for row in 0..height as usize {
                let dst_row = data.as_mut_ptr().add(row * tight_stride);
                for col in 0..width as usize {
                    let pixel_idx = (row * (row_pitch / 2) + col * 4) as isize;
                    let r = Self::f16_to_f32(src_ptr.offset(pixel_idx).read());
                    let g = Self::f16_to_f32(src_ptr.offset(pixel_idx + 1).read());
                    let b = Self::f16_to_f32(src_ptr.offset(pixel_idx + 2).read());
                    let a = Self::f16_to_f32(src_ptr.offset(pixel_idx + 3).read());
                    let px = Self::hdr_to_sdr_pixel(r, g, b, a);
                    let dst_idx = (row * tight_stride + col * 4) as isize;
                    dst_row.offset(dst_idx).write(px[0]);
                    dst_row.offset(dst_idx + 1).write(px[1]);
                    dst_row.offset(dst_idx + 2).write(px[2]);
                    dst_row.offset(dst_idx + 3).write(px[3]);
                }
            }
            self.context.Unmap(&staging, 0);
        }

        Ok(Frame {
            data,
            width,
            height,
            rotation: self.meta.rotation,
            dpi_scale: self.meta.dpi_scale,
        })
    }

    /// 将 GPU 纹理复制到可 CPU 读取的 staging texture，再按 stride 逐行拷成紧凑 BGRA。
    fn copy_to_cpu(&self, src: &ID3D11Texture2D) -> WinResult<Frame> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { src.GetDesc(&mut desc) };

        let width = desc.Width;
        let height = desc.Height;
        let is_hdr = desc.Format == DXGI_FORMAT_R16G16B16A16_FLOAT;

        if std::env::var("SHOT_DEBUG").is_ok() {
            eprintln!(
                "[dxgi] copy_to_cpu format={} is_hdr={} size={}x{}",
                format!("{:?}", desc.Format),
                is_hdr,
                width,
                height
            );
        }

        if is_hdr {
            self.copy_to_cpu_float(src, width, height)
        } else {
            self.copy_to_cpu_unorm(src, width, height)
        }
    }
}

impl Clone for Frame {
    fn clone(&self) -> Self {
        Frame {
            data: self.data.clone(),
            width: self.width,
            height: self.height,
            rotation: self.rotation,
            dpi_scale: self.dpi_scale,
        }
    }
}

/// 判断错误是否可通过「重建会话」恢复。
fn is_recoverable(code: windows::core::HRESULT) -> bool {
    code == DXGI_ERROR_ACCESS_LOST
        || code == windows::Win32::Foundation::E_ACCESSDENIED
        || code == DXGI_ERROR_NOT_FOUND
}
