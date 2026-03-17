/// Module: src-tauri/src/pdf_handlers.rs
/// Purpose: Encapsulates all interactions with PDFium.
/// Capabilities: Rendering PDF pages to base64 images, extracting text nodes and selection rects,
/// parsing abstract/metadata directly from the PDF bytes.
use crate::models::SavedPdfPageAnnotations;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use std::io::Cursor;
use std::sync::OnceLock;

pub struct GlobalPdfium(pub &'static Pdfium);
unsafe impl Sync for GlobalPdfium {}
unsafe impl Send for GlobalPdfium {}

pub static GLOBAL_PDFIUM: OnceLock<GlobalPdfium> = OnceLock::new();

pub struct ThreadSafeDoc(pub PdfDocument<'static>);
unsafe impl Send for ThreadSafeDoc {}
unsafe impl Sync for ThreadSafeDoc {}

#[derive(Serialize)]
pub struct TextRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize)]
pub struct SearchMatch {
    pub page_index: u16,
    pub rects: Vec<TextRect>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextNode {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug)]
struct TextFragment {
    text: String,
    x: Option<f32>,
    y: Option<f32>,
    width: Option<f32>,
    height: Option<f32>,
}

#[derive(Deserialize)]
pub struct SelectionRect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

struct SearchChar {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[tauri::command]
pub fn get_text_rects(
    path: String,
    page_index: u16,
    selection: SelectionRect,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<TextRect>, String> {
    let doc_arc = {
        let docs = state.documents.lock().unwrap();
        docs.get(&path).cloned().ok_or("No PDF loaded")?
    };
    let doc_lock = doc_arc.lock().unwrap();
    let doc = &doc_lock.0;
    let page = doc
        .pages()
        .get(page_index)
        .map_err(|e: PdfiumError| e.to_string())?;

    let page_height = page.height().value;

    let pdf_bottom = page_height - selection.bottom;
    let pdf_top = page_height - selection.top;
    let pdf_left = selection.left;
    let pdf_right = selection.right;

    let rect = PdfRect::new_from_values(pdf_bottom, pdf_left, pdf_top, pdf_right);

    let text = page.text().map_err(|e: PdfiumError| e.to_string())?;
    let chars = text
        .chars_inside_rect(rect)
        .map_err(|e: PdfiumError| e.to_string())?;

    let mut rects = Vec::new();
    for ch in chars.iter() {
        if let Ok(bounds) = ch.loose_bounds() {
            let x: f32 = bounds.left().value;
            let y = page_height - bounds.top().value;
            let w = bounds.right().value - bounds.left().value;
            let h = bounds.top().value - bounds.bottom().value;
            if w > 0.0 && h > 0.0 {
                rects.push(TextRect {
                    x,
                    y,
                    width: w,
                    height: h,
                });
            }
        }
    }

    let merged = merge_text_rects(rects);

    Ok(merged)
}

#[tauri::command]
pub fn get_page_text(
    path: String,
    page_index: u16,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<TextNode>, String> {
    let doc_arc = {
        let docs = state.documents.lock().unwrap();
        docs.get(&path).cloned().ok_or("No PDF loaded")?
    };
    let doc_lock = doc_arc.lock().unwrap();
    let doc = &doc_lock.0;
    let page = doc
        .pages()
        .get(page_index)
        .map_err(|e: PdfiumError| e.to_string())?;

    Ok(build_page_text_nodes(&page)?)
}

#[tauri::command]
pub async fn render_page(
    path: String,
    page_index: u16,
    scale: f32,
    profile: Option<String>,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let doc_arc = {
        let docs = state.documents.lock().unwrap();
        docs.get(&path).cloned().ok_or("No PDF loaded")?
    };

    let base64_str = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let render_profile = profile.unwrap_or_else(|| "preview".to_string());
        let image = {
            let doc_lock = doc_arc.lock().unwrap();
            let doc = &doc_lock.0;
            let page = doc
                .pages()
                .get(page_index)
                .map_err(|e: PdfiumError| e.to_string())?;

            let rotation = page
                .rotation()
                .map(|r: PdfPageRenderRotation| r.as_degrees())
                .unwrap_or(0.0);
            let (base_w, base_h) = if rotation == 90.0 || rotation == 270.0 {
                (page.height().value, page.width().value)
            } else {
                (page.width().value, page.height().value)
            };

            let mut target_w: i32 = (base_w * scale).round() as i32;
            let mut target_h: i32 = (base_h * scale).round() as i32;

            let max_dim = if render_profile == "full" { 5600 } else { 3200 };
            if target_w > max_dim || target_h > max_dim {
                let scale_factor = max_dim as f32 / target_w.max(target_h) as f32;
                target_w = (target_w as f32 * scale_factor).round() as i32;
                target_h = (target_h as f32 * scale_factor).round() as i32;
            }

            let mut render_config = PdfRenderConfig::new();
            render_config = render_config.set_target_size(target_w, target_h);

            let bitmap = page
                .render_with_config(&render_config)
                .map_err(|e: PdfiumError| e.to_string())?;
            bitmap.as_image()
        };

        let mut cursor = Cursor::new(Vec::new());
        let jpeg_quality = if render_profile == "full" { 82 } else { 68 };
        JpegEncoder::new_with_quality(&mut cursor, jpeg_quality)
            .encode_image(&image)
            .map_err(|e| e.to_string())?;

        let base64_str = STANDARD.encode(cursor.into_inner());
        Ok(base64_str)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(format!("data:image/jpeg;base64,{}", base64_str))
}

#[tauri::command]
pub fn load_pdf(
    path: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<u16, String> {
    let mut docs = state.documents.lock().unwrap();
    if let Some(doc_arc) = docs.get(&path) {
        let doc_lock = doc_arc.lock().unwrap();
        return Ok(doc_lock.0.pages().len());
    }

    let pdfium = GLOBAL_PDFIUM.get().expect("PDFium not initialized");

    let doc = pdfium
        .0
        .load_pdf_from_file(&path, None)
        .map_err(|e| format!("Failed to open PDF: {:?}", e))?;

    let pages = doc.pages().len();
    docs.insert(
        path,
        std::sync::Arc::new(std::sync::Mutex::new(ThreadSafeDoc(doc))),
    );
    Ok(pages)
}

#[tauri::command]
pub fn get_pdf_dimensions(
    path: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<PageDimensions>, String> {
    let doc_arc = {
        let docs = state.documents.lock().unwrap();
        docs.get(&path).cloned().ok_or("PDF not loaded")?
    };
    let doc_lock = doc_arc.lock().unwrap();
    let doc = &doc_lock.0;

    let mut dimensions = Vec::new();
    for page in doc.pages().iter() {
        let rotation: f32 = page
            .rotation()
            .map(|r: PdfPageRenderRotation| r.as_degrees())
            .unwrap_or(0.0);
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

#[derive(Serialize)]
pub struct PageDimensions {
    pub width: f32,
    pub height: f32,
}

pub fn is_annotation_payload_empty(payload: &SavedPdfPageAnnotations) -> bool {
    payload.paths.is_empty() && payload.text_annotations.is_empty()
}

pub fn merge_page_text_nodes(page: &PdfPage<'_>) -> Result<Vec<TextNode>, String> {
    build_page_text_nodes(page)
}

fn normalize_fragment_text(value: &str) -> String {
    value
        .replace('\u{00A0}', " ")
        .replace('\u{2007}', " ")
        .replace('\u{202F}', " ")
        .replace('\u{00AD}', "")
}

fn build_page_text_fragments(page: &PdfPage<'_>) -> Result<Vec<TextFragment>, String> {
    let page_height = page.height().value;
    let text_obj = page.text().map_err(|e| e.to_string())?;
    let chars = text_obj.chars();
    let mut fragments = Vec::new();

    for ch in chars.iter() {
        let text = normalize_fragment_text(&ch.unicode_string().unwrap_or_default());
        if text.is_empty() {
            continue;
        }

        if let Ok(bounds) = ch.loose_bounds() {
            let x = bounds.left().value;
            let y = page_height - bounds.top().value;
            let width = bounds.right().value - bounds.left().value;
            let height = bounds.top().value - bounds.bottom().value;

            if width > 0.0 && height > 0.0 {
                fragments.push(TextFragment {
                    text,
                    x: Some(x),
                    y: Some(y),
                    width: Some(width),
                    height: Some(height),
                });
                continue;
            }
        }

        fragments.push(TextFragment {
            text,
            x: None,
            y: None,
            width: None,
            height: None,
        });
    }

    Ok(fragments)
}

fn merge_text_fragments(fragments: Vec<TextFragment>) -> Vec<TextNode> {
    let mut nodes: Vec<TextNode> = Vec::new();
    let mut current_node: Option<TextNode> = None;
    let mut pending_space = false;
    let mut pending_line_break = false;

    for fragment in fragments {
        if fragment.text.chars().all(char::is_whitespace) {
            if fragment.text.chars().any(|ch| ch == '\n' || ch == '\r') {
                if let Some(node) = current_node.take() {
                    nodes.push(node);
                }
                pending_line_break = true;
                pending_space = false;
            } else {
                pending_space = true;
            }
            continue;
        }

        let trimmed_text = fragment.text.trim().to_string();
        if trimmed_text.is_empty() {
            continue;
        }

        let (x, y, width, height) = match (fragment.x, fragment.y, fragment.width, fragment.height) {
            (Some(x), Some(y), Some(width), Some(height)) if width > 0.0 && height > 0.0 => {
                (x, y, width, height)
            }
            _ => {
                if let Some(node) = current_node.as_mut() {
                    if pending_space && !node.text.ends_with(' ') {
                        node.text.push(' ');
                    }
                    node.text.push_str(&trimmed_text);
                    pending_space = false;
                    pending_line_break = false;
                }
                continue;
            }
        };

        if let Some(mut node) = current_node.take() {
            let old_bottom = node.y + node.height;
            let y_tolerance = f32::max(node.height, height) * 0.35;
            let horizontal_gap = x - (node.x + node.width);
            let same_line = (node.y - y).abs() < y_tolerance;
            let forward_progress = x >= node.x - f32::max(node.height, height) * 0.2;
            let close_enough = horizontal_gap < f32::max(node.height, height) * 3.2;

            if pending_line_break || !same_line || !forward_progress || !close_enough {
                nodes.push(node);
                current_node = Some(TextNode {
                    text: trimmed_text,
                    x,
                    y,
                    width,
                    height,
                });
            } else {
                if (pending_space || horizontal_gap > f32::max(node.height, height) * 0.18)
                    && !node.text.ends_with(' ')
                {
                    node.text.push(' ');
                }

                node.text.push_str(&trimmed_text);

                let new_right = f32::max(node.x + node.width, x + width);
                node.y = f32::min(node.y, y);
                let new_bottom = f32::max(old_bottom, y + height);
                node.width = new_right - node.x;
                node.height = new_bottom - node.y;
                current_node = Some(node);
            }
        } else {
            current_node = Some(TextNode {
                text: trimmed_text,
                x,
                y,
                width,
                height,
            });
        }

        pending_space = false;
        pending_line_break = false;
    }

    if let Some(node) = current_node {
        nodes.push(node);
    }

    nodes
}

fn build_page_text_nodes(page: &PdfPage<'_>) -> Result<Vec<TextNode>, String> {
    let fragments = build_page_text_fragments(page)?;
    Ok(merge_text_fragments(fragments))
}

pub fn extract_document_text_from_path(
    path: &str,
    max_pages: usize,
    max_chars: usize,
) -> Result<String, String> {
    let pdfium = GLOBAL_PDFIUM.get().ok_or("PDFium not initialized")?;
    let doc = pdfium
        .0
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {:?}", e))?;

    let mut parts = Vec::new();
    let mut total_chars = 0usize;

    for (page_index, page) in doc.pages().iter().enumerate() {
        if page_index >= max_pages || total_chars >= max_chars {
            break;
        }

        let page_text = merge_page_text_nodes(&page)?
            .into_iter()
            .map(|node| node.text.trim().to_string())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        if page_text.is_empty() {
            continue;
        }

        let remaining = max_chars.saturating_sub(total_chars);
        let excerpt = if page_text.chars().count() > remaining {
            let mut truncated = String::new();
            for ch in page_text.chars().take(remaining) {
                truncated.push(ch);
            }
            truncated
        } else {
            page_text
        };

        total_chars += excerpt.chars().count();
        parts.push(format!("## Page {}\n{}", page_index + 1, excerpt));
    }

    Ok(parts.join("\n\n"))
}

#[tauri::command]
pub fn search_pdf_text(
    path: String,
    term: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<SearchMatch>, String> {
    let normalized_term = normalize_search_term(&term);
    if normalized_term.is_empty() {
        return Ok(Vec::new());
    }

    let doc_arc = {
        let docs = state.documents.lock().unwrap();
        docs.get(&path).cloned().ok_or("No PDF loaded")?
    };
    let doc_lock = doc_arc.lock().unwrap();
    let doc = &doc_lock.0;

    let mut matches = Vec::new();

    for (page_index, page) in doc.pages().iter().enumerate() {
        let page_matches = find_page_search_matches(&page, &normalized_term)?;

        for rects in page_matches {
            matches.push(SearchMatch {
                page_index: page_index as u16,
                rects,
            });
        }
    }

    Ok(matches)
}

fn normalize_search_term(term: &str) -> Vec<char> {
    let mut normalized = Vec::new();
    let mut last_was_space = true;

    for ch in term.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                normalized.push(' ');
                last_was_space = true;
            }
            continue;
        }

        for lower in ch.to_lowercase() {
            normalized.push(lower);
        }
        last_was_space = false;
    }

    while normalized.last() == Some(&' ') {
        normalized.pop();
    }

    normalized
}

fn extract_page_search_chars(page: &PdfPage<'_>) -> Result<Vec<SearchChar>, String> {
    let page_height = page.height().value;
    let text_obj = page.text().map_err(|e: PdfiumError| e.to_string())?;
    let chars = text_obj.chars();
    let mut search_chars = Vec::new();

    for ch in chars.iter() {
        if let Ok(bounds) = ch.loose_bounds() {
            let text = ch.unicode_string().unwrap_or_default();
            if text.is_empty() {
                continue;
            }

            let x: f32 = bounds.left().value;
            let y = page_height - bounds.top().value;
            let width = bounds.right().value - bounds.left().value;
            let height = bounds.top().value - bounds.bottom().value;

            if width <= 0.0 || height <= 0.0 {
                continue;
            }

            search_chars.push(SearchChar {
                text,
                x,
                y,
                width,
                height,
            });
        }
    }

    Ok(search_chars)
}

fn build_normalized_search_index(search_chars: &[SearchChar]) -> (Vec<char>, Vec<Option<usize>>) {
    let mut normalized = Vec::new();
    let mut mapping = Vec::new();
    let mut last_was_space = true;
    let mut previous_char: Option<&SearchChar> = None;

    for (char_index, current_char) in search_chars.iter().enumerate() {
        if let Some(previous) = previous_char {
            let y_tolerance = f32::max(previous.height, current_char.height) * 0.35;
            let same_line = (previous.y - current_char.y).abs() < y_tolerance;
            let horizontal_gap = current_char.x - (previous.x + previous.width);
            let line_break =
                !same_line && current_char.x < previous.x + previous.width + previous.height;
            let word_gap =
                same_line && horizontal_gap > f32::max(previous.height, current_char.height) * 0.2;

            if (line_break || word_gap) && !last_was_space {
                normalized.push(' ');
                mapping.push(None);
                last_was_space = true;
            }
        }

        for raw_char in current_char.text.chars() {
            if raw_char.is_whitespace() {
                if !last_was_space {
                    normalized.push(' ');
                    mapping.push(Some(char_index));
                    last_was_space = true;
                }
                continue;
            }

            for lowered in raw_char.to_lowercase() {
                normalized.push(lowered);
                mapping.push(Some(char_index));
            }
            last_was_space = false;
        }

        previous_char = Some(current_char);
    }

    while normalized.last() == Some(&' ') {
        normalized.pop();
        mapping.pop();
    }

    (normalized, mapping)
}

fn find_page_search_matches(
    page: &PdfPage<'_>,
    normalized_term: &[char],
) -> Result<Vec<Vec<TextRect>>, String> {
    let search_chars = extract_page_search_chars(page)?;
    if search_chars.is_empty() || normalized_term.is_empty() {
        return Ok(Vec::new());
    }

    let (normalized_text, mapping) = build_normalized_search_index(&search_chars);
    if normalized_text.len() < normalized_term.len() {
        return Ok(Vec::new());
    }

    let mut matches = Vec::new();

    for start in 0..=(normalized_text.len() - normalized_term.len()) {
        if normalized_text[start..start + normalized_term.len()] != *normalized_term {
            continue;
        }

        let mut rects = Vec::new();
        let mut last_char_index: Option<usize> = None;

        for mapped_index in mapping[start..start + normalized_term.len()]
            .iter()
            .flatten()
        {
            if last_char_index == Some(*mapped_index) {
                continue;
            }

            let search_char = &search_chars[*mapped_index];
            rects.push(TextRect {
                x: search_char.x,
                y: search_char.y,
                width: search_char.width,
                height: search_char.height,
            });
            last_char_index = Some(*mapped_index);
        }

        let merged = merge_text_rects(rects);
        if !merged.is_empty() {
            matches.push(merged);
        }
    }

    Ok(matches)
}

pub fn merge_text_rects(mut rects: Vec<TextRect>) -> Vec<TextRect> {
    if rects.is_empty() {
        return rects;
    }

    rects.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut merged: Vec<TextRect> = Vec::new();

    for r in rects {
        if let Some(last) = merged.last_mut() {
            let y_tolerance = last.height * 0.3;
            if (last.y - r.y).abs() < y_tolerance
                && (last.height - r.height).abs() < y_tolerance
                && r.x <= last.x + last.width + 2.0
            {
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

pub fn extract_page_lines(page: &PdfPage<'_>) -> Result<Vec<String>, String> {
    let mut nodes = merge_page_text_nodes(page)?;
    nodes.sort_by(|left, right| {
        left.y
            .partial_cmp(&right.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.x
                    .partial_cmp(&right.x)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut lines: Vec<(f32, f32, Vec<String>)> = Vec::new();

    for node in nodes {
        let cleaned = crate::metadata_fetch::clean_abstract_text(&node.text);
        if cleaned.is_empty() {
            continue;
        }

        if let Some((line_y, line_height, parts)) = lines.last_mut() {
            let tolerance = f32::max(*line_height, node.height) * 0.45;
            if (*line_y - node.y).abs() <= tolerance {
                *line_y = f32::min(*line_y, node.y);
                *line_height = f32::max(*line_height, node.height);
                parts.push(cleaned);
                continue;
            }
        }

        lines.push((node.y, node.height, vec![cleaned]));
    }

    Ok(lines
        .into_iter()
        .map(|(_, _, parts)| crate::metadata_fetch::clean_abstract_text(&parts.join(" ")))
        .filter(|line| !line.is_empty())
        .collect())
}

pub fn extract_document_lines(document: &PdfDocument<'_>, max_pages: usize) -> Vec<String> {
    document
        .pages()
        .iter()
        .take(max_pages)
        .filter_map(|page| extract_page_lines(&page).ok())
        .flatten()
        .collect()
}

pub fn infer_title_from_first_page(document: &PdfDocument<'_>) -> Option<String> {
    let page = document.pages().get(0).ok()?;
    let page_height = page.height().value;
    let mut candidates = merge_page_text_nodes(&page)
        .ok()?
        .into_iter()
        .map(|node| {
            let cleaned = crate::metadata_fetch::clean_title_text(&node.text);
            (node, cleaned)
        })
        .filter(|(node, cleaned)| {
            node.y < page_height * 0.38
                && node.width > 120.0
                && node.height > 10.0
                && crate::metadata_fetch::is_plausible_title(cleaned)
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return None;
    }

    candidates.sort_by(|(left_node, left_text), (right_node, right_text)| {
        right_node
            .height
            .partial_cmp(&left_node.height)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left_node
                    .y
                    .partial_cmp(&right_node.y)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| right_text.len().cmp(&left_text.len()))
    });

    let anchor_height = candidates[0].0.height;
    let anchor_y = candidates[0].0.y;
    let min_height = anchor_height * 0.72;
    let max_y = anchor_y + anchor_height * 2.8;

    let mut title_lines = candidates
        .into_iter()
        .filter(|(node, _)| {
            node.height >= min_height && node.y >= anchor_y - anchor_height * 0.5 && node.y <= max_y
        })
        .collect::<Vec<_>>();

    title_lines.sort_by(|(left, _), (right, _)| {
        left.y
            .partial_cmp(&right.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.x
                    .partial_cmp(&right.x)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let title = title_lines
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = crate::metadata_fetch::clean_title_text(&title);

    if crate::metadata_fetch::is_plausible_title(&cleaned) {
        Some(cleaned)
    } else {
        None
    }
}

pub fn infer_authors_from_first_page(
    document: &PdfDocument<'_>,
    inferred_title: Option<&str>,
) -> Option<String> {
    let page = document.pages().get(0).ok()?;
    let page_height = page.height().value;
    let nodes = merge_page_text_nodes(&page).ok()?;

    let title_anchor = nodes
        .iter()
        .map(|node| (node, crate::metadata_fetch::clean_title_text(&node.text)))
        .filter(|(node, cleaned)| {
            node.y < page_height * 0.4
                && node.width > 120.0
                && node.height > 10.0
                && crate::metadata_fetch::is_plausible_title(cleaned)
                && inferred_title
                    .map(|title| cleaned.contains(title) || title.contains(cleaned))
                    .unwrap_or(true)
        })
        .max_by(|(left_node, _), (right_node, _)| {
            left_node
                .height
                .partial_cmp(&right_node.height)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

    let (anchor_y, anchor_height) = title_anchor
        .map(|(node, _)| (node.y, node.height))
        .unwrap_or((page_height * 0.12, page_height * 0.035));

    let mut candidates = nodes
        .into_iter()
        .map(|node| {
            let cleaned = crate::metadata_fetch::normalize_authors(&node.text);
            (node, cleaned)
        })
        .filter(|(node, cleaned)| {
            node.y >= anchor_y + anchor_height * 0.45
                && node.y <= anchor_y + anchor_height * 5.0
                && node.y < page_height * 0.55
                && node.height >= anchor_height * 0.28
                && node.height <= anchor_height * 0.95
                && node.width > 80.0
                && crate::metadata_fetch::is_plausible_author_line(cleaned)
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return None;
    }

    candidates.sort_by(|(left, _), (right, _)| {
        left.y
            .partial_cmp(&right.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                right
                    .width
                    .partial_cmp(&left.width)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let author_line = candidates.first()?.1.clone();
    if crate::metadata_fetch::is_plausible_author_line(&author_line) {
        Some(author_line)
    } else {
        None
    }
}

pub fn extract_pdf_metadata(path: &std::path::Path) -> Option<crate::models::ParsedPdfMetadata> {
    let pdfium = GLOBAL_PDFIUM.get()?;
    let document = pdfium.0.load_pdf_from_file(path, None).ok()?;
    let document_lines = extract_document_lines(&document, 3);
    let searchable_text = document_lines.join("\n");
    let file_name_text = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(crate::metadata_fetch::clean_title_text);

    let metadata_title = document
        .metadata()
        .get(PdfDocumentMetadataTagType::Title)
        .map(|tag| crate::metadata_fetch::clean_title_text(tag.value()))
        .filter(|title| crate::metadata_fetch::is_plausible_title(title));

    let metadata_authors = document
        .metadata()
        .get(PdfDocumentMetadataTagType::Author)
        .map(|tag| crate::metadata_fetch::normalize_authors(tag.value()))
        .filter(|authors| crate::metadata_fetch::is_plausible_author_line(authors));

    let metadata_year = document
        .metadata()
        .get(PdfDocumentMetadataTagType::CreationDate)
        .and_then(|tag| crate::metadata_fetch::extract_year_from_text(tag.value()))
        .or_else(|| {
            document
                .metadata()
                .get(PdfDocumentMetadataTagType::ModificationDate)
                .and_then(|tag| crate::metadata_fetch::extract_year_from_text(tag.value()))
        });

    let inferred_title = metadata_title
        .clone()
        .or_else(|| infer_title_from_first_page(&document))
        .or_else(|| {
            file_name_text.filter(|title| crate::metadata_fetch::is_plausible_title(title))
        });
    let inferred_authors = metadata_authors
        .clone()
        .or_else(|| infer_authors_from_first_page(&document, inferred_title.as_deref()));

    let inferred_year = metadata_year.or_else(|| {
        inferred_title
            .as_deref()
            .and_then(crate::metadata_fetch::extract_year_from_text)
    });

    let inferred_abstract = crate::metadata_fetch::extract_abstract_from_lines(&document_lines);
    let inferred_doi =
        crate::metadata_fetch::extract_doi_from_text(&searchable_text).or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .and_then(crate::metadata_fetch::extract_doi_from_text)
        });
    let inferred_arxiv_id = crate::metadata_fetch::extract_arxiv_id_from_text(&searchable_text)
        .or_else(|| crate::metadata_fetch::extract_arxiv_id_from_filename(path));

    Some(crate::models::ParsedPdfMetadata {
        title: inferred_title,
        authors: inferred_authors,
        year: inferred_year,
        r#abstract: inferred_abstract,
        doi: inferred_doi,
        arxiv_id: inferred_arxiv_id,
        publication: None,
        volume: None,
        issue: None,
        pages: None,
        publisher: None,
        isbn: None,
        url: None,
        language: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{merge_text_fragments, TextFragment, TextNode};

    fn positioned_fragment(text: &str, x: f32, y: f32, width: f32, height: f32) -> TextFragment {
        TextFragment {
            text: text.to_string(),
            x: Some(x),
            y: Some(y),
            width: Some(width),
            height: Some(height),
        }
    }

    fn whitespace_fragment(text: &str) -> TextFragment {
        TextFragment {
            text: text.to_string(),
            x: None,
            y: None,
            width: None,
            height: None,
        }
    }

    #[test]
    fn merge_text_fragments_preserves_explicit_spaces() {
        let nodes = merge_text_fragments(vec![
            positioned_fragment("large", 10.0, 20.0, 30.0, 10.0),
            whitespace_fragment(" "),
            positioned_fragment("language", 50.0, 20.0, 45.0, 10.0),
            whitespace_fragment(" "),
            positioned_fragment("model", 100.0, 20.0, 28.0, 10.0),
        ]);

        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].text, "large language model");
    }

    #[test]
    fn merge_text_fragments_breaks_on_newlines() {
        let nodes = merge_text_fragments(vec![
            positioned_fragment("first", 10.0, 20.0, 20.0, 10.0),
            whitespace_fragment("\n"),
            positioned_fragment("second", 10.0, 40.0, 30.0, 10.0),
        ]);

        assert_eq!(
            nodes,
            vec![
                TextNode {
                    text: "first".to_string(),
                    x: 10.0,
                    y: 20.0,
                    width: 20.0,
                    height: 10.0,
                },
                TextNode {
                    text: "second".to_string(),
                    x: 10.0,
                    y: 40.0,
                    width: 30.0,
                    height: 10.0,
                },
            ]
        );
    }
}
