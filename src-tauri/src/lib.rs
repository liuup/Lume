use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageFormat;
use pdfium_render::prelude::*;
use serde::Serialize;
use std::io::Cursor;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

struct GlobalPdfium(&'static Pdfium);
unsafe impl Sync for GlobalPdfium {}
unsafe impl Send for GlobalPdfium {}

lazy_static::lazy_static! {
    static ref GLOBAL_PDFIUM: GlobalPdfium = {
        // macOS path logic for the packaged app. For simplicity in dev, we look in the current executing dir or src-tauri.
        let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
            .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./src-tauri/")))
            .or_else(|_| Pdfium::bind_to_system_library())
            .expect("Failed to bind to libpdfium");
        GlobalPdfium(Box::leak(Box::new(Pdfium::new(bindings))))
    };
}

struct ThreadSafeDoc(Option<PdfDocument<'static>>);
unsafe impl Send for ThreadSafeDoc {}
unsafe impl Sync for ThreadSafeDoc {}

struct AppState {
    document: Mutex<ThreadSafeDoc>,
}

#[tauri::command]
fn load_pdf(path: String, state: State<'_, AppState>) -> Result<u16, String> {
    // Load PDF from path via PDFium directly.
    // This expects the file path to be accessible by C library.
    let doc = GLOBAL_PDFIUM
        .0
        .load_pdf_from_file(&path, None)
        .map_err(|e| format!("Failed to open PDF: {:?}", e))?;

    let pages = doc.pages().len();
    *state.document.lock().unwrap() = ThreadSafeDoc(Some(doc));
    Ok(pages)
}

#[derive(Serialize)]
struct PageDimensions {
    width: f32,
    height: f32,
}

#[tauri::command]
fn get_pdf_dimensions(state: State<'_, AppState>) -> Result<Vec<PageDimensions>, String> {
    let doc_guard = state.document.lock().unwrap();
    let doc = doc_guard.0.as_ref().ok_or("No PDF loaded")?;

    let mut dimensions = Vec::new();
    for page in doc.pages().iter() {
        dimensions.push(PageDimensions {
            width: page.width().value,
            height: page.height().value,
        });
    }

    Ok(dimensions)
}

#[tauri::command]
async fn render_page(
    page_index: u16,
    scale: f32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Asynchronous command to not block the main thread for heavy image rendering.
    // However, our Mutex blocks. We can duplicate the document reference or just hold it briefly to get the page.
    let image = {
        let doc_guard = state.document.lock().unwrap();
        let doc = doc_guard.0.as_ref().ok_or("No PDF loaded")?;
        let page = doc.pages().get(page_index).map_err(|e| e.to_string())?;

        let mut render_config = PdfRenderConfig::new();
        // Base resolution scaling. For retina display clarity, we usually scale > 1.0.
        // Example: If scale is 2.0, a 72DPI standard page becomes 144DPI.
        render_config = render_config.scale_page_by_factor(scale);

        let bitmap = page
            .render_with_config(&render_config)
            .map_err(|e| e.to_string())?;
        bitmap.as_image()
    };

    // We do image conversion and base64 encoding outside the generic lock to keep UI fast.
    let mut cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut cursor, ImageFormat::WebP)
        .map_err(|e| e.to_string())?;

    let base64_str = STANDARD.encode(cursor.into_inner());
    Ok(format!("data:image/webp;base64,{}", base64_str))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Warm up PDFium lazily by accessing it once to ensure bindings are loaded.
    let _ = GLOBAL_PDFIUM.0;

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            document: Mutex::new(ThreadSafeDoc(None)),
        })
        .invoke_handler(tauri::generate_handler![
            load_pdf,
            get_pdf_dimensions,
            render_page
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
