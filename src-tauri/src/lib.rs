use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageFormat;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

use std::sync::OnceLock;

struct GlobalPdfium(&'static Pdfium);
unsafe impl Sync for GlobalPdfium {}
unsafe impl Send for GlobalPdfium {}

static GLOBAL_PDFIUM: OnceLock<GlobalPdfium> = OnceLock::new();

struct ThreadSafeDoc(PdfDocument<'static>);
unsafe impl Send for ThreadSafeDoc {}
unsafe impl Sync for ThreadSafeDoc {}

struct AppState {
    documents: Arc<Mutex<HashMap<String, Arc<Mutex<ThreadSafeDoc>>>>>,
}

#[tauri::command]
fn load_pdf(path: String, state: State<'_, AppState>) -> Result<u16, String> {
    let mut docs = state.documents.lock().unwrap();
    if let Some(doc_arc) = docs.get(&path) {
        let doc_lock = doc_arc.lock().unwrap();
        return Ok(doc_lock.0.pages().len());
    }

    // Load PDF from path via PDFium directly.
    let pdfium = GLOBAL_PDFIUM
        .get()
        .expect("PDFium not initialized");

    let doc = pdfium
        .0
        .load_pdf_from_file(&path, None)
        .map_err(|e| format!("Failed to open PDF: {:?}", e))?;

    let pages = doc.pages().len();
    docs.insert(path, Arc::new(Mutex::new(ThreadSafeDoc(doc))));
    Ok(pages)
}

#[derive(Serialize)]
struct PageDimensions {
    width: f32,
    height: f32,
}

#[tauri::command]
fn get_pdf_dimensions(path: String, state: State<'_, AppState>) -> Result<Vec<PageDimensions>, String> {
    let doc_arc = {
        let docs = state.documents.lock().unwrap();
        docs.get(&path).cloned().ok_or("PDF not loaded")?
    };
    let doc_lock = doc_arc.lock().unwrap();
    let doc = &doc_lock.0;

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

#[derive(Serialize)]
struct TextNode {
    text: String,
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
    path: String,
    page_index: u16,
    selection: SelectionRect,
    state: State<'_, AppState>,
) -> Result<Vec<TextRect>, String> {
    let doc_arc = {
        let docs = state.documents.lock().unwrap();
        docs.get(&path).cloned().ok_or("No PDF loaded")?
    };
    let doc_lock = doc_arc.lock().unwrap();
    let doc = &doc_lock.0;
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
fn get_page_text(
    path: String,
    page_index: u16,
    state: State<'_, AppState>,
) -> Result<Vec<TextNode>, String> {
    let doc_arc = {
        let docs = state.documents.lock().unwrap();
        docs.get(&path).cloned().ok_or("No PDF loaded")?
    };
    let doc_lock = doc_arc.lock().unwrap();
    let doc = &doc_lock.0;
    let page = doc.pages().get(page_index).map_err(|e| e.to_string())?;

    let page_height = page.height().value;
    let text_obj = page.text().map_err(|e| e.to_string())?;
    let chars = text_obj.chars();

    let mut nodes: Vec<TextNode> = Vec::new();
    let mut current_node: Option<TextNode> = None;

    for ch in chars.iter() {
        if let Ok(bounds) = ch.loose_bounds() {
            let ch_str = ch.unicode_string().unwrap_or_default();
            let x = bounds.left().value;
            let y = page_height - bounds.top().value;
            let w = bounds.right().value - bounds.left().value;
            let h = bounds.top().value - bounds.bottom().value;

            if w <= 0.0 || h <= 0.0 {
                continue;
            }

            if let Some(mut node) = current_node.take() {
                // If on the same line and very close horizontally (like a word or sentence fragment)
                let y_tolerance = f32::max(node.height, h) * 0.3;
                let horizontal_gap = x - (node.x + node.width);
                
                // Allow up to roughly the height of a character as a gap to still be considered the same text span
                // (This naturally merges words separated by spaces on the same line)
                if (node.y - y).abs() < y_tolerance && x >= node.x && horizontal_gap < node.height * 3.0 {
                    // It's part of the same text run

                    // PDFium character strings sometimes don't include the literal "space" char but just have a gap.
                    // We intelligently inject a space if the gap is larger than a tiny threshold
                    if horizontal_gap > node.height * 0.25 && !node.text.ends_with(' ') && !ch_str.starts_with(' ') {
                        node.text.push(' ');
                    }
                    node.text.push_str(&ch_str);

                    let new_right = f32::max(node.x + node.width, x + w);
                    node.y = f32::min(node.y, y); // top
                    let new_bottom = f32::max(node.y + node.height, y + h);
                    node.width = new_right - node.x;
                    node.height = new_bottom - node.y;
                    current_node = Some(node);
                } else {
                    // Broken run (new line, or huge gap like columns)
                    nodes.push(node);
                    current_node = Some(TextNode { text: ch_str, x, y, width: w, height: h });
                }
            } else {
                current_node = Some(TextNode { text: ch_str, x, y, width: w, height: h });
            }
        }
    }

    if let Some(node) = current_node {
        nodes.push(node);
    }

    Ok(nodes)
}

#[tauri::command]
async fn render_page(
    path: String,
    page_index: u16,
    scale: f32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let doc_arc = {
        let docs = state.documents.lock().unwrap();
        docs.get(&path).cloned().ok_or("No PDF loaded")?
    };
    
    // Offload CPU-bound rendering to a worker thread
    let base64_str = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let image = {
            let doc_lock = doc_arc.lock().unwrap();
            let doc = &doc_lock.0;
            let page = doc.pages().get(page_index).map_err(|e| e.to_string())?;

            // Explicitly calculate width/height with rotation in mind
            let rotation = page.rotation().map(|r| r.as_degrees()).unwrap_or(0.0);
            let (base_w, base_h) = if rotation == 90.0 || rotation == 270.0 {
                (page.height().value, page.width().value)
            } else {
                (page.width().value, page.height().value)
            };

            let mut target_w = (base_w * scale).round() as i32;
            let mut target_h = (base_h * scale).round() as i32;

            // Cap the maximum dimensions to prevent out-of-memory errors on high zoom
            let max_dim = 4000;
            if target_w > max_dim || target_h > max_dim {
                let scale_factor = max_dim as f32 / target_w.max(target_h) as f32;
                target_w = (target_w as f32 * scale_factor).round() as i32;
                target_h = (target_h as f32 * scale_factor).round() as i32;
            }

            let mut render_config = PdfRenderConfig::new();
            // Use explicit target size for better robustness across different PDFium versions
            render_config = render_config.set_target_size(target_w, target_h);

            let bitmap = page
                .render_with_config(&render_config)
                .map_err(|e| e.to_string())?;
            bitmap.as_image()
        };

        let mut cursor = Cursor::new(Vec::new());
        // Jpeg encoding is extremely fast and suitable for document previews
        // If quality degrades too much for text, we can use PNG with fast compression.
        image
            .write_to(&mut cursor, ImageFormat::Jpeg)
            .map_err(|e| e.to_string())?;

        let base64_str = STANDARD.encode(cursor.into_inner());
        Ok(base64_str)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(format!("data:image/jpeg;base64,{}", base64_str))
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
            documents: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            load_pdf,
            get_pdf_dimensions,
            get_text_rects,
            get_page_text,
            render_page
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
