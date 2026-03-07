use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageFormat;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use std::sync::OnceLock;

struct GlobalPdfium(&'static Pdfium);
unsafe impl Sync for GlobalPdfium {}
unsafe impl Send for GlobalPdfium {}

static GLOBAL_PDFIUM: OnceLock<GlobalPdfium> = OnceLock::new();

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
    let pdfium = GLOBAL_PDFIUM
        .get()
        .expect("PDFium not initialized");

    let doc = pdfium
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
        // Correctly account for rotation: if 90 or 270 degrees, swap width and height
        let rotation = page.rotation().map(|r| r.as_degrees()).unwrap_or(0.0);
        let mut w = page.width().value;
        let mut h = page.height().value;

        if rotation == 90.0 || rotation == 270.0 {
            std::mem::swap(&mut w, &mut h);
        }

        dimensions.push(PageDimensions {
            width: w,
            height: h,
        });
    }

    Ok(dimensions)
}

#[derive(Deserialize)]
struct SelectionRect {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

#[derive(Serialize)]
struct TextRect {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

/// Given a page index and a selection rectangle (in unscaled PDF point coordinates,
/// with origin at top-left and Y increasing downward), returns the bounding rectangles
/// of all text characters within that selection.
#[tauri::command]
fn get_text_rects(
    page_index: u16,
    selection: SelectionRect,
    state: State<'_, AppState>,
) -> Result<Vec<TextRect>, String> {
    let doc_guard = state.document.lock().unwrap();
    let doc = doc_guard.0.as_ref().ok_or("No PDF loaded")?;
    let page = doc.pages().get(page_index).map_err(|e| e.to_string())?;

    let page_height = page.height().value;

    // Convert from top-left origin (frontend) to bottom-left origin (PDF)
    // Frontend: y increases downward; PDF: y increases upward
    let pdf_bottom = page_height - selection.bottom;
    let pdf_top = page_height - selection.top;
    let pdf_left = selection.left;
    let pdf_right = selection.right;

    let rect = PdfRect::new_from_values(
        pdf_bottom, pdf_left, pdf_top, pdf_right,
    );

    let text = page.text().map_err(|e| e.to_string())?;
    let chars = text.chars_inside_rect(rect).map_err(|e| e.to_string())?;

    let mut rects = Vec::new();
    for ch in chars.iter() {
        if let Ok(bounds) = ch.loose_bounds() {
            // Convert back from PDF coords (bottom-left origin) to frontend coords (top-left origin)
            let x = bounds.left().value;
            let y = page_height - bounds.top().value;
            let w = bounds.right().value - bounds.left().value;
            let h = bounds.top().value - bounds.bottom().value;
            if w > 0.0 && h > 0.0 {
                rects.push(TextRect { x, y, width: w, height: h });
            }
        }
    }

    // Merge character rects that are on the same line into larger rects
    // This creates clean line-level highlight rectangles
    let merged = merge_text_rects(rects);

    Ok(merged)
}

/// Merge individual character rectangles into line-level rectangles.
/// Characters on the same line (similar y and height) get merged into a single rect.
fn merge_text_rects(mut rects: Vec<TextRect>) -> Vec<TextRect> {
    if rects.is_empty() {
        return rects;
    }

    // Sort by y position (top), then by x position (left)
    rects.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut merged: Vec<TextRect> = Vec::new();

    for r in rects {
        if let Some(last) = merged.last_mut() {
            // If same line (y position within tolerance) and overlapping/adjacent horizontally
            let y_tolerance = last.height * 0.3;
            if (last.y - r.y).abs() < y_tolerance
                && (last.height - r.height).abs() < y_tolerance
                && r.x <= last.x + last.width + 2.0
            {
                // Extend the last rect to include this one
                let new_right = f32::max(last.x + last.width, r.x + r.width);
                let new_left = f32::min(last.x, r.x);
                let new_top = f32::min(last.y, r.y);
                let new_bottom = f32::max(last.y + last.height, r.y + r.height);
                last.x = new_left;
                last.y = new_top;
                last.width = new_right - new_left;
                last.height = new_bottom - new_top;
                continue;
            }
        }
        merged.push(r);
    }

    merged
}

#[tauri::command]
async fn render_page(
    page_index: u16,
    scale: f32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let image = {
        let doc_guard = state.document.lock().unwrap();
        let doc = doc_guard.0.as_ref().ok_or("No PDF loaded")?;
        let page = doc.pages().get(page_index).map_err(|e| e.to_string())?;

        // Explicitly calculate width/height with rotation in mind
        let rotation = page.rotation().map(|r| r.as_degrees()).unwrap_or(0.0);
        let (base_w, base_h) = if rotation == 90.0 || rotation == 270.0 {
            (page.height().value, page.width().value)
        } else {
            (page.width().value, page.height().value)
        };

        let target_w = (base_w * scale).round() as i32;
        let target_h = (base_h * scale).round() as i32;

        let mut render_config = PdfRenderConfig::new();
        // Use explicit target size for better robustness across different PDFium versions
        render_config = render_config.set_target_size(target_w, target_h);

        let bitmap = page
            .render_with_config(&render_config)
            .map_err(|e| e.to_string())?;
        bitmap.as_image()
    };

    let mut cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut cursor, ImageFormat::WebP)
        .map_err(|e| e.to_string())?;

    let base64_str = STANDARD.encode(cursor.into_inner());
    Ok(format!("data:image/webp;base64,{}", base64_str))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Warm up PDFium lazily
            if GLOBAL_PDFIUM.get().is_none() {
                let resource_dir = app.path().resource_dir().unwrap_or_else(|_| std::path::PathBuf::from("./"));
                let resource_dir_str = resource_dir.to_str().unwrap_or("./");
                
                let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(resource_dir_str))
                    .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./")))
                    .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./src-tauri/")))
                    .or_else(|_| Pdfium::bind_to_system_library())
                    .expect("Failed to bind to libpdfium");

                
                let pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
                let _ = GLOBAL_PDFIUM.set(GlobalPdfium(pdfium));
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            document: Mutex::new(ThreadSafeDoc(None)),
        })
        .invoke_handler(tauri::generate_handler![
            load_pdf,
            get_pdf_dimensions,
            render_page,
            get_text_rects
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
