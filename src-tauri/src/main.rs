#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{io::{Read, Write}, path::{Path, PathBuf}};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, webview::NewWindowResponse};

fn io_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
fn read_project(path: PathBuf) -> Result<String, String> {
    if std::fs::metadata(&path).map_err(io_error)?.len() > 16 * 1024 * 1024 {
        return Err("项目文件超过 16 MB".into());
    }
    std::fs::read_to_string(path).map_err(io_error)
}

#[tauri::command]
async fn read_midi(path: PathBuf) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        const LIMIT: u64 = 16 * 1024 * 1024;
        let file = std::fs::File::open(path).map_err(io_error)?;
        if file.metadata().map_err(io_error)?.len() > LIMIT {
            return Err("MIDI 文件超过 16 MB。".into());
        }
        let mut bytes = Vec::new();
        file.take(LIMIT + 1).read_to_end(&mut bytes).map_err(io_error)?;
        if bytes.len() as u64 > LIMIT {
            return Err("MIDI 文件超过 16 MB。".into());
        }
        Ok(tauri::ipc::Response::new(bytes))
    }).await.map_err(io_error)?
}

#[tauri::command]
fn write_project(path: PathBuf, data: String) -> Result<(), String> {
    write_bytes(path, data.as_bytes(), true)
}

#[tauri::command]
async fn write_png(path: PathBuf, replace: bool, data: Vec<u8>) -> Result<(), String> {
    if !data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("无法生成 PNG 图片。".into());
    }
    tauri::async_runtime::spawn_blocking(move || write_bytes(path, &data, replace)).await.map_err(io_error)?
}

fn write_bytes(path: PathBuf, data: &[u8], replace: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("缺少保存目录")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
    file.write_all(data).map_err(io_error)?;
    file.as_file().sync_all().map_err(io_error)?;
    if replace {
        file.persist(&path).map_err(io_error)?;
    } else {
        file.persist_noclobber(&path).map_err(io_error)?;
    }
    Ok(())
}

#[tauri::command]
async fn export_pdf(window: WebviewWindow, path: PathBuf, replace: bool, width: f64, height: f64) -> Result<(), String> {
    use webview2_com::{Microsoft::Web::WebView2::Win32::{ICoreWebView2_2, ICoreWebView2_7, ICoreWebView2Environment6}, PrintToPdfCompletedHandler};
    use windows_core::{Interface, HSTRING, PCWSTR};

    if !(80.0..=600.0).contains(&width) || !(100.0..=1000.0).contains(&height) {
        return Err("宽度须为 80–600 mm，高度须为 100–1000 mm。".into());
    }
    let parent = path.parent().ok_or("缺少导出目录")?;
    let temporary = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?.into_temp_path();
    let temporary_name = Path::new(&temporary).to_string_lossy().into_owned();
    let (sender, receiver) = std::sync::mpsc::channel();
    window.with_webview(move |webview| {
        let callback_sender = sender.clone();
        let result = (|| -> windows_core::Result<()> {
            let core = unsafe { webview.controller().CoreWebView2()? };
            let printing = core.cast::<ICoreWebView2_7>()?;
            let environment = unsafe { core.cast::<ICoreWebView2_2>()?.Environment()? };
            let settings = unsafe { environment.cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()? };
            unsafe {
                settings.SetPageWidth(width / 25.4)?;
                settings.SetPageHeight(height / 25.4)?;
                settings.SetMarginTop(12.0 / 25.4)?;
                settings.SetMarginBottom(12.0 / 25.4)?;
                settings.SetMarginLeft(12.0 / 25.4)?;
                settings.SetMarginRight(12.0 / 25.4)?;
                settings.SetShouldPrintHeaderAndFooter(false)?;
            }
            let callback = PrintToPdfCompletedHandler::create(Box::new(move |status, written| {
                let result = status.map_err(io_error).and_then(|()| {
                    if written { Ok(()) } else { Err("生成 PDF 失败".into()) }
                });
                let _ = callback_sender.send(result);
                Ok(())
            }));
            unsafe { printing.PrintToPdf(PCWSTR(HSTRING::from(temporary_name).as_ptr()), &settings, &callback) }
        })();
        if let Err(error) = result {
            let _ = sender.send(Err(io_error(error)));
        }
    }).map_err(io_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(std::time::Duration::from_secs(60)).map_err(io_error)??;
        if replace {
            temporary.persist(path).map_err(io_error)?;
        } else {
            temporary.persist_noclobber(path).map_err(io_error)?;
        }
        Ok(())
    }).await.map_err(io_error)?
}

#[tauri::command]
fn system_language() -> &'static str {
    let primary_language = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() } & 0x03ff;
    if primary_language == 0x04 { "zh" } else { "en" }
}

#[tauri::command]
fn open_creator_page() -> Result<(), String> {
    use std::ptr::{null, null_mut};
    use windows_sys::{w, Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL}};

    let result = unsafe {
        ShellExecuteW(null_mut(), w!("open"), w!("https://space.bilibili.com/40005809"), null(), null(), SW_SHOWNORMAL)
    };
    if result as isize > 32 { Ok(()) } else { Err("无法打开 B 站主页。".into()) }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = app.config().app.windows.iter().find(|window| window.label == "main")
                .ok_or("主窗口配置缺失")?;
            let handle = app.handle().clone();
            WebviewWindowBuilder::from_config(app, config)?
                .on_new_window(move |url, features| {
                    let Some(label) = url.fragment().filter(|label| {
                        label.strip_prefix("xianpu-panel-").is_some_and(|id| {
                            id.len() == 36 && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
                        })
                    }) else { return NewWindowResponse::Deny };
                    if url.scheme() != "about" || url.path() != "blank" {
                        return NewWindowResponse::Deny;
                    }
                    let Some(main) = handle.get_webview_window("main") else {
                        return NewWindowResponse::Deny;
                    };
                    let result = WebviewWindowBuilder::new(&handle, label, WebviewUrl::External(url.clone()))
                        .window_features(features)
                        .title("叶子弦谱")
                        .min_inner_size(255.0, 155.0)
                        .skip_taskbar(true)
                        .owner(&main)
                        .and_then(|builder| builder.build());
                    match result {
                        Ok(window) => {
                            let app = handle.clone();
                            let id = label.to_owned();
                            window.on_window_event(move |event| {
                                if matches!(event, WindowEvent::Destroyed) {
                                    let _ = app.emit_to("main", "tool-panel-closed", &id);
                                }
                            });
                            NewWindowResponse::Create { window }
                        }
                        Err(_) => NewWindowResponse::Deny,
                    }
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_project, read_midi, write_project, export_pdf, write_png, system_language, open_creator_page])
        .run(tauri::generate_context!())
        .expect("could not start Yezi XianPu");
}
