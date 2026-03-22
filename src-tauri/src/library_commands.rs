use crate::metadata_fetch::{
    enrich_metadata_with_remote_providers, normalize_arxiv_id, normalize_doi,
    refresh_item_metadata_in_db, strip_invalid_metadata_url,
};
/// Module: src-tauri/src/library_commands.rs
/// Purpose: Encapsulates all general file/directory manipulation commands.
/// Capabilities: Moving, renaming, deleting, parsing library structure, managing annotations cache sidecars.
use crate::models::{
    AiAnnotationDigest, AiAnnotationDigestStats, AiDigestEntry, AiDigestSection, AiPaperSummary,
    AiTranslationResult, CachedPdfMetadataRecord, LibraryItem, MetadataFetchReport, Note,
    ParsedPdfMetadata, SavedPdfAnnotationsDocument, SavedPdfPageAnnotations,
};
use crate::pdf_handlers::{extract_document_text_from_path, extract_pdf_metadata};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{Emitter, Manager};

pub const LIBRARY_ITEM_METADATA_UPDATED_EVENT: &str = "library-item-metadata-updated";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryItemMetadataUpdatedPayload {
    item_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifierImportResult {
    item: LibraryItem,
    created: bool,
    matched_by: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceImportResult {
    items: Vec<LibraryItem>,
    created_count: usize,
    existing_count: usize,
    source_format: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeDuplicateItemsResult {
    item: LibraryItem,
    survivor_item_id: String,
    merged_item_ids: Vec<String>,
}

#[derive(Clone)]
struct DigestCandidate {
    page: u16,
    text: String,
    category: &'static str,
    reason: &'static str,
}

#[derive(Default)]
struct ParsedReferenceItem {
    item_type: String,
    title: String,
    authors: String,
    year: String,
    abstract_text: String,
    doi: String,
    arxiv_id: String,
    publication: String,
    volume: String,
    issue: String,
    pages: String,
    publisher: String,
    isbn: String,
    url: String,
    language: String,
    tags: Vec<String>,
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatCompletionChoice>,
}

#[derive(Deserialize)]
struct ChatCompletionChoice {
    message: ChatCompletionMessage,
}

#[derive(Deserialize)]
struct ChatCompletionMessage {
    content: serde_json::Value,
}

#[derive(Clone)]
struct BingWebAuthState {
    ig: String,
    iid: String,
    key: String,
    token: String,
    expires_at: Instant,
}

#[derive(Deserialize)]
struct BingWebDetectedLanguage {
    language: String,
}

#[derive(Deserialize)]
struct BingWebTranslation {
    text: String,
}

#[derive(Deserialize)]
struct BingWebTranslateResponseItem {
    #[serde(rename = "detectedLanguage")]
    detected_language: Option<BingWebDetectedLanguage>,
    translations: Vec<BingWebTranslation>,
}

#[derive(Deserialize)]
struct BingWebTranslateErrorResponse {
    #[serde(rename = "statusCode")]
    status_code: Option<i64>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct CachedPaperSummaryRecord {
    file_size: u64,
    modified_unix_ms: u64,
    summary: AiPaperSummary,
    updated_at: String,
}

static BING_WEB_AUTH_CACHE: OnceLock<Mutex<Option<BingWebAuthState>>> = OnceLock::new();
const BING_WEB_TRANSLATOR_URL: &str = "https://www.bing.com/translator";
const BING_WEB_TRANSLATE_ENDPOINT: &str = "https://www.bing.com/ttranslatev3";
const BING_WEB_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0";

pub fn library_root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {:?}", e))?
        .join("library");

    fs::create_dir_all(&root).map_err(|e| format!("Failed to create library root: {}", e))?;

    Ok(root)
}

pub fn trash_root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {:?}", e))?
        .join("trash");

    fs::create_dir_all(&root).map_err(|e| format!("Failed to create trash root: {}", e))?;

    Ok(root)
}

pub fn is_pdf_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

pub fn unique_directory_path(parent: &Path, desired_name: &str) -> PathBuf {
    let mut candidate = parent.join(desired_name);
    if !candidate.exists() {
        return candidate;
    }

    let mut index = 1;
    loop {
        candidate = parent.join(format!("{} {}", desired_name, index));
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

pub fn unique_file_path(parent: &Path, file_name: &str) -> PathBuf {
    let file_path = Path::new(file_name);
    let stem = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("pdf");

    let mut candidate = parent.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let mut index = 1;
    loop {
        candidate = parent.join(format!("{} ({}){}.{}", stem, index, "", extension));
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

pub fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => ' ',
            _ => ch,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', '.'])
        .to_string()
}

fn now_unix_timestamp_string() -> String {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn file_timestamp_string(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let system_time = metadata
        .created()
        .ok()
        .or_else(|| metadata.modified().ok())?;
    let timestamp = system_time.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(timestamp.to_string())
}

fn fallback_item_timestamp(path: &Path) -> String {
    file_timestamp_string(path).unwrap_or_else(now_unix_timestamp_string)
}

fn has_meaningful_metadata(meta: &ParsedPdfMetadata) -> bool {
    [
        meta.title.as_deref(),
        meta.authors.as_deref(),
        meta.year.as_deref(),
        meta.r#abstract.as_deref(),
        meta.doi.as_deref(),
        meta.arxiv_id.as_deref(),
        meta.publication.as_deref(),
        meta.url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| !value.trim().is_empty())
}

pub fn is_path_within(base: &Path, candidate: &Path) -> bool {
    candidate == base || candidate.starts_with(base)
}

pub fn metadata_cache_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.pdf");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".{}.Lume-meta.json", file_name))
}

pub fn annotation_sidecar_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.pdf");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".{}.Lume-annotations.json", file_name))
}

pub fn file_signature(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let modified_unix_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;

    Some((metadata.len(), modified_unix_ms))
}

pub fn read_cached_pdf_metadata(path: &Path) -> Option<CachedPdfMetadataRecord> {
    let cache_path = metadata_cache_path(path);
    let content = fs::read_to_string(cache_path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn write_cached_pdf_metadata(path: &Path, record: &CachedPdfMetadataRecord) {
    let cache_path = metadata_cache_path(path);
    if let Ok(content) = serde_json::to_string_pretty(record) {
        let _ = fs::write(cache_path, content);
    }
}

pub fn remove_cached_pdf_metadata(path: &Path) {
    let _ = fs::remove_file(metadata_cache_path(path));
}

pub fn rename_cached_pdf_metadata(old_path: &Path, new_path: &Path) {
    let old_cache = metadata_cache_path(old_path);
    let new_cache = metadata_cache_path(new_path);
    if old_cache == new_cache || !old_cache.exists() {
        return;
    }

    let _ = fs::rename(old_cache, new_cache);
}

pub fn read_annotation_sidecar(path: &Path) -> Option<SavedPdfAnnotationsDocument> {
    let sidecar_path = annotation_sidecar_path(path);
    let content = fs::read_to_string(sidecar_path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn write_annotation_sidecar(
    path: &Path,
    document: &SavedPdfAnnotationsDocument,
) -> Result<(), String> {
    let sidecar_path = annotation_sidecar_path(path);
    let content = serde_json::to_string_pretty(document)
        .map_err(|e| format!("Failed to serialize annotations: {}", e))?;
    fs::write(sidecar_path, content).map_err(|e| format!("Failed to write annotations: {}", e))
}

pub fn remove_annotation_sidecar(path: &Path) {
    let _ = fs::remove_file(annotation_sidecar_path(path));
}

pub fn rename_annotation_sidecar(old_path: &Path, new_path: &Path) {
    let old_sidecar = annotation_sidecar_path(old_path);
    let new_sidecar = annotation_sidecar_path(new_path);

    if old_sidecar == new_sidecar || !old_sidecar.exists() {
        return;
    }

    let _ = fs::rename(old_sidecar, new_sidecar);
}

pub fn copy_annotation_sidecar(source_path: &Path, target_path: &Path) {
    let source_sidecar = annotation_sidecar_path(source_path);
    let target_sidecar = annotation_sidecar_path(target_path);

    if !source_sidecar.exists() || source_sidecar == target_sidecar {
        return;
    }

    let _ = fs::copy(source_sidecar, target_sidecar);
}

pub fn should_try_remote_metadata(meta: &ParsedPdfMetadata) -> bool {
    meta.doi.is_some() || meta.arxiv_id.is_some() || meta.title.is_some()
}

pub struct ResolvedPdfMetadata {
    pub meta: ParsedPdfMetadata,
    pub report: MetadataFetchReport,
}

pub fn resolve_pdf_metadata_with_report(path: &Path) -> ResolvedPdfMetadata {
    let local = extract_pdf_metadata(path).unwrap_or_default();
    let Some((file_size, modified_unix_ms)) = file_signature(path) else {
        return ResolvedPdfMetadata {
            meta: local,
            report: MetadataFetchReport::default(),
        };
    };

    if let Some(cached) = read_cached_pdf_metadata(path) {
        if cached.file_size == file_size
            && cached.modified_unix_ms == modified_unix_ms
            && cached.network_complete
        {
            return ResolvedPdfMetadata {
                meta: cached.meta,
                report: cached.report.unwrap_or_default(),
            };
        }
    }

    let mut resolved = local.clone();
    let mut network_complete = true;
    let mut report = MetadataFetchReport::default();

    if should_try_remote_metadata(&resolved) {
        let enriched = enrich_metadata_with_remote_providers(&resolved);
        resolved = enriched.meta;
        network_complete = enriched.network_complete;
        report = enriched.report;
    }

    if let Err(error) = strip_invalid_metadata_url(&mut resolved) {
        eprintln!("Failed to validate metadata URL: {}", error);
        network_complete = false;
    }

    report.network_complete = network_complete;

    write_cached_pdf_metadata(
        path,
        &CachedPdfMetadataRecord {
            file_size,
            modified_unix_ms,
            network_complete,
            meta: resolved.clone(),
            report: Some(report.clone()),
        },
    );

    ResolvedPdfMetadata {
        meta: resolved,
        report,
    }
}

pub fn resolve_pdf_metadata(path: &Path) -> ParsedPdfMetadata {
    resolve_pdf_metadata_with_report(path).meta
}

#[tauri::command]
pub fn get_item_metadata_fetch_report(
    item_id: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Option<MetadataFetchReport>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;

    let item = fetch_item_from_db(&conn, &item_id)
        .map_err(|e| format!("Failed to load item: {}", e))?
        .ok_or("Item not found".to_string())?;

    let pdf_path = item
        .attachments
        .iter()
        .find(|attachment| attachment.attachment_type.eq_ignore_ascii_case("PDF"))
        .map(|attachment| attachment.path.clone())
        .unwrap_or_else(|| item.id.clone());

    let path = PathBuf::from(pdf_path);
    let Some((file_size, modified_unix_ms)) = file_signature(&path) else {
        return Ok(None);
    };

    Ok(read_cached_pdf_metadata(&path)
        .filter(|cached| {
            cached.file_size == file_size && cached.modified_unix_ms == modified_unix_ms
        })
        .and_then(|cached| cached.report))
}

pub fn build_library_item(path: &Path) -> LibraryItem {
    let parsed = resolve_pdf_metadata(path);
    build_library_item_from_parsed_metadata(path, parsed)
}

fn build_library_item_from_parsed_metadata(path: &Path, parsed: ParsedPdfMetadata) -> LibraryItem {
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled")
        .to_string();
    let path_str = path.to_string_lossy().to_string();
    let title = parsed.title.clone().unwrap_or_else(|| name.clone());
    let authors = parsed.authors.clone().unwrap_or_else(|| "—".to_string());
    let year = parsed.year.clone().unwrap_or_else(|| "—".to_string());
    let abstract_text = parsed.r#abstract.clone().unwrap_or_default();
    let doi = parsed.doi.clone().unwrap_or_default();
    let arxiv_id = parsed.arxiv_id.clone().unwrap_or_default();
    let publication = parsed.publication.clone().unwrap_or_default();
    let volume = parsed.volume.clone().unwrap_or_default();
    let issue = parsed.issue.clone().unwrap_or_default();
    let pages = parsed.pages.clone().unwrap_or_default();
    let publisher = parsed.publisher.clone().unwrap_or_default();
    let isbn = parsed.isbn.clone().unwrap_or_default();
    let url = parsed.url.clone().unwrap_or_default();
    let language = parsed.language.clone().unwrap_or_default();

    let attachment = crate::models::LibraryAttachment {
        id: format!("att-{}", path_str),
        item_id: path_str.clone(),
        name: name.clone(),
        path: path_str.clone(),
        attachment_type: "PDF".to_string(),
    };

    let timestamp = fallback_item_timestamp(path);

    LibraryItem {
        id: path_str.clone(),
        item_type: "Journal Article".to_string(),
        title,
        authors,
        year,
        r#abstract: abstract_text,
        doi,
        arxiv_id,
        publication,
        volume,
        issue,
        pages,
        publisher,
        isbn,
        url,
        language,
        date_added: timestamp.clone(),
        date_modified: timestamp,
        folder_path: String::new(),
        tags: Vec::new(),
        attachments: vec![attachment],
    }
}

fn build_remote_library_item(
    folder_path: &str,
    original_identifier: &str,
    parsed: ParsedPdfMetadata,
) -> LibraryItem {
    let normalized_doi = parsed.doi.as_deref().and_then(normalize_doi);
    let normalized_arxiv = parsed.arxiv_id.as_deref().and_then(normalize_arxiv_id);
    let identifier = normalized_doi
        .clone()
        .map(|value| format!("doi:{}", value))
        .or_else(|| normalized_arxiv.clone().map(|value| format!("arxiv:{}", value)))
        .unwrap_or_else(|| {
            format!(
                "remote:{}:{}",
                now_unix_timestamp_string(),
                sanitize_file_name(original_identifier)
            )
        });

    let title = parsed
        .title
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| original_identifier.trim().to_string());
    let authors = parsed
        .authors
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "—".to_string());
    let year = parsed
        .year
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "—".to_string());
    let timestamp = now_unix_timestamp_string();

    LibraryItem {
        id: identifier,
        item_type: "Journal Article".to_string(),
        title,
        authors,
        year,
        r#abstract: parsed.r#abstract.unwrap_or_default(),
        doi: normalized_doi.unwrap_or_default(),
        arxiv_id: normalized_arxiv.unwrap_or_default(),
        publication: parsed.publication.unwrap_or_default(),
        volume: parsed.volume.unwrap_or_default(),
        issue: parsed.issue.unwrap_or_default(),
        pages: parsed.pages.unwrap_or_default(),
        publisher: parsed.publisher.unwrap_or_default(),
        isbn: parsed.isbn.unwrap_or_default(),
        url: parsed.url.unwrap_or_default(),
        language: parsed.language.unwrap_or_default(),
        date_added: timestamp.clone(),
        date_modified: timestamp,
        folder_path: folder_path.to_string(),
        tags: Vec::new(),
        attachments: Vec::new(),
    }
}

fn normalize_reference_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }

        let key = trimmed.to_lowercase();
        if seen.insert(key) {
            normalized.push(trimmed.to_string());
        }
    }

    normalized
}

fn replace_item_tags_in_db(
    conn: &rusqlite::Connection,
    item_id: &str,
    tags: &[String],
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM item_tags WHERE item_id = ?1",
        rusqlite::params![item_id],
    )
    .map_err(|error| format!("Failed to clear item tags: {}", error))?;

    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }

        conn.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?1, ?2)",
            rusqlite::params![item_id, trimmed],
        )
        .map_err(|error| format!("Failed to insert item tag: {}", error))?;
        ensure_tag_color_for_tag(conn, trimmed)?;
    }

    Ok(())
}

fn split_reference_keywords(raw: &str) -> Vec<String> {
    raw.split(|ch| matches!(ch, ';' | ',' | '\n'))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize_reference_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_wrapping_delimiters(raw: &str) -> String {
    let mut value = raw.trim().to_string();

    loop {
        let trimmed = value.trim();
        let next = if trimmed.starts_with('{') && trimmed.ends_with('}') && trimmed.len() >= 2 {
            Some(trimmed[1..trimmed.len() - 1].to_string())
        } else if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
            Some(trimmed[1..trimmed.len() - 1].to_string())
        } else {
            None
        };

        let Some(candidate) = next else {
            return normalize_reference_whitespace(trimmed);
        };

        value = candidate;
    }
}

fn split_top_level_csv(raw: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut brace_depth = 0i32;
    let mut paren_depth = 0i32;
    let mut in_quotes = false;
    let mut escaped = false;

    for ch in raw.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        if ch == '\\' {
            current.push(ch);
            escaped = true;
            continue;
        }

        if ch == '"' {
            in_quotes = !in_quotes;
            current.push(ch);
            continue;
        }

        if !in_quotes {
            match ch {
                '{' => brace_depth += 1,
                '}' => brace_depth -= 1,
                '(' => paren_depth += 1,
                ')' => paren_depth -= 1,
                ',' if brace_depth == 0 && paren_depth == 0 => {
                    let trimmed = current.trim();
                    if !trimmed.is_empty() {
                        parts.push(trimmed.to_string());
                    }
                    current.clear();
                    continue;
                }
                _ => {}
            }
        }

        current.push(ch);
    }

    let trimmed = current.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }

    parts
}

fn map_bibtex_item_type(entry_type: &str) -> String {
    match entry_type.trim().to_lowercase().as_str() {
        "book" => "Book".to_string(),
        "inproceedings" | "conference" | "proceedings" => "Conference Paper".to_string(),
        "phdthesis" | "mastersthesis" => "Thesis".to_string(),
        "techreport" => "Report".to_string(),
        _ => "Journal Article".to_string(),
    }
}

fn parse_bibtex_references(content: &str) -> Result<Vec<ParsedReferenceItem>, String> {
    let chars = content.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    let mut items = Vec::new();

    while index < chars.len() {
        if chars[index] != '@' {
            index += 1;
            continue;
        }

        index += 1;
        let entry_type_start = index;
        while index < chars.len() && chars[index].is_ascii_alphabetic() {
            index += 1;
        }

        let entry_type = chars[entry_type_start..index]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }

        if index >= chars.len() || !matches!(chars[index], '{' | '(') {
            return Err("Invalid BibTeX entry".to_string());
        }

        let opening = chars[index];
        let closing = if opening == '{' { '}' } else { ')' };
        let body_start = index + 1;
        let mut brace_depth = if opening == '{' { 1i32 } else { 0i32 };
        let mut paren_depth = if opening == '(' { 1i32 } else { 0i32 };
        let mut in_quotes = false;
        let mut escaped = false;
        index += 1;

        while index < chars.len() {
            let ch = chars[index];
            if escaped {
                escaped = false;
                index += 1;
                continue;
            }

            if ch == '\\' {
                escaped = true;
                index += 1;
                continue;
            }

            if ch == '"' {
                in_quotes = !in_quotes;
                index += 1;
                continue;
            }

            if !in_quotes {
                if ch == '{' {
                    brace_depth += 1;
                } else if ch == '}' {
                    brace_depth -= 1;
                    if opening == '{' && brace_depth == 0 {
                        break;
                    }
                } else if ch == '(' {
                    paren_depth += 1;
                } else if ch == ')' {
                    paren_depth -= 1;
                    if opening == '(' && paren_depth == 0 {
                        break;
                    }
                }
            }

            index += 1;
        }

        if index >= chars.len() || chars[index] != closing {
            return Err("Unterminated BibTeX entry".to_string());
        }

        let body = chars[body_start..index].iter().collect::<String>();
        index += 1;

        let parts = split_top_level_csv(&body);
        if parts.len() < 2 {
            continue;
        }

        let mut item = ParsedReferenceItem {
            item_type: map_bibtex_item_type(&entry_type),
            ..ParsedReferenceItem::default()
        };

        for field in parts.iter().skip(1) {
            let Some((name, raw_value)) = field.split_once('=') else {
                continue;
            };
            let key = name.trim().to_lowercase();
            let value = strip_wrapping_delimiters(raw_value);

            match key.as_str() {
                "title" => item.title = value,
                "author" => item.authors = value.replace(" and ", ", "),
                "year" => item.year = value.chars().take(4).collect(),
                "abstract" => item.abstract_text = value,
                "doi" => item.doi = value,
                "journal" | "booktitle" => item.publication = value,
                "volume" => item.volume = value,
                "number" => item.issue = value,
                "pages" => item.pages = value.replace("--", "-"),
                "publisher" => item.publisher = value,
                "isbn" => item.isbn = value,
                "url" => item.url = value,
                "language" => item.language = value,
                "keywords" => item.tags.extend(split_reference_keywords(&value)),
                "eprint" | "arxiv" => {
                    if item.arxiv_id.is_empty() {
                        item.arxiv_id = value;
                    }
                }
                "eprinttype" | "archiveprefix" => {}
                _ => {}
            }
        }

        item.tags = normalize_reference_tags(item.tags);
        if !item.title.trim().is_empty() {
            items.push(item);
        }
    }

    if items.is_empty() {
        return Err("No BibTeX references were found".to_string());
    }

    Ok(items)
}

fn map_ris_item_type(value: &str) -> String {
    match value.trim().to_uppercase().as_str() {
        "BOOK" | "EBOOK" => "Book".to_string(),
        "THES" => "Thesis".to_string(),
        "RPRT" | "REPORT" => "Report".to_string(),
        "CONF" | "CPAPER" | "CHAP" => "Conference Paper".to_string(),
        _ => "Journal Article".to_string(),
    }
}

fn parse_ris_references(content: &str) -> Result<Vec<ParsedReferenceItem>, String> {
    let mut items = Vec::new();
    let mut current = ParsedReferenceItem::default();
    let mut authors = Vec::new();
    let mut keywords = Vec::new();
    let mut start_page = String::new();
    let mut end_page = String::new();
    let mut last_tag: Option<String> = None;

    let finalize_entry = |items: &mut Vec<ParsedReferenceItem>,
                          current: &mut ParsedReferenceItem,
                          authors: &mut Vec<String>,
                          keywords: &mut Vec<String>,
                          start_page: &mut String,
                          end_page: &mut String| {
        if current.title.trim().is_empty() {
            *current = ParsedReferenceItem::default();
            authors.clear();
            keywords.clear();
            start_page.clear();
            end_page.clear();
            return;
        }

        current.authors = authors.join(", ");
        current.tags = normalize_reference_tags(std::mem::take(keywords));
        current.pages = if !start_page.is_empty() && !end_page.is_empty() {
            format!("{}-{}", start_page.trim(), end_page.trim())
        } else if !start_page.is_empty() {
            start_page.trim().to_string()
        } else {
            current.pages.trim().to_string()
        };
        items.push(std::mem::take(current));
        authors.clear();
        start_page.clear();
        end_page.clear();
    };

    for raw_line in content.lines() {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            continue;
        }

        let trimmed_start = raw_line.trim_start();
        if raw_line.starts_with(' ') || raw_line.starts_with('\t') {
            if let Some(tag) = &last_tag {
                let extra = normalize_reference_whitespace(trimmed_start);
                if extra.is_empty() {
                    continue;
                }

                match tag.as_str() {
                    "AB" | "N2" => {
                        current.abstract_text = format!("{} {}", current.abstract_text, extra)
                            .trim()
                            .to_string();
                    }
                    "TI" | "T1" => {
                        current.title = format!("{} {}", current.title, extra).trim().to_string();
                    }
                    "JO" | "JF" | "T2" => {
                        current.publication =
                            format!("{} {}", current.publication, extra).trim().to_string();
                    }
                    "KW" => keywords.push(extra),
                    _ => {}
                }
            }
            continue;
        }

        let Some((tag, raw_value)) = line.split_once(" - ") else {
            continue;
        };
        let key = tag.trim().to_uppercase();
        let value = normalize_reference_whitespace(raw_value);
        last_tag = Some(key.clone());

        match key.as_str() {
            "TY" => current.item_type = map_ris_item_type(&value),
            "TI" | "T1" if current.title.is_empty() => current.title = value,
            "AU" | "A1" => authors.push(value),
            "PY" | "Y1" | "DA" if current.year.is_empty() => {
                current.year = value.chars().filter(|ch| ch.is_ascii_digit()).take(4).collect();
            }
            "JO" | "JF" | "T2" if current.publication.is_empty() => current.publication = value,
            "VL" => current.volume = value,
            "IS" => current.issue = value,
            "SP" => start_page = value,
            "EP" => end_page = value,
            "PB" => current.publisher = value,
            "DO" => current.doi = value,
            "UR" | "L1" => current.url = value,
            "AB" | "N2" => current.abstract_text = value,
            "KW" => keywords.push(value),
            "LA" => current.language = value,
            "SN" => current.isbn = value,
            "M1" => current.arxiv_id = value,
            "ER" => finalize_entry(
                &mut items,
                &mut current,
                &mut authors,
                &mut keywords,
                &mut start_page,
                &mut end_page,
            ),
            _ => {}
        }
    }

    finalize_entry(
        &mut items,
        &mut current,
        &mut authors,
        &mut keywords,
        &mut start_page,
        &mut end_page,
    );

    if items.is_empty() {
        return Err("No RIS references were found".to_string());
    }

    Ok(items)
}

fn json_value_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(inner) => {
            let trimmed = inner.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::Bool(boolean) => Some(boolean.to_string()),
        serde_json::Value::Array(values) => values.iter().find_map(json_value_to_string),
        _ => None,
    }
}

fn extract_csljson_year(value: &serde_json::Value) -> String {
    if let Some(date_parts) = value.get("date-parts").and_then(|entry| entry.as_array()) {
        for part in date_parts {
            if let Some(year) = part
                .as_array()
                .and_then(|values| values.first())
                .and_then(json_value_to_string)
            {
                let digits = year.chars().filter(|ch| ch.is_ascii_digit()).take(4).collect::<String>();
                if !digits.is_empty() {
                    return digits;
                }
            }
        }
    }

    json_value_to_string(value)
        .map(|raw| raw.chars().filter(|ch| ch.is_ascii_digit()).take(4).collect())
        .unwrap_or_default()
}

fn parse_csljson_author_list(value: &serde_json::Value) -> String {
    let Some(authors) = value.as_array() else {
        return String::new();
    };

    authors
        .iter()
        .filter_map(|entry| {
            if let Some(literal) = entry.get("literal").and_then(json_value_to_string) {
                return Some(literal);
            }

            let family = entry.get("family").and_then(json_value_to_string).unwrap_or_default();
            let given = entry.get("given").and_then(json_value_to_string).unwrap_or_default();
            let full_name = [family, given]
                .into_iter()
                .filter(|value| !value.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if full_name.trim().is_empty() {
                None
            } else {
                Some(full_name)
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn map_csljson_item_type(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "book" => "Book".to_string(),
        "chapter" | "paper-conference" => "Conference Paper".to_string(),
        "thesis" => "Thesis".to_string(),
        "report" => "Report".to_string(),
        _ => "Journal Article".to_string(),
    }
}

fn infer_arxiv_id_from_text(value: &str) -> String {
    normalize_arxiv_id(value).unwrap_or_default()
}

fn parse_csljson_references(content: &str) -> Result<Vec<ParsedReferenceItem>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(content).map_err(|error| format!("Invalid CSL JSON: {}", error))?;
    let entries = if let Some(array) = parsed.as_array() {
        array.iter().collect::<Vec<_>>()
    } else if parsed.is_object() {
        vec![&parsed]
    } else {
        return Err("CSL JSON must be an object or array".to_string());
    };

    let mut items = Vec::new();

    for entry in entries {
        let mut item = ParsedReferenceItem {
            item_type: entry
                .get("type")
                .and_then(json_value_to_string)
                .map(|value| map_csljson_item_type(&value))
                .unwrap_or_else(|| "Journal Article".to_string()),
            title: entry.get("title").and_then(json_value_to_string).unwrap_or_default(),
            authors: entry
                .get("author")
                .map(parse_csljson_author_list)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_default(),
            year: entry
                .get("issued")
                .map(extract_csljson_year)
                .or_else(|| entry.get("created").map(extract_csljson_year))
                .unwrap_or_default(),
            abstract_text: entry.get("abstract").and_then(json_value_to_string).unwrap_or_default(),
            doi: entry.get("DOI").and_then(json_value_to_string).unwrap_or_default(),
            arxiv_id: String::new(),
            publication: entry
                .get("container-title")
                .and_then(json_value_to_string)
                .unwrap_or_default(),
            volume: entry.get("volume").and_then(json_value_to_string).unwrap_or_default(),
            issue: entry.get("issue").and_then(json_value_to_string).unwrap_or_default(),
            pages: entry.get("page").and_then(json_value_to_string).unwrap_or_default(),
            publisher: entry.get("publisher").and_then(json_value_to_string).unwrap_or_default(),
            isbn: entry.get("ISBN").and_then(json_value_to_string).unwrap_or_default(),
            url: entry.get("URL").and_then(json_value_to_string).unwrap_or_default(),
            language: entry.get("language").and_then(json_value_to_string).unwrap_or_default(),
            tags: entry
                .get("keyword")
                .and_then(json_value_to_string)
                .map(|value| split_reference_keywords(&value))
                .unwrap_or_default(),
        };

        if item.title.trim().is_empty() {
            continue;
        }

        if !item.url.is_empty() {
            item.arxiv_id = infer_arxiv_id_from_text(&item.url);
        }
        if item.arxiv_id.is_empty() {
            item.arxiv_id = entry
                .get("id")
                .and_then(json_value_to_string)
                .map(|value| infer_arxiv_id_from_text(&value))
                .unwrap_or_default();
        }

        item.tags = normalize_reference_tags(item.tags);
        items.push(item);
    }

    if items.is_empty() {
        return Err("No CSL JSON references were found".to_string());
    }

    Ok(items)
}

fn detect_reference_import_format(path: &Path, content: &str) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase());

    match extension.as_deref() {
        Some("bib") | Some("bibtex") => Ok("bibtex"),
        Some("ris") => Ok("ris"),
        Some("json") => Ok("csljson"),
        _ => {
            let trimmed = content.trim_start();
            if trimmed.starts_with('@') {
                Ok("bibtex")
            } else if trimmed.starts_with("TY  -") {
                Ok("ris")
            } else if trimmed.starts_with('{') || trimmed.starts_with('[') {
                Ok("csljson")
            } else {
                Err("Unsupported reference file format".to_string())
            }
        }
    }
}

fn build_reference_library_item(
    folder_path: &str,
    seed_label: &str,
    parsed: ParsedReferenceItem,
    sequence: usize,
) -> LibraryItem {
    let normalized_doi = normalize_doi(&parsed.doi);
    let normalized_arxiv = normalize_arxiv_id(&parsed.arxiv_id)
        .or_else(|| normalize_arxiv_id(&parsed.url));
    let timestamp = now_unix_timestamp_string();
    let identifier = normalized_doi
        .clone()
        .map(|value| format!("doi:{}", value))
        .or_else(|| normalized_arxiv.clone().map(|value| format!("arxiv:{}", value)))
        .unwrap_or_else(|| {
            format!(
                "ref:{}:{}:{}",
                timestamp,
                sequence,
                sanitize_file_name(seed_label)
            )
        });

    LibraryItem {
        id: identifier,
        item_type: if parsed.item_type.trim().is_empty() {
            "Journal Article".to_string()
        } else {
            parsed.item_type
        },
        title: if parsed.title.trim().is_empty() {
            seed_label.trim().to_string()
        } else {
            parsed.title
        },
        authors: if parsed.authors.trim().is_empty() {
            "—".to_string()
        } else {
            parsed.authors
        },
        year: if parsed.year.trim().is_empty() {
            "—".to_string()
        } else {
            parsed.year
        },
        r#abstract: parsed.abstract_text,
        doi: normalized_doi.unwrap_or_default(),
        arxiv_id: normalized_arxiv.unwrap_or_default(),
        publication: parsed.publication,
        volume: parsed.volume,
        issue: parsed.issue,
        pages: parsed.pages,
        publisher: parsed.publisher,
        isbn: parsed.isbn,
        url: parsed.url,
        language: parsed.language,
        date_added: timestamp.clone(),
        date_modified: timestamp,
        folder_path: folder_path.to_string(),
        tags: normalize_reference_tags(parsed.tags),
        attachments: Vec::new(),
    }
}

fn spawn_import_metadata_refresh(
    app: tauri::AppHandle,
    db: std::sync::Arc<Mutex<rusqlite::Connection>>,
    item_id: String,
) {
    thread::spawn(move || {
        match refresh_item_metadata_in_db(&db, &item_id) {
            Ok(_) => {
                if let Err(error) = app.emit(
                    LIBRARY_ITEM_METADATA_UPDATED_EVENT,
                    LibraryItemMetadataUpdatedPayload {
                        item_id: item_id.clone(),
                    },
                ) {
                    eprintln!("Failed to emit metadata update event: {}", error);
                }
            }
            Err(error) => {
                eprintln!(
                    "Background metadata refresh failed for imported item {}: {}",
                    item_id, error
                );
            }
        }
    });
}

pub fn fetch_item_from_db(
    conn: &rusqlite::Connection,
    id: &str,
) -> rusqlite::Result<Option<LibraryItem>> {
    let mut stmt = conn.prepare("SELECT id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path FROM items WHERE id = ?1")?;
    let mut item_iter = stmt.query_map(rusqlite::params![id], |row| {
        Ok(LibraryItem {
            id: row.get(0)?,
            item_type: row.get(1)?,
            title: row.get(2)?,
            authors: row.get(3)?,
            year: row.get(4)?,
            r#abstract: row.get(5)?,
            doi: row.get(6)?,
            arxiv_id: row.get(7)?,
            publication: row.get(8)?,
            volume: row.get(9)?,
            issue: row.get(10)?,
            pages: row.get(11)?,
            publisher: row.get(12)?,
            isbn: row.get(13)?,
            url: row.get(14)?,
            language: row.get(15)?,
            date_added: row.get(16)?,
            date_modified: row.get(17)?,
            folder_path: row.get(18)?,
            tags: Vec::new(),
            attachments: Vec::new(),
        })
    })?;

    if let Some(item_res) = item_iter.next() {
        let mut item = item_res?;
        let mut att_stmt = conn.prepare(
            "SELECT id, item_id, name, path, attachment_type FROM attachments WHERE item_id = ?1",
        )?;
        let att_iter = att_stmt.query_map(rusqlite::params![id], |row| {
            Ok(crate::models::LibraryAttachment {
                id: row.get(0)?,
                item_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                attachment_type: row.get(4)?,
            })
        })?;
        let mut attachments = Vec::new();
        for att in att_iter {
            attachments.push(att?);
        }
        item.attachments = attachments;
        Ok(Some(item))
    } else {
        Ok(None)
    }
}

pub fn fetch_all_items_from_db(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<LibraryItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path
         FROM items
         WHERE COALESCE(is_trashed, 0) = 0
         ORDER BY LOWER(title) ASC, LOWER(authors) ASC, LOWER(id) ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(LibraryItem {
            id: row.get(0)?,
            item_type: row.get(1)?,
            title: row.get(2)?,
            authors: row.get(3)?,
            year: row.get(4)?,
            r#abstract: row.get(5)?,
            doi: row.get(6)?,
            arxiv_id: row.get(7)?,
            publication: row.get(8)?,
            volume: row.get(9)?,
            issue: row.get(10)?,
            pages: row.get(11)?,
            publisher: row.get(12)?,
            isbn: row.get(13)?,
            url: row.get(14)?,
            language: row.get(15)?,
            date_added: row.get(16)?,
            date_modified: row.get(17)?,
            folder_path: row.get(18)?,
            tags: Vec::new(),
            attachments: Vec::new(),
        })
    })?;

    let mut items = Vec::new();

    for row in rows {
        let mut item = row?;
        item.tags = fetch_item_tags(conn, &item.id);

        let mut att_stmt = conn.prepare(
            "SELECT id, item_id, name, path, attachment_type FROM attachments WHERE item_id = ?1",
        )?;
        let att_iter = att_stmt.query_map(rusqlite::params![&item.id], |row| {
            Ok(crate::models::LibraryAttachment {
                id: row.get(0)?,
                item_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                attachment_type: row.get(4)?,
            })
        })?;

        item.attachments = att_iter.filter_map(|result| result.ok()).collect();
        items.push(item);
    }

    Ok(items)
}

fn fetch_items_for_folder_from_db(
    conn: &rusqlite::Connection,
    folder_path: &str,
) -> rusqlite::Result<Vec<LibraryItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path
         FROM items
         WHERE COALESCE(is_trashed, 0) = 0 AND folder_path = ?1
         ORDER BY LOWER(title) ASC, LOWER(id) ASC",
    )?;

    let rows = stmt.query_map(rusqlite::params![folder_path], |row| {
        Ok(LibraryItem {
            id: row.get(0)?,
            item_type: row.get(1)?,
            title: row.get(2)?,
            authors: row.get(3)?,
            year: row.get(4)?,
            r#abstract: row.get(5)?,
            doi: row.get(6)?,
            arxiv_id: row.get(7)?,
            publication: row.get(8)?,
            volume: row.get(9)?,
            issue: row.get(10)?,
            pages: row.get(11)?,
            publisher: row.get(12)?,
            isbn: row.get(13)?,
            url: row.get(14)?,
            language: row.get(15)?,
            date_added: row.get(16)?,
            date_modified: row.get(17)?,
            folder_path: row.get(18)?,
            tags: Vec::new(),
            attachments: Vec::new(),
        })
    })?;

    let mut items = Vec::new();
    for row in rows {
        let mut item = row?;
        item.tags = fetch_item_tags(conn, &item.id);

        let mut att_stmt = conn.prepare(
            "SELECT id, item_id, name, path, attachment_type FROM attachments WHERE item_id = ?1",
        )?;
        let att_iter = att_stmt.query_map(rusqlite::params![&item.id], |row| {
            Ok(crate::models::LibraryAttachment {
                id: row.get(0)?,
                item_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                attachment_type: row.get(4)?,
            })
        })?;

        item.attachments = att_iter.filter_map(|result| result.ok()).collect();
        items.push(item);
    }

    Ok(items)
}

fn fetch_existing_item_by_identifier(
    conn: &rusqlite::Connection,
    doi: Option<&str>,
    arxiv_id: Option<&str>,
) -> Result<Option<(LibraryItem, String)>, String> {
    if let Some(value) = doi {
        if let Some(item_id) = conn
            .query_row(
                "SELECT id FROM items WHERE COALESCE(is_trashed, 0) = 0 AND LOWER(doi) = ?1 LIMIT 1",
                rusqlite::params![value.to_lowercase()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("Failed to search DOI duplicates: {}", e))?
        {
            if let Some(item) = fetch_item_from_db(conn, &item_id)
                .map_err(|e| format!("Failed to load duplicate item: {}", e))?
            {
                return Ok(Some((item, "doi".to_string())));
            }
        }
    }

    if let Some(value) = arxiv_id {
        if let Some(item_id) = conn
            .query_row(
                "SELECT id FROM items WHERE COALESCE(is_trashed, 0) = 0 AND LOWER(arxiv_id) = ?1 LIMIT 1",
                rusqlite::params![value.to_lowercase()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("Failed to search arXiv duplicates: {}", e))?
        {
            if let Some(item) = fetch_item_from_db(conn, &item_id)
                .map_err(|e| format!("Failed to load duplicate item: {}", e))?
            {
                return Ok(Some((item, "arxiv".to_string())));
            }
        }
    }

    Ok(None)
}

pub fn sync_item_to_db(conn: &rusqlite::Connection, item: &LibraryItem) -> rusqlite::Result<()> {
    let date_added = if item.date_added.trim().is_empty() {
        fallback_item_timestamp(Path::new(&item.id))
    } else {
        item.date_added.clone()
    };
    let date_modified = if item.date_modified.trim().is_empty() {
        date_added.clone()
    } else {
        item.date_modified.clone()
    };

    conn.execute(
        "INSERT OR IGNORE INTO items (id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        rusqlite::params![
            item.id,
            item.item_type,
            item.title,
            item.authors,
            item.year,
            item.r#abstract,
            item.doi,
            item.arxiv_id,
            item.publication,
            item.volume,
            item.issue,
            item.pages,
            item.publisher,
            item.isbn,
            item.url,
            item.language,
            date_added,
            date_modified,
            item.folder_path,
        ],
    )?;

    for att in &item.attachments {
        conn.execute(
            "INSERT OR IGNORE INTO attachments (id, item_id, name, path, attachment_type)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![att.id, att.item_id, att.name, att.path, att.attachment_type,],
        )?;
    }

    Ok(())
}

pub fn fetch_trashed_items_from_db(
    conn: &rusqlite::Connection,
) -> rusqlite::Result<Vec<LibraryItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path
         FROM items
         WHERE COALESCE(is_trashed, 0) = 1
         ORDER BY COALESCE(trashed_at, date_modified, date_added) DESC, LOWER(title) ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(LibraryItem {
            id: row.get(0)?,
            item_type: row.get(1)?,
            title: row.get(2)?,
            authors: row.get(3)?,
            year: row.get(4)?,
            r#abstract: row.get(5)?,
            doi: row.get(6)?,
            arxiv_id: row.get(7)?,
            publication: row.get(8)?,
            volume: row.get(9)?,
            issue: row.get(10)?,
            pages: row.get(11)?,
            publisher: row.get(12)?,
            isbn: row.get(13)?,
            url: row.get(14)?,
            language: row.get(15)?,
            date_added: row.get(16)?,
            date_modified: row.get(17)?,
            folder_path: row.get(18)?,
            tags: Vec::new(),
            attachments: Vec::new(),
        })
    })?;

    let mut items = Vec::new();

    for row in rows {
        let mut item = row?;
        item.tags = fetch_item_tags(conn, &item.id);

        let mut att_stmt = conn.prepare(
            "SELECT id, item_id, name, path, attachment_type FROM attachments WHERE item_id = ?1",
        )?;
        let att_iter = att_stmt.query_map(rusqlite::params![&item.id], |row| {
            Ok(crate::models::LibraryAttachment {
                id: row.get(0)?,
                item_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                attachment_type: row.get(4)?,
            })
        })?;

        item.attachments = att_iter.filter_map(|result| result.ok()).collect();
        items.push(item);
    }

    Ok(items)
}

pub fn rekey_library_item_in_db(
    conn: &rusqlite::Connection,
    old_id: &str,
    new_id: &str,
    new_folder_path: &str,
) -> rusqlite::Result<()> {
    if let Some(mut item) = fetch_item_from_db(conn, old_id)? {
        item.id = new_id.to_string();
        item.folder_path = new_folder_path.to_string();

        if let Some(att) = item.attachments.first_mut() {
            att.id = format!("att-{}", new_id);
            att.item_id = new_id.to_string();
            att.path = new_id.to_string();
        }

        sync_item_to_db(conn, &item)?;
        conn.execute(
            "UPDATE notes SET item_id = ?1 WHERE item_id = ?2",
            rusqlite::params![new_id, old_id],
        )?;
        conn.execute(
            "UPDATE item_tags SET item_id = ?1 WHERE item_id = ?2",
            rusqlite::params![new_id, old_id],
        )?;
        conn.execute(
            "DELETE FROM attachments WHERE item_id = ?1",
            rusqlite::params![old_id],
        )?;
        conn.execute("DELETE FROM items WHERE id = ?1", rusqlite::params![old_id])?;
    }

    Ok(())
}

fn delete_item_records(conn: &rusqlite::Connection, item_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM attachments WHERE item_id = ?1",
        rusqlite::params![item_id],
    )?;
    conn.execute(
        "DELETE FROM notes WHERE item_id = ?1",
        rusqlite::params![item_id],
    )?;
    conn.execute(
        "DELETE FROM item_tags WHERE item_id = ?1",
        rusqlite::params![item_id],
    )?;
    conn.execute(
        "DELETE FROM items WHERE id = ?1",
        rusqlite::params![item_id],
    )?;
    Ok(())
}

fn delete_trashed_item_records(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let trashed_ids = fetch_trashed_items_from_db(conn)?
        .into_iter()
        .map(|item| item.id)
        .collect::<Vec<_>>();

    for item_id in trashed_ids {
        delete_item_records(conn, &item_id)?;
    }

    Ok(())
}

fn has_pdf_attachment(item: &LibraryItem) -> bool {
    item.attachments
        .iter()
        .any(|attachment| attachment.attachment_type.eq_ignore_ascii_case("pdf"))
}

fn meaningful_duplicate_field<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    values
        .into_iter()
        .map(str::trim)
        .find(|value| !value.is_empty() && *value != "—")
        .unwrap_or_default()
        .to_string()
}

fn fetch_latest_note_content(
    conn: &rusqlite::Connection,
    item_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT content FROM notes WHERE item_id = ?1 ORDER BY updated_at DESC LIMIT 1",
        rusqlite::params![item_id],
        |row| row.get(0),
    )
    .optional()
}

fn combine_merged_note_sections(sections: &[(String, String)]) -> String {
    if sections.is_empty() {
        return String::new();
    }

    if sections.len() == 1 {
        return sections[0].1.clone();
    }

    sections
        .iter()
        .map(|(label, content)| {
            if label.trim().is_empty() {
                content.trim().to_string()
            } else {
                format!("### {}\n\n{}", label.trim(), content.trim())
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

pub fn build_library_tree(
    path: &Path,
    is_root: bool,
    conn: &rusqlite::Connection,
) -> Result<crate::models::LibraryFolderNode, String> {
    fs::create_dir_all(path).map_err(|e| format!("Failed to prepare library folder: {}", e))?;

    let mut child_dirs: Vec<PathBuf> = Vec::new();
    let mut pdf_paths: Vec<PathBuf> = Vec::new();

    for entry in fs::read_dir(path).map_err(|e| format!("Failed to read library folder: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read library entry: {}", e))?;
        let entry_path = entry.path();

        if entry_path.is_dir() {
            child_dirs.push(entry_path);
        } else if is_pdf_file(&entry_path) {
            pdf_paths.push(entry_path);
        }
    }

    child_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    pdf_paths.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    let children = child_dirs
        .into_iter()
        .map(|child| build_library_tree(&child, false, conn))
        .collect::<Result<Vec<_>, _>>()?;

    let mut items = pdf_paths
        .into_iter()
        .map(|pdf| {
            let id = pdf.to_string_lossy().to_string();
            match fetch_item_from_db(conn, &id).unwrap_or(None) {
                Some(mut item) if item.date_added.trim().is_empty() => {
                    let fallback_date = fallback_item_timestamp(&pdf);
                    item.date_added = fallback_date.clone();
                    if item.date_modified.trim().is_empty() {
                        item.date_modified = fallback_date.clone();
                    }
                    let _ = conn.execute(
                        "UPDATE items SET date_added = ?1, date_modified = CASE WHEN TRIM(COALESCE(date_modified, '')) = '' THEN ?2 ELSE date_modified END WHERE id = ?3",
                        rusqlite::params![&fallback_date, &fallback_date, &item.id],
                    );
                    item
                }
                Some(item) => item,
                None => {
                    let new_item = build_library_item(&pdf);
                    let _ = sync_item_to_db(conn, &new_item);
                    new_item
                }
            }
        })
        .collect::<Vec<_>>();

    let path_str = path.to_string_lossy().to_string();
    let known_ids = items
        .iter()
        .map(|item| item.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let extra_items = fetch_items_for_folder_from_db(conn, &path_str)
        .map_err(|e| format!("Failed to load folder items from database: {}", e))?;
    items.extend(
        extra_items
            .into_iter()
            .filter(|item| !known_ids.contains(&item.id)),
    );

    let name = if is_root {
        "My Library".to_string()
    } else {
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled Folder")
            .to_string()
    };
    Ok(crate::models::LibraryFolderNode {
        id: path_str.clone(),
        name,
        path: path_str,
        children,
        items,
    })
}

#[tauri::command]
pub fn load_library_tree(
    app: tauri::AppHandle,
    state: tauri::State<crate::models::AppState>,
) -> Result<Vec<crate::models::LibraryFolderNode>, String> {
    let root = library_root_dir(&app)?;
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    Ok(vec![build_library_tree(&root, true, &conn)?])
}

#[tauri::command]
pub fn import_identifier_to_folder(
    identifier: String,
    folder_path: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<IdentifierImportResult, String> {
    let trimmed = identifier.trim();
    if trimmed.is_empty() {
        return Err("Identifier cannot be empty".to_string());
    }

    let normalized_doi = normalize_doi(trimmed);
    let normalized_arxiv = normalize_arxiv_id(trimmed);
    if normalized_doi.is_none() && normalized_arxiv.is_none() {
        return Err("Identifier must be a DOI or arXiv ID".to_string());
    }

    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    if let Some((item, matched_by)) = fetch_existing_item_by_identifier(
        &conn,
        normalized_doi.as_deref(),
        normalized_arxiv.as_deref(),
    )? {
        return Ok(IdentifierImportResult {
            item,
            created: false,
            matched_by,
        });
    }

    let mut seed = ParsedPdfMetadata::default();
    seed.doi = normalized_doi;
    seed.arxiv_id = normalized_arxiv;

    let mut parsed = enrich_metadata_with_remote_providers(&seed).meta;
    strip_invalid_metadata_url(&mut parsed)
        .map_err(|error| format!("Failed to validate imported metadata URL: {}", error))?;

    if !has_meaningful_metadata(&parsed) {
        return Err("No metadata could be resolved for this identifier".to_string());
    }

    let item = build_remote_library_item(&folder_path, trimmed, parsed);
    sync_item_to_db(&conn, &item)
        .map_err(|e| format!("Failed to save imported identifier item: {}", e))?;
    let saved_item = fetch_item_from_db(&conn, &item.id)
        .map_err(|e| format!("Failed to reload imported item: {}", e))?
        .unwrap_or(item);

    Ok(IdentifierImportResult {
        item: saved_item,
        created: true,
        matched_by: "none".to_string(),
    })
}

#[tauri::command]
pub fn import_reference_file_to_folder(
    file_path: String,
    folder_path: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<ReferenceImportResult, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err("Selected reference file does not exist".to_string());
    }
    if !source.is_file() {
        return Err("Selected reference import target must be a file".to_string());
    }

    let content =
        fs::read_to_string(&source).map_err(|error| format!("Failed to read reference file: {}", error))?;
    let source_format = detect_reference_import_format(&source, &content)?;
    let parsed_items = match source_format {
        "bibtex" => parse_bibtex_references(&content)?,
        "ris" => parse_ris_references(&content)?,
        "csljson" => parse_csljson_references(&content)?,
        _ => return Err("Unsupported reference file format".to_string()),
    };

    let source_label = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("reference-import");

    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let mut items = Vec::new();
    let mut created_count = 0usize;
    let mut existing_count = 0usize;

    for (index, parsed_item) in parsed_items.into_iter().enumerate() {
        let normalized_doi = normalize_doi(&parsed_item.doi);
        let normalized_arxiv = normalize_arxiv_id(&parsed_item.arxiv_id)
            .or_else(|| normalize_arxiv_id(&parsed_item.url));

        if let Some((mut existing_item, _matched_by)) = fetch_existing_item_by_identifier(
            &conn,
            normalized_doi.as_deref(),
            normalized_arxiv.as_deref(),
        )? {
            existing_item.tags = fetch_item_tags(&conn, &existing_item.id);
            items.push(existing_item);
            existing_count += 1;
            continue;
        }

        let seed_label = if parsed_item.title.trim().is_empty() {
            format!("{}-{}", source_label, index + 1)
        } else {
            parsed_item.title.clone()
        };
        let item = build_reference_library_item(&folder_path, &seed_label, parsed_item, index + 1);
        sync_item_to_db(&conn, &item)
            .map_err(|error| format!("Failed to save imported reference item: {}", error))?;
        replace_item_tags_in_db(&conn, &item.id, &item.tags)
            .map_err(|error| format!("Failed to save imported reference tags: {}", error))?;

        let mut saved_item = fetch_item_from_db(&conn, &item.id)
            .map_err(|error| format!("Failed to reload imported reference item: {}", error))?
            .unwrap_or(item);
        saved_item.tags = fetch_item_tags(&conn, &saved_item.id);
        items.push(saved_item);
        created_count += 1;
    }

    Ok(ReferenceImportResult {
        items,
        created_count,
        existing_count,
        source_format: source_format.to_string(),
    })
}

#[tauri::command]
pub fn get_all_annotations(path: String) -> Result<SavedPdfAnnotationsDocument, String> {
    let pdf_path = PathBuf::from(&path);
    if !pdf_path.exists() {
        return Err("PDF does not exist".to_string());
    }

    Ok(read_annotation_sidecar(&pdf_path).unwrap_or_default())
}

#[tauri::command]
pub fn load_pdf_annotations(
    path: String,
    page_index: u16,
) -> Result<SavedPdfPageAnnotations, String> {
    let pdf_path = PathBuf::from(&path);
    if !pdf_path.exists() {
        return Err("PDF does not exist".to_string());
    }

    let Some(document) = read_annotation_sidecar(&pdf_path) else {
        return Ok(SavedPdfPageAnnotations::default());
    };

    Ok(document
        .pages
        .get(&page_index.to_string())
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
pub fn save_pdf_annotations(
    path: String,
    page_index: u16,
    annotations: SavedPdfPageAnnotations,
) -> Result<(), String> {
    let pdf_path = PathBuf::from(&path);
    if !pdf_path.exists() {
        return Err("PDF does not exist".to_string());
    }

    let mut document = read_annotation_sidecar(&pdf_path).unwrap_or_default();
    document.version = crate::models::default_annotation_version();

    let page_key = page_index.to_string();
    if crate::pdf_handlers::is_annotation_payload_empty(&annotations) {
        document.pages.remove(&page_key);
    } else {
        document.pages.insert(page_key, annotations);
    }

    if document.pages.is_empty() {
        remove_annotation_sidecar(&pdf_path);
        return Ok(());
    }

    write_annotation_sidecar(&pdf_path, &document)
}

#[tauri::command]
pub fn create_library_folder(parent_path: String, name: String) -> Result<String, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    if trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err("Folder name cannot contain path separators".to_string());
    }

    let parent = PathBuf::from(parent_path);
    fs::create_dir_all(&parent).map_err(|e| format!("Failed to access parent folder: {}", e))?;

    let target = unique_directory_path(&parent, trimmed_name);
    fs::create_dir_all(&target).map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_pdf_to_folder(
    app: tauri::AppHandle,
    source_path: String,
    folder_path: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err("Selected PDF does not exist".to_string());
    }
    if !is_pdf_file(&source) {
        return Err("Only PDF files can be imported".to_string());
    }

    let target_folder = PathBuf::from(&folder_path);
    fs::create_dir_all(&target_folder)
        .map_err(|e| format!("Failed to access target folder: {}", e))?;

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid PDF filename")?;
    let target = unique_file_path(&target_folder, file_name);

    fs::copy(&source, &target).map_err(|e| format!("Failed to import PDF: {}", e))?;
    copy_annotation_sidecar(&source, &target);

    let local_meta = extract_pdf_metadata(&target).unwrap_or_default();

    let mut auto_rename = true;
    let mut rename_pattern = "[Year] - [Author] - [Title]".to_string();

    if let Ok(conn) = state.db.lock() {
        let mut stmt = conn
            .prepare(
                "SELECT key, value FROM settings WHERE key IN ('autoRenamePdf', 'renamePattern')",
            )
            .unwrap();
        let _ = stmt
            .query_map([], |row| {
                let k: String = row.get(0)?;
                let v: String = row.get(1)?;
                if k == "autoRenamePdf" {
                    auto_rename = v == "true";
                } else if k == "renamePattern" {
                    rename_pattern = v;
                }
                Ok(())
            })
            .map(|mut iter| while let Some(Ok(_)) = iter.next() {});
    }

    let final_path = if auto_rename {
        let title = local_meta.title.as_deref().unwrap_or("Unknown Title");
        let year = local_meta.year.as_deref().unwrap_or("Unknown Year");
        let authors = local_meta.authors.as_deref().unwrap_or("Unknown Author");

        let mut first_author = authors.split(',').next().unwrap_or("Unknown Author").trim();
        if first_author.contains(' ') {
            first_author = first_author
                .split_whitespace()
                .last()
                .unwrap_or(first_author);
        }

        let proposed_name = rename_pattern
            .replace("[Year]", year)
            .replace("[Author]", first_author)
            .replace("[Title]", title);

        let safe_name = sanitize_file_name(&proposed_name);

        if safe_name.is_empty() {
            target.clone()
        } else {
            let renamed = unique_file_path(&target_folder, &format!("{}.pdf", safe_name));

            if renamed != target {
                fs::rename(&target, &renamed)
                    .map_err(|e| format!("Failed to rename imported PDF: {}", e))?;
                renamed
            } else {
                target.clone()
            }
        }
    } else {
        target.clone()
    };

    if final_path != target {
        rename_cached_pdf_metadata(&target, &final_path);
        rename_annotation_sidecar(&target, &final_path);
    }

    if let Ok(conn) = state.db.lock() {
        let new_item = build_library_item_from_parsed_metadata(&final_path, local_meta);
        let _ = sync_item_to_db(&conn, &new_item);
    }

    spawn_import_metadata_refresh(app, state.db.clone(), final_path.to_string_lossy().to_string());

    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_trash_items(
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<crate::models::LibraryItem>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    fetch_trashed_items_from_db(&conn).map_err(|e| format!("Failed to load trash items: {}", e))
}

fn fetch_trashed_item_restore_info(
    conn: &rusqlite::Connection,
    item_id: &str,
) -> Result<Option<(String, String)>, String> {
    conn.query_row(
        "SELECT COALESCE(original_path, ''), COALESCE(original_folder_path, '') FROM items WHERE id = ?1 AND COALESCE(is_trashed, 0) = 1",
        rusqlite::params![item_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| format!("Failed to load trashed item info: {}", e))
}

#[tauri::command]
pub fn delete_library_pdf(
    app: tauri::AppHandle,
    path: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        remove_cached_pdf_metadata(&target);
        remove_annotation_sidecar(&target);
        if let Ok(conn) = state.db.lock() {
            delete_item_records(&conn, &path)
                .map_err(|e| format!("Failed to delete stale item record: {}", e))?;
        }
        return Ok(());
    }

    if !target.is_file() || !is_pdf_file(&target) {
        return Err("Only library PDF files can be deleted".to_string());
    }

    let trash_root = trash_root_dir(&app)?;
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid PDF filename")?;
    let trash_target = unique_file_path(&trash_root, file_name);
    let trashed_path = trash_target.to_string_lossy().to_string();
    let original_folder_path = target
        .parent()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let trashed_at = now_iso8601();

    {
        let mut docs = state.documents.lock().unwrap();
        docs.remove(&path);
    }

    fs::rename(&target, &trash_target)
        .map_err(|e| format!("Failed to move PDF to trash: {}", e))?;

    rename_cached_pdf_metadata(&target, &trash_target);
    rename_annotation_sidecar(&target, &trash_target);

    if let Ok(conn) = state.db.lock() {
        rekey_library_item_in_db(&conn, &path, &trashed_path, "__trash__")
            .map_err(|e| format!("Failed to rekey trashed item: {}", e))?;
        conn.execute(
            "UPDATE items
             SET is_trashed = 1,
                 original_path = ?1,
                 original_folder_path = ?2,
                 trashed_at = ?3
             WHERE id = ?4",
            rusqlite::params![&path, &original_folder_path, &trashed_at, &trashed_path],
        )
        .map_err(|e| format!("Failed to mark item as trashed: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn restore_library_pdf(
    path: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err("Trashed PDF does not exist".to_string());
    }

    if !source.is_file() || !is_pdf_file(&source) {
        return Err("Only trashed PDF files can be restored".to_string());
    }

    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let (original_path, original_folder_path) = fetch_trashed_item_restore_info(&conn, &path)?
        .ok_or("Trashed item not found".to_string())?;
    if original_path.trim().is_empty() {
        return Err("Original location is unavailable".to_string());
    }

    let restore_target = PathBuf::from(&original_path);
    let restore_parent = if original_folder_path.trim().is_empty() {
        restore_target
            .parent()
            .map(Path::to_path_buf)
            .ok_or("Invalid restore path")?
    } else {
        PathBuf::from(&original_folder_path)
    };
    fs::create_dir_all(&restore_parent)
        .map_err(|e| format!("Failed to prepare restore folder: {}", e))?;

    let restore_name = restore_target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid restore PDF name")?;
    let final_target = unique_file_path(&restore_parent, restore_name);
    let restored_path = final_target.to_string_lossy().to_string();

    {
        let mut docs = state.documents.lock().unwrap();
        docs.remove(&path);
    }

    fs::rename(&source, &final_target).map_err(|e| format!("Failed to restore PDF: {}", e))?;
    rename_cached_pdf_metadata(&source, &final_target);
    rename_annotation_sidecar(&source, &final_target);

    let new_folder_path = final_target
        .parent()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    rekey_library_item_in_db(&conn, &path, &restored_path, &new_folder_path)
        .map_err(|e| format!("Failed to rekey restored item: {}", e))?;
    conn.execute(
        "UPDATE items
         SET is_trashed = 0,
             original_path = NULL,
             original_folder_path = NULL,
             trashed_at = NULL
         WHERE id = ?1",
        rusqlite::params![&restored_path],
    )
    .map_err(|e| format!("Failed to clear trash metadata: {}", e))?;

    Ok(restored_path)
}

#[tauri::command]
pub fn empty_trash(state: tauri::State<'_, crate::models::AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let trashed_items = fetch_trashed_items_from_db(&conn)
        .map_err(|e| format!("Failed to load trash items: {}", e))?;

    {
        let mut docs = state.documents.lock().unwrap();
        for item in &trashed_items {
            docs.remove(&item.id);
        }
    }

    for item in &trashed_items {
        let path = PathBuf::from(&item.id);
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        remove_cached_pdf_metadata(&path);
        remove_annotation_sidecar(&path);
    }

    delete_trashed_item_records(&conn).map_err(|e| format!("Failed to empty trash: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn rename_library_pdf(
    path: String,
    new_name: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        let sanitized_name = sanitize_file_name(&new_name);
        if sanitized_name.is_empty() {
            return Err("Item name cannot be empty".to_string());
        }

        let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
        conn.execute(
            "UPDATE items SET title = ?1, date_modified = datetime('now') WHERE id = ?2",
            rusqlite::params![sanitized_name, path],
        )
        .map_err(|e| format!("Failed to rename metadata-only item: {}", e))?;

        return Ok(path);
    }

    if !source.is_file() || !is_pdf_file(&source) {
        return Err("Only library PDF files can be renamed".to_string());
    }

    let sanitized_name = sanitize_file_name(&new_name);
    if sanitized_name.is_empty() {
        return Err("PDF name cannot be empty".to_string());
    }

    let parent = source.parent().ok_or("Invalid PDF path")?;
    let current_stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if current_stem == sanitized_name {
        return Ok(path);
    }

    let target = unique_file_path(parent, &format!("{}.pdf", sanitized_name));

    if target == source {
        return Ok(path);
    }

    {
        let mut docs = state.documents.lock().unwrap();
        docs.remove(&path);
    }

    fs::rename(&source, &target).map_err(|e| format!("Failed to rename PDF: {}", e))?;

    rename_cached_pdf_metadata(&source, &target);
    rename_annotation_sidecar(&source, &target);

    let target_path_str = target.to_string_lossy().to_string();

    if let Ok(conn) = state.db.lock() {
        let new_folder_path = target
            .parent()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let _ = rekey_library_item_in_db(&conn, &path, &target_path_str, &new_folder_path);
    }

    Ok(target_path_str)
}

#[tauri::command]
pub fn move_library_pdf(
    app: tauri::AppHandle,
    path: String,
    target_folder_path: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
        conn.execute(
            "UPDATE items SET folder_path = ?1, date_modified = datetime('now') WHERE id = ?2",
            rusqlite::params![target_folder_path, path],
        )
        .map_err(|e| format!("Failed to move metadata-only item: {}", e))?;
        return Ok(path);
    }

    if !source.is_file() || !is_pdf_file(&source) {
        return Err("Only library PDF files can be moved".to_string());
    }

    let target_folder = PathBuf::from(&target_folder_path);
    if !target_folder.exists() {
        return Err("Target folder does not exist".to_string());
    }

    if !target_folder.is_dir() {
        return Err("Target must be a folder".to_string());
    }

    let library_root = library_root_dir(&app)?;
    if !is_path_within(&library_root, &source) || !is_path_within(&library_root, &target_folder) {
        return Err("Source or target is outside the library".to_string());
    }

    let source_parent = source.parent().ok_or("Invalid PDF path")?;
    if source_parent == target_folder {
        return Ok(path);
    }

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid PDF name")?;
    let target = unique_file_path(&target_folder, file_name);

    {
        let mut docs = state.documents.lock().unwrap();
        docs.remove(&path);
    }

    fs::rename(&source, &target).map_err(|e| format!("Failed to move PDF: {}", e))?;

    rename_cached_pdf_metadata(&source, &target);
    rename_annotation_sidecar(&source, &target);

    let target_path_str = target.to_string_lossy().to_string();
    if let Ok(conn) = state.db.lock() {
        let _ = rekey_library_item_in_db(&conn, &path, &target_path_str, &target_folder_path);
    }

    Ok(target_path_str)
}

#[tauri::command]
pub fn merge_duplicate_items(
    primary_item_id: String,
    duplicate_item_ids: Vec<String>,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<MergeDuplicateItemsResult, String> {
    let normalized_ids = duplicate_item_ids
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .fold(Vec::new(), |mut items, value| {
            if !items.contains(&value) {
                items.push(value);
            }
            items
        });

    if normalized_ids.len() < 2 {
        return Err("At least two items are required to merge duplicates".to_string());
    }

    let preferred_id = primary_item_id.trim().to_string();
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;

    let mut items = Vec::new();
    for item_id in &normalized_ids {
        let mut item = fetch_item_from_db(&conn, item_id)
            .map_err(|e| format!("Failed to load duplicate item: {}", e))?
            .ok_or_else(|| format!("Duplicate item not found: {}", item_id))?;
        item.tags = fetch_item_tags(&conn, &item.id);
        items.push(item);
    }

    let survivor_index = items
        .iter()
        .position(|item| item.id == preferred_id && has_pdf_attachment(item))
        .or_else(|| items.iter().position(has_pdf_attachment))
        .or_else(|| items.iter().position(|item| item.id == preferred_id))
        .unwrap_or(0);

    let survivor_id = items[survivor_index].id.clone();
    let merged_item_ids = items
        .iter()
        .filter(|item| item.id != survivor_id)
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();

    let mut merge_order = Vec::with_capacity(items.len());
    merge_order.push(items[survivor_index].clone());
    for (index, item) in items.iter().enumerate() {
        if index != survivor_index {
            merge_order.push(item.clone());
        }
    }

    let merged_tags = {
        let mut seen = HashSet::new();
        let mut tags = Vec::new();
        for item in &merge_order {
            for tag in &item.tags {
                let trimmed = tag.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let normalized = trimmed.to_lowercase();
                if seen.insert(normalized) {
                    tags.push(trimmed.to_string());
                }
            }
        }
        tags
    };

    let merged_note = {
        let mut seen = HashSet::new();
        let mut sections = Vec::new();
        for item in &merge_order {
            let Some(content) = fetch_latest_note_content(&conn, &item.id)
                .map_err(|e| format!("Failed to load item note: {}", e))? else {
                continue;
            };
            let trimmed_content = content.trim();
            if trimmed_content.is_empty() {
                continue;
            }

            if !seen.insert(trimmed_content.to_string()) {
                continue;
            }

            let label = if item.title.trim().is_empty() {
                item.id.clone()
            } else {
                item.title.trim().to_string()
            };
            sections.push((label, trimmed_content.to_string()));
        }
        combine_merged_note_sections(&sections)
    };

    let merged_item = {
        let survivor = &merge_order[0];
        let mut item = survivor.clone();
        item.title = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.title.as_str()));
        item.authors = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.authors.as_str()));
        item.year = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.year.as_str()));
        item.r#abstract = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.r#abstract.as_str()));
        item.doi = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.doi.as_str()));
        item.arxiv_id = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.arxiv_id.as_str()));
        item.publication = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.publication.as_str()));
        item.volume = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.volume.as_str()));
        item.issue = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.issue.as_str()));
        item.pages = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.pages.as_str()));
        item.publisher = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.publisher.as_str()));
        item.isbn = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.isbn.as_str()));
        item.url = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.url.as_str()));
        item.language = meaningful_duplicate_field(merge_order.iter().map(|entry| entry.language.as_str()));
        item.tags = merged_tags.clone();
        item
    };

    conn.execute(
        "UPDATE items SET
            title = ?1,
            authors = ?2,
            year = ?3,
            abstract = ?4,
            doi = ?5,
            arxiv_id = ?6,
            publication = ?7,
            volume = ?8,
            issue = ?9,
            pages = ?10,
            publisher = ?11,
            isbn = ?12,
            url = ?13,
            language = ?14,
            date_modified = datetime('now')
         WHERE id = ?15",
        rusqlite::params![
            merged_item.title,
            merged_item.authors,
            merged_item.year,
            merged_item.r#abstract,
            merged_item.doi,
            merged_item.arxiv_id,
            merged_item.publication,
            merged_item.volume,
            merged_item.issue,
            merged_item.pages,
            merged_item.publisher,
            merged_item.isbn,
            merged_item.url,
            merged_item.language,
            survivor_id,
        ],
    )
    .map_err(|e| format!("Failed to update merged item: {}", e))?;

    conn.execute(
        "DELETE FROM item_tags WHERE item_id = ?1",
        rusqlite::params![&survivor_id],
    )
    .map_err(|e| format!("Failed to reset merged tags: {}", e))?;
    for tag in &merged_tags {
        conn.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?1, ?2)",
            rusqlite::params![&survivor_id, tag],
        )
        .map_err(|e| format!("Failed to save merged tag: {}", e))?;
        ensure_tag_color_for_tag(&conn, tag)?;
    }

    let mut attachment_keys = HashSet::new();
    let mut next_attachment_index = 0usize;
    for attachment in &merge_order[0].attachments {
        attachment_keys.insert(format!(
            "{}::{}",
            attachment.attachment_type.to_lowercase(),
            attachment.path.to_lowercase()
        ));
        next_attachment_index += 1;
    }

    for item in merge_order.iter().skip(1) {
        for attachment in &item.attachments {
            let attachment_key = format!(
                "{}::{}",
                attachment.attachment_type.to_lowercase(),
                attachment.path.to_lowercase()
            );
            if !attachment_keys.insert(attachment_key) {
                continue;
            }

            let attachment_id = format!("att-{}-{}", survivor_id, next_attachment_index);
            next_attachment_index += 1;
            conn.execute(
                "INSERT INTO attachments (id, item_id, name, path, attachment_type) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    attachment_id,
                    &survivor_id,
                    attachment.name,
                    attachment.path,
                    attachment.attachment_type,
                ],
            )
            .map_err(|e| format!("Failed to merge attachments: {}", e))?;
        }
    }

    if !merged_note.is_empty() {
        upsert_item_note(survivor_id.clone(), merged_note, state.clone())
            .map_err(|e| format!("Failed to save merged note: {}", e))?;
    }

    for item_id in &merged_item_ids {
        delete_item_records(&conn, item_id)
            .map_err(|e| format!("Failed to delete merged duplicate: {}", e))?;
    }

    drop(conn);

    {
        let mut docs = state.documents.lock().map_err(|_| "Failed to lock document cache")?;
        for item_id in &merged_item_ids {
            docs.remove(item_id);
        }
    }

    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let mut item = fetch_item_from_db(&conn, &survivor_id)
        .map_err(|e| format!("Failed to load merged item: {}", e))?
        .ok_or("Merged item could not be reloaded")?;
    item.tags = fetch_item_tags(&conn, &survivor_id);

    Ok(MergeDuplicateItemsResult {
        item,
        survivor_item_id: survivor_id,
        merged_item_ids,
    })
}

#[tauri::command]
pub fn rename_library_folder(
    app: tauri::AppHandle,
    path: String,
    new_name: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err("Folder does not exist".to_string());
    }
    if !source.is_dir() {
        return Err("Only library folders can be renamed".to_string());
    }

    let library_root = library_root_dir(&app)?;
    if source == library_root {
        return Err("The library root folder cannot be renamed".to_string());
    }
    if !is_path_within(&library_root, &source) {
        return Err("Folder is outside the library".to_string());
    }

    let sanitized_name = sanitize_file_name(&new_name);
    if sanitized_name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }

    let current_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if current_name == sanitized_name {
        return Ok(path);
    }

    let parent = source.parent().ok_or("Invalid folder path")?;
    let target = unique_directory_path(parent, &sanitized_name);

    {
        let mut docs = state.documents.lock().unwrap();
        let keys_to_remove = docs
            .keys()
            .filter(|key| *key == &path || key.starts_with(&format!("{}/", path)))
            .cloned()
            .collect::<Vec<_>>();

        for key in keys_to_remove {
            docs.remove(&key);
        }
    }

    fs::rename(&source, &target).map_err(|e| format!("Failed to rename folder: {}", e))?;

    if let Ok(conn) = state.db.lock() {
        let target_str = target.to_string_lossy().to_string();
        let pattern = format!("{}%", path);
        let _ = conn.execute(
            "UPDATE items SET id = replace(id, ?1, ?2), folder_path = replace(folder_path, ?1, ?2) WHERE id LIKE ?3",
            rusqlite::params![&path, &target_str, &pattern],
        );
        let _ = conn.execute(
            "UPDATE attachments SET id = replace(id, ?1, ?2), item_id = replace(item_id, ?1, ?2), path = replace(path, ?1, ?2) WHERE item_id LIKE ?3",
            rusqlite::params![&path, &target_str, &pattern],
        );
    }

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_library_folder(
    app: tauri::AppHandle,
    path: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("Folder does not exist".to_string());
    }
    if !target.is_dir() {
        return Err("Only library folders can be deleted".to_string());
    }

    let library_root = library_root_dir(&app)?;
    if target == library_root {
        return Err("The library root folder cannot be deleted".to_string());
    }
    if !is_path_within(&library_root, &target) {
        return Err("Folder is outside the library".to_string());
    }

    {
        let mut docs = state.documents.lock().unwrap();
        let keys_to_remove = docs
            .keys()
            .filter(|key| key.starts_with(&format!("{}/", path)))
            .cloned()
            .collect::<Vec<_>>();

        for key in keys_to_remove {
            docs.remove(&key);
        }
    }

    fs::remove_dir_all(&target).map_err(|e| format!("Failed to delete folder: {}", e))?;

    if let Ok(conn) = state.db.lock() {
        let pattern = format!("{}/%", path);
        let _ = conn.execute(
            "DELETE FROM attachments WHERE item_id LIKE ?1",
            rusqlite::params![&pattern],
        );
        let _ = conn.execute(
            "DELETE FROM notes WHERE item_id LIKE ?1",
            rusqlite::params![&pattern],
        );
        let _ = conn.execute(
            "DELETE FROM item_tags WHERE item_id LIKE ?1",
            rusqlite::params![&pattern],
        );
        let _ = conn.execute(
            "DELETE FROM items WHERE id LIKE ?1",
            rusqlite::params![&pattern],
        );
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Global Library Search
// ─────────────────────────────────────────────────────────────

pub fn fetch_item_tags(conn: &rusqlite::Connection, item_id: &str) -> Vec<String> {
    let mut stmt = match conn.prepare("SELECT tag FROM item_tags WHERE item_id = ?1 ORDER BY tag") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map(rusqlite::params![item_id], |row| row.get::<_, String>(0))
        .map(|iter| iter.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

#[derive(serde::Deserialize)]
pub struct SearchLibraryParams {
    /// Free-text query string
    pub query: String,
    /// Field scope: "all" | "title" | "authors" | "year" | "doi" | "arxiv"
    pub field: String,
    /// Optional year equality filter (applied in addition to `query`)
    pub year_filter: Option<String>,
    /// Optional tag equality filters (AND-combined)
    pub tag_filters: Vec<String>,
}

/// DB-only search – usable from CLI without tauri::State.
pub fn search_library_db(
    conn: &rusqlite::Connection,
    params: &SearchLibraryParams,
) -> Result<Vec<crate::models::LibraryItem>, String> {
    let query_text = params.query.trim();
    let pattern = format!("%{}%", query_text.to_lowercase());

    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<String> = Vec::new();

    // ── Main text query ──────────────────────────────────────
    if !query_text.is_empty() {
        match params.field.as_str() {
            "title" => {
                conditions.push("LOWER(i.title) LIKE ?".to_string());
                param_values.push(pattern.clone());
            }
            "authors" => {
                conditions.push("LOWER(i.authors) LIKE ?".to_string());
                param_values.push(pattern.clone());
            }
            "year" => {
                conditions.push("i.year = ?".to_string());
                param_values.push(query_text.to_string());
            }
            "doi" => {
                conditions.push("LOWER(i.doi) LIKE ?".to_string());
                param_values.push(pattern.clone());
            }
            "arxiv" => {
                conditions.push("LOWER(i.arxiv_id) LIKE ?".to_string());
                param_values.push(pattern.clone());
            }
            _ => {
                // "all" – search title, authors, DOI, arXiv, publication, abstract, tags, and notes
                conditions.push(
                    "(LOWER(i.title) LIKE ? \
                     OR LOWER(i.authors) LIKE ? \
                     OR LOWER(i.doi) LIKE ? \
                     OR LOWER(i.arxiv_id) LIKE ? \
                     OR LOWER(i.publication) LIKE ? \
                     OR LOWER(i.abstract) LIKE ? \
                     OR EXISTS (SELECT 1 FROM item_tags it \
                                WHERE it.item_id = i.id AND LOWER(it.tag) LIKE ?) \
                     OR EXISTS (SELECT 1 FROM notes n \
                                WHERE n.item_id = i.id AND LOWER(n.content) LIKE ?))"
                        .to_string(),
                );
                for _ in 0..8 {
                    param_values.push(pattern.clone());
                }
            }
        }
    }

    // ── Year equality filter ─────────────────────────────────
    if let Some(year) = &params.year_filter {
        let y = year.trim();
        if !y.is_empty() {
            conditions.push("i.year = ?".to_string());
            param_values.push(y.to_string());
        }
    }

    // ── Tag equality filters (AND) ───────────────────────────
    for tag in &params.tag_filters {
        let t = tag.trim();
        if !t.is_empty() {
            conditions.push(
                "EXISTS (SELECT 1 FROM item_tags it \
                          WHERE it.item_id = i.id AND LOWER(it.tag) = ?)"
                    .to_string(),
            );
            param_values.push(t.to_lowercase());
        }
    }

    // Nothing to search for → return empty rather than the whole library
    if conditions.is_empty() {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT DISTINCT i.id, i.item_type, i.title, i.authors, i.year, i.abstract, \
                        i.doi, i.arxiv_id, i.publication, i.volume, i.issue, i.pages, \
                        i.publisher, i.isbn, i.url, i.language, \
                        i.date_added, i.date_modified, i.folder_path \
         FROM items i \
         WHERE {} \
         ORDER BY i.title ASC \
         LIMIT 200",
        format!(
            "COALESCE(i.is_trashed, 0) = 0 AND {}",
            conditions.join(" AND ")
        )
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Prepare error: {}", e))?;

    let rows = stmt
        .query_map(rusqlite::params_from_iter(param_values.iter()), |row| {
            Ok(crate::models::LibraryItem {
                id: row.get(0)?,
                item_type: row.get(1)?,
                title: row.get(2)?,
                authors: row.get(3)?,
                year: row.get(4)?,
                r#abstract: row.get(5)?,
                doi: row.get(6)?,
                arxiv_id: row.get(7)?,
                publication: row.get(8)?,
                volume: row.get(9)?,
                issue: row.get(10)?,
                pages: row.get(11)?,
                publisher: row.get(12)?,
                isbn: row.get(13)?,
                url: row.get(14)?,
                language: row.get(15)?,
                date_added: row.get(16)?,
                date_modified: row.get(17)?,
                folder_path: row.get(18)?,
                tags: Vec::new(),
                attachments: Vec::new(),
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut items: Vec<crate::models::LibraryItem> = Vec::new();

    for row in rows {
        let mut item = row.map_err(|e| format!("Row error: {}", e))?;

        // Enrich with tags
        item.tags = fetch_item_tags(&conn, &item.id);

        // Enrich with attachments
        if let Ok(mut att_stmt) = conn.prepare(
            "SELECT id, item_id, name, path, attachment_type \
             FROM attachments WHERE item_id = ?1",
        ) {
            if let Ok(att_iter) = att_stmt.query_map(rusqlite::params![&item.id], |row| {
                Ok(crate::models::LibraryAttachment {
                    id: row.get(0)?,
                    item_id: row.get(1)?,
                    name: row.get(2)?,
                    path: row.get(3)?,
                    attachment_type: row.get(4)?,
                })
            }) {
                item.attachments = att_iter.filter_map(|r| r.ok()).collect();
            }
        }

        items.push(item);
    }

    Ok(items)
}

#[tauri::command]
pub fn search_library(
    params: SearchLibraryParams,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<crate::models::LibraryItem>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    search_library_db(&conn, &params)
}

// ─────────────────────────────────────────────────────────────
// Notes: per-item markdown notes
// ─────────────────────────────────────────────────────────────

fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // Store as seconds since epoch string for simplicity; frontend can format.
    now.as_secs().to_string()
}

fn find_pdf_attachment_path(
    conn: &rusqlite::Connection,
    item_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT path FROM attachments WHERE item_id = ?1 AND attachment_type = 'PDF' LIMIT 1",
        rusqlite::params![item_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("Query PDF attachment failed: {}", e))
}

fn get_setting_value(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1 LIMIT 1",
        rusqlite::params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("Query setting failed: {}", e))
}

fn get_required_ai_settings(
    conn: &rusqlite::Connection,
) -> Result<(String, String, String), String> {
    let api_key = get_setting_value(conn, "aiApiKey")?.unwrap_or_default();
    let completion_url = get_setting_value(conn, "aiCompletionUrl")?.unwrap_or_default();
    let model = get_setting_value(conn, "aiModel")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "gpt-4o-mini".to_string());

    if api_key.trim().is_empty() {
        return Err("Missing AI API key in settings".to_string());
    }
    if completion_url.trim().is_empty() {
        return Err("Missing AI completion URL in settings".to_string());
    }

    Ok((api_key, completion_url, model))
}

fn default_ai_summary_system_prompt() -> &'static str {
    "You summarize academic papers. Follow the requested language exactly. Be concise, factual, and avoid markdown tables."
}

fn default_ai_translate_system_prompt() -> &'static str {
    "You are a precise academic translator. Return only the translated text, then a final line in the format SOURCE_LANGUAGE_HINT: <value>."
}

fn get_ai_summary_system_prompt(conn: &rusqlite::Connection) -> Result<String, String> {
    Ok(get_setting_value(conn, "aiSummarySystemPrompt")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_ai_summary_system_prompt().to_string()))
}

fn get_ai_translate_system_prompt(conn: &rusqlite::Connection) -> Result<String, String> {
    Ok(get_setting_value(conn, "aiTranslateSystemPrompt")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_ai_translate_system_prompt().to_string()))
}

fn make_summary_prompt_key(completion_url: &str, system_prompt: &str, item_title: &str) -> String {
    format!(
        "{}::{}::{}",
        completion_url.trim().to_lowercase(),
        system_prompt.trim(),
        item_title.trim()
    )
}

fn read_cached_paper_summary(
    conn: &rusqlite::Connection,
    item_id: &str,
    language: &str,
    model: &str,
    prompt_key: &str,
) -> Result<Option<CachedPaperSummaryRecord>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT summary_json FROM ai_paper_summary_cache WHERE item_id = ?1 AND language = ?2 AND model = ?3 AND prompt_key = ?4 LIMIT 1",
            rusqlite::params![item_id, language, model, prompt_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read cached paper summary: {}", e))?;

    raw.map(|value| {
        serde_json::from_str(&value)
            .map_err(|e| format!("Failed to parse cached paper summary: {}", e))
    })
    .transpose()
}

fn write_cached_paper_summary(
    conn: &rusqlite::Connection,
    item_id: &str,
    language: &str,
    model: &str,
    prompt_key: &str,
    record: &CachedPaperSummaryRecord,
) -> Result<(), String> {
    let payload = serde_json::to_string(record)
        .map_err(|e| format!("Failed to serialize cached paper summary: {}", e))?;

    conn.execute(
        "INSERT INTO ai_paper_summary_cache (item_id, language, model, prompt_key, file_size, modified_unix_ms, summary_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(item_id, language, model, prompt_key)
         DO UPDATE SET file_size = excluded.file_size,
                       modified_unix_ms = excluded.modified_unix_ms,
                       summary_json = excluded.summary_json,
                       updated_at = excluded.updated_at",
        rusqlite::params![
            item_id,
            language,
            model,
            prompt_key,
            record.file_size as i64,
            record.modified_unix_ms as i64,
            payload,
            record.updated_at,
        ],
    )
    .map_err(|e| format!("Failed to cache paper summary: {}", e))?;

    Ok(())
}

fn completion_message_content_to_string(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(text) => text.trim().to_string(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(|value| value.as_str()))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

fn call_openai_compatible_chat(
    completion_url: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to build AI HTTP client: {}", e))?;

    let payload = serde_json::json!({
        "model": model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });

    let response = client
        .post(completion_url)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .map_err(|e| format!("AI request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("AI request failed with {}: {}", status, body));
    }

    let parsed: ChatCompletionResponse = response
        .json()
        .map_err(|e| format!("Failed to parse AI response: {}", e))?;

    let content = parsed
        .choices
        .first()
        .map(|choice| completion_message_content_to_string(&choice.message.content))
        .unwrap_or_default();

    if content.trim().is_empty() {
        return Err("AI response did not contain any text".to_string());
    }

    Ok(content)
}

fn parse_bullet_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.trim_start_matches(|ch: char| {
                ch == '-' || ch == '*' || ch == '•' || ch.is_ascii_digit() || ch == '.' || ch == ')'
            })
            .trim()
            .to_string()
        })
        .filter(|line| !line.is_empty())
        .collect()
}

fn parse_tagged_output(content: &str, tag: &str) -> Option<String> {
    content
        .lines()
        .find_map(|line| line.strip_prefix(tag).map(|value| value.trim().to_string()))
        .filter(|value| !value.is_empty())
}

fn google_translate_text(text: &str, target_language: &str) -> Result<(String, String), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build Google Translate client: {}", e))?;

    let response = client
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[
            ("client", "gtx"),
            ("sl", "auto"),
            ("tl", target_language),
            ("dt", "t"),
            ("q", text),
        ])
        .send()
        .map_err(|e| format!("Google Translate request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "Google Translate request failed with {}: {}",
            status, body
        ));
    }

    let payload: serde_json::Value = response
        .json()
        .map_err(|e| format!("Failed to parse Google Translate response: {}", e))?;

    let translation = payload
        .get(0)
        .and_then(|value| value.as_array())
        .map(|segments| {
            segments
                .iter()
                .filter_map(|segment| segment.get(0).and_then(|value| value.as_str()))
                .collect::<String>()
        })
        .unwrap_or_default()
        .trim()
        .to_string();

    if translation.is_empty() {
        return Err("Google Translate response was empty".to_string());
    }

    let source_language_hint = payload
        .get(2)
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_string();

    Ok((translation, source_language_hint))
}

fn bing_web_auth_cache() -> &'static Mutex<Option<BingWebAuthState>> {
    BING_WEB_AUTH_CACHE.get_or_init(|| Mutex::new(None))
}

fn normalize_bing_web_language_code(target_language: &str) -> String {
    let trimmed = target_language.trim();
    if trimmed.is_empty() {
        return "zh-Hans".to_string();
    }

    let lowered = trimmed.to_ascii_lowercase();
    match lowered.as_str() {
        "zh" | "zh-cn" | "zh-sg" | "zh-hans" => "zh-Hans".to_string(),
        "zh-tw" | "zh-hk" | "zh-mo" | "zh-hant" => "zh-Hant".to_string(),
        _ => trimmed.to_string(),
    }
}

fn build_bing_web_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build Bing Translator web client: {}", e))
}

fn parse_bing_web_auth_state(page_html: &str) -> Result<BingWebAuthState, String> {
    let ig = page_html
        .split("IG:\"")
        .nth(1)
        .and_then(|value| value.split('"').next())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Failed to extract Bing Translator IG token".to_string())?
        .to_string();
    let iid = page_html
        .split("data-iid=\"")
        .nth(1)
        .and_then(|value| value.split('"').next())
        .filter(|value| value.starts_with("translator."))
        .ok_or_else(|| "Failed to extract Bing Translator IID".to_string())?
        .to_string();
    let abuse_values = page_html
        .split("params_AbusePreventionHelper = [")
        .nth(1)
        .and_then(|value| value.split(']').next())
        .ok_or_else(|| "Failed to extract Bing Translator abuse-prevention token".to_string())?;
    let mut parts = abuse_values.splitn(3, ',');
    let key = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Failed to extract Bing Translator request key".to_string())?
        .to_string();
    let token = parts
        .next()
        .map(str::trim)
        .map(|value| value.trim_matches('"'))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Failed to extract Bing Translator request token".to_string())?
        .to_string();
    let ttl_ms = parts
        .next()
        .map(str::trim)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(3_600_000);
    let refresh_ttl_ms = ttl_ms.saturating_sub(60_000).max(60_000);

    Ok(BingWebAuthState {
        ig,
        iid,
        key,
        token,
        expires_at: Instant::now() + Duration::from_millis(refresh_ttl_ms),
    })
}

fn get_bing_web_auth_state(
    client: &reqwest::blocking::Client,
    force_refresh: bool,
) -> Result<BingWebAuthState, String> {
    let cache = bing_web_auth_cache();
    if !force_refresh {
        let guard = cache
            .lock()
            .map_err(|_| "Failed to lock Bing Translator auth cache".to_string())?;
        if let Some(cached) = guard.as_ref() {
            if Instant::now() < cached.expires_at {
                return Ok(cached.clone());
            }
        }
    }

    let response = client
        .get(BING_WEB_TRANSLATOR_URL)
        .header("User-Agent", BING_WEB_USER_AGENT)
        .send()
        .map_err(|e| format!("Failed to load Bing Translator webpage: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "Failed to load Bing Translator webpage with {}: {}",
            status, body
        ));
    }

    let page_html = response
        .text()
        .map_err(|e| format!("Failed to read Bing Translator webpage: {}", e))?;
    let auth_state = parse_bing_web_auth_state(&page_html)?;

    let mut guard = cache
        .lock()
        .map_err(|_| "Failed to lock Bing Translator auth cache".to_string())?;
    *guard = Some(auth_state.clone());

    Ok(auth_state)
}

fn send_bing_web_translate_request(
    client: &reqwest::blocking::Client,
    text: &str,
    target_language: &str,
    auth_state: &BingWebAuthState,
) -> Result<(String, String), String> {
    let normalized_target_language = normalize_bing_web_language_code(target_language);
    let response = client
        .post(BING_WEB_TRANSLATE_ENDPOINT)
        .query(&[
            ("isVertical", "1"),
            ("IG", auth_state.ig.as_str()),
            ("IID", auth_state.iid.as_str()),
            ("SFX", "0"),
        ])
        .header("User-Agent", BING_WEB_USER_AGENT)
        .header("Origin", "https://www.bing.com")
        .header("Referer", BING_WEB_TRANSLATOR_URL)
        .form(&[
            ("fromLang", "auto-detect"),
            ("to", normalized_target_language.as_str()),
            ("text", text),
            ("tryFetchingGenderDebiasedTranslations", "true"),
            ("token", auth_state.token.as_str()),
            ("key", auth_state.key.as_str()),
        ])
        .send()
        .map_err(|e| format!("Bing Translator web request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "Bing Translator web request failed with {}: {}",
            status, body
        ));
    }

    let raw_body = response
        .text()
        .map_err(|e| format!("Failed to read Bing Translator web response: {}", e))?;

    if let Ok(error_payload) = serde_json::from_str::<BingWebTranslateErrorResponse>(&raw_body) {
        if error_payload.status_code.unwrap_or_default() >= 400 {
            return Err(format!(
                "Bing Translator web request was rejected with {}: {}",
                error_payload.status_code.unwrap_or_default(),
                error_payload.error_message.unwrap_or_default()
            ));
        }
    }

    let payload: Vec<BingWebTranslateResponseItem> = serde_json::from_str(&raw_body)
        .map_err(|e| format!("Failed to parse Bing Translator web response: {}", e))?;

    let first_item = payload
        .first()
        .ok_or_else(|| "Bing Translator web response was empty".to_string())?;
    let translation = first_item
        .translations
        .first()
        .map(|item| item.text.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Bing Translator web response was empty".to_string())?;
    let source_language_hint = first_item
        .detected_language
        .as_ref()
        .map(|value| value.language.clone())
        .unwrap_or_else(|| "unknown".to_string());

    Ok((translation, source_language_hint))
}

fn bing_web_translate_text(text: &str, target_language: &str) -> Result<(String, String), String> {
    let client = build_bing_web_http_client()?;

    for force_refresh in [false, true] {
        let auth_state = get_bing_web_auth_state(&client, force_refresh)?;
        match send_bing_web_translate_request(&client, text, target_language, &auth_state) {
            Ok(result) => return Ok(result),
            Err(_) if !force_refresh => continue,
            Err(error) => return Err(error),
        }
    }

    Err("Bing Translator web request failed".to_string())
}

fn quote_markdown_block(text: &str) -> String {
    let mut quoted_lines = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            quoted_lines.push(">".to_string());
        } else {
            quoted_lines.push(format!("> {}", line));
        }
    }
    quoted_lines.join("\n")
}

fn render_annotations_markdown(document: &SavedPdfAnnotationsDocument) -> String {
    let mut pages: Vec<(u16, &SavedPdfPageAnnotations)> = document
        .pages
        .iter()
        .filter_map(|(key, value)| key.parse::<u16>().ok().map(|page_idx| (page_idx, value)))
        .collect();
    pages.sort_by_key(|(page_idx, _)| *page_idx);

    let mut sections = Vec::new();

    for (page_idx, page_annotations) in pages {
        let mut blocks = Vec::new();

        let mut text_annotations = page_annotations.text_annotations.clone();
        text_annotations.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));

        for annotation in text_annotations {
            let text = annotation.text.trim();
            if text.is_empty() {
                continue;
            }
            blocks.push(quote_markdown_block(text));
        }

        let highlight_count = page_annotations
            .paths
            .iter()
            .filter(|path| path.tool == "highlight")
            .count();
        let ink_count = page_annotations
            .paths
            .iter()
            .filter(|path| path.tool != "highlight")
            .count();

        if highlight_count > 0 {
            blocks.push(format!(
                "- {} highlight {}",
                highlight_count,
                if highlight_count == 1 {
                    "stroke"
                } else {
                    "strokes"
                }
            ));
        }

        if ink_count > 0 {
            blocks.push(format!(
                "- {} ink {}",
                ink_count,
                if ink_count == 1 { "stroke" } else { "strokes" }
            ));
        }

        if !blocks.is_empty() {
            sections.push(format!(
                "### Annotations on Page {}\n\n{}",
                page_idx + 1,
                blocks.join("\n\n")
            ));
        }
    }

    sections.join("\n\n")
}

fn normalize_digest_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn truncate_digest_text(text: &str, max_chars: usize) -> String {
    let mut truncated = String::new();
    let mut count = 0;

    for ch in text.chars() {
        if count >= max_chars {
            break;
        }
        truncated.push(ch);
        count += 1;
    }

    if text.chars().count() > max_chars {
        truncated.push('…');
    }

    truncated
}

fn annotation_contains_any(text: &str, keywords: &[&str]) -> bool {
    keywords.iter().any(|keyword| text.contains(keyword))
}

fn classify_digest_candidate(text: &str) -> (&'static str, &'static str) {
    let lowered = text.to_lowercase();

    if lowered.contains('?')
        || annotation_contains_any(
            &lowered,
            &["why", "todo", "verify", "check", "unclear", "question"],
        )
        || annotation_contains_any(
            text,
            &["？", "待验证", "存疑", "为什么", "需要确认", "待查"],
        )
    {
        return (
            "questions",
            "Contains an explicit question or follow-up marker.",
        );
    }

    if annotation_contains_any(
        &lowered,
        &[
            "limitation",
            "weakness",
            "future work",
            "trade-off",
            "however",
            "but ",
        ],
    ) || annotation_contains_any(
        text,
        &["局限", "不足", "问题", "缺点", "未来工作", "但是", "然而"],
    ) {
        return (
            "limitations",
            "Mentions a caveat, weakness, or future-work concern.",
        );
    }

    if annotation_contains_any(
        &lowered,
        &[
            "method",
            "model",
            "dataset",
            "training",
            "baseline",
            "ablation",
            "architecture",
            "parameter",
        ],
    ) || annotation_contains_any(
        text,
        &[
            "方法",
            "模型",
            "数据集",
            "训练",
            "基线",
            "消融",
            "结构",
            "参数",
            "实验设置",
        ],
    ) {
        return (
            "methods",
            "Looks like a method, setup, or implementation detail.",
        );
    }

    if text.chars().any(|ch| ch.is_ascii_digit())
        || annotation_contains_any(
            &lowered,
            &["%", "acc", "f1", "bleu", "auc", "p=", "±", "table", "fig"],
        )
        || annotation_contains_any(
            text,
            &["结果", "提升", "下降", "百分点", "表", "图", "实验"],
        )
    {
        return (
            "data",
            "Includes numbers, metrics, or result-oriented wording.",
        );
    }

    let long_enough = text.split_whitespace().count() >= 10 || text.chars().count() >= 24;
    if long_enough
        && (annotation_contains_any(
            &lowered,
            &["we ", "this paper", "show", "find", "propose", "conclude"],
        ) || annotation_contains_any(text, &["本文", "提出", "发现", "表明", "说明", "结论"]))
    {
        return (
            "quotes",
            "Reads like a reusable sentence worth citing or paraphrasing.",
        );
    }

    ("core", "Captured as a general key point.")
}

fn build_digest_candidates(document: &SavedPdfAnnotationsDocument) -> Vec<DigestCandidate> {
    let mut pages: Vec<(u16, &SavedPdfPageAnnotations)> = document
        .pages
        .iter()
        .filter_map(|(key, value)| key.parse::<u16>().ok().map(|page_idx| (page_idx, value)))
        .collect();
    pages.sort_by_key(|(page_idx, _)| *page_idx);

    let mut candidates = Vec::new();

    for (page_idx, page_annotations) in pages {
        let mut text_annotations = page_annotations.text_annotations.clone();
        text_annotations.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));

        for annotation in text_annotations {
            let normalized = normalize_digest_text(&annotation.text);
            if normalized.is_empty() {
                continue;
            }

            let (category, reason) = classify_digest_candidate(&normalized);
            candidates.push(DigestCandidate {
                page: page_idx + 1,
                text: normalized,
                category,
                reason,
            });
        }
    }

    candidates
}

fn summarize_digest_section(title: &str, entries: &[AiDigestEntry]) -> String {
    match entries.len() {
        0 => format!("No {} were detected.", title.to_lowercase()),
        1 => format!(
            "1 {} extracted from the current annotations.",
            title.to_lowercase()
        ),
        count => format!(
            "{} {} extracted from the current annotations.",
            count,
            title.to_lowercase()
        ),
    }
}

fn render_ai_annotation_digest_markdown(digest: &AiAnnotationDigest) -> String {
    let mut blocks = vec![
        "# AI Annotation Digest".to_string(),
        String::new(),
        digest.overview.clone(),
        String::new(),
        format!("> Coverage: {}", digest.coverage_note),
        format!("> Limits: {}", digest.limitations),
        String::new(),
        format!(
            "- Source stats: {} text annotations, {} highlight strokes, {} ink strokes",
            digest.stats.text_annotations, digest.stats.highlight_strokes, digest.stats.ink_strokes
        ),
    ];

    for section in &digest.sections {
        if section.entries.is_empty() {
            continue;
        }

        blocks.push(String::new());
        blocks.push(format!("## {}", section.title));
        blocks.push(String::new());
        blocks.push(section.summary.clone());

        for entry in &section.entries {
            blocks.push(format!(
                "- p.{}: {} _({})_",
                entry.page, entry.text, entry.reason
            ));
        }
    }

    blocks.join("\n")
}

fn build_ai_annotation_digest(document: &SavedPdfAnnotationsDocument) -> AiAnnotationDigest {
    let candidates = build_digest_candidates(document);
    let highlight_strokes = document
        .pages
        .values()
        .flat_map(|page| page.paths.iter())
        .filter(|path| path.tool == "highlight")
        .count();
    let ink_strokes = document
        .pages
        .values()
        .flat_map(|page| page.paths.iter())
        .filter(|path| path.tool != "highlight")
        .count();

    let stats = AiAnnotationDigestStats {
        text_annotations: candidates.len(),
        highlight_strokes,
        ink_strokes,
    };

    let mut sections = vec![
        ("core", "Core Points"),
        ("methods", "Method Details"),
        ("data", "Key Data"),
        ("questions", "Open Questions"),
        ("quotes", "Reusable Quotes"),
        ("limitations", "Limitations"),
    ]
    .into_iter()
    .map(|(id, title)| AiDigestSection {
        id: id.to_string(),
        title: title.to_string(),
        summary: String::new(),
        entries: Vec::new(),
    })
    .collect::<Vec<_>>();

    for candidate in candidates {
        if let Some(section) = sections
            .iter_mut()
            .find(|section| section.id == candidate.category)
        {
            section.entries.push(AiDigestEntry {
                page: candidate.page,
                text: truncate_digest_text(&candidate.text, 180),
                reason: candidate.reason.to_string(),
            });
        }
    }

    if sections.iter().all(|section| section.entries.is_empty()) {
        sections[0].summary = "No text annotations are available to summarize yet.".to_string();
    } else {
        for section in &mut sections {
            section.summary = summarize_digest_section(&section.title, &section.entries);
        }
    }

    let overview = if stats.text_annotations == 0
        && stats.highlight_strokes == 0
        && stats.ink_strokes == 0
    {
        "No saved annotations are available yet, so an AI digest cannot be generated.".to_string()
    } else if stats.text_annotations == 0 {
        format!(
            "This paper already has {} highlight strokes and {} ink strokes, but no text annotations. The current digest is therefore limited to annotation activity statistics.",
            stats.highlight_strokes, stats.ink_strokes
        )
    } else {
        format!(
            "Generated a structured digest from {} text annotations, with {} highlight strokes and {} ink strokes as supporting activity signals.",
            stats.text_annotations, stats.highlight_strokes, stats.ink_strokes
        )
    };

    let coverage_note = if stats.text_annotations > 0 {
        "Only saved text annotations are semantically classified. Highlight and ink strokes are counted but cannot yet be mapped back to quoted source text.".to_string()
    } else {
        "No saved text annotations were found, so the digest only reports annotation counts."
            .to_string()
    };

    let limitations = "This is a local rules-based digest, not an LLM summary. It does not infer meaning from raw highlight geometry or handwritten strokes.".to_string();

    let mut digest = AiAnnotationDigest {
        overview,
        coverage_note,
        limitations,
        stats,
        sections,
        markdown: String::new(),
    };

    digest.markdown = render_ai_annotation_digest_markdown(&digest);
    digest
}

#[tauri::command]
pub fn get_item_note(
    item_id: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Option<Note>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;

    let mut stmt = conn
        .prepare(
            "SELECT id, item_id, content, created_at, updated_at \
             FROM notes WHERE item_id = ?1 ORDER BY updated_at DESC LIMIT 1",
        )
        .map_err(|e| format!("Prepare error: {}", e))?;

    let mut rows = stmt
        .query_map(rusqlite::params![item_id], |row| {
            Ok(Note {
                id: row.get(0)?,
                item_id: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    if let Some(row) = rows.next() {
        row.map(Some).map_err(|e| format!("Row error: {}", e))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn upsert_item_note(
    item_id: String,
    content: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Note, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;

    let now = now_iso8601();

    // Try update existing note for this item; if none, insert a new one.
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM notes WHERE item_id = ?1 ORDER BY updated_at DESC LIMIT 1",
            rusqlite::params![&item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Query existing note failed: {}", e))?;

    let note_id = if let Some(id) = existing_id {
        conn.execute(
            "UPDATE notes SET content = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![&content, &now, &id],
        )
        .map_err(|e| format!("Failed to update note: {}", e))?;
        id
    } else {
        let new_id = format!("note-{}-{}", item_id, now);
        conn.execute(
            "INSERT INTO notes (id, item_id, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![&new_id, &item_id, &content, &now, &now],
        )
        .map_err(|e| format!("Failed to insert note: {}", e))?;
        new_id
    };

    Ok(Note {
        id: note_id.clone(),
        item_id,
        content,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub fn append_annotations_to_note(
    item_id: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Option<Note>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;

    let pdf_path = find_pdf_attachment_path(&conn, &item_id)?;

    let Some(path_str) = pdf_path else {
        return Ok(None);
    };

    let pdf_path = PathBuf::from(&path_str);
    let extracted_text = read_annotation_sidecar(&pdf_path)
        .map(|document| render_annotations_markdown(&document))
        .unwrap_or_default();

    if extracted_text.is_empty() {
        return Ok(None);
    }

    // Now get current note, or create empty if none
    let current_note: Option<String> = conn
        .query_row(
            "SELECT content FROM notes WHERE item_id = ?1 ORDER BY updated_at DESC LIMIT 1",
            rusqlite::params![&item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Query existing note failed: {}", e))?;

    let mut new_content = current_note.unwrap_or_default();
    if !new_content.is_empty() {
        if !new_content.ends_with("\n\n") {
            if !new_content.ends_with('\n') {
                new_content.push_str("\n\n");
            } else {
                new_content.push('\n');
            }
        }
        new_content.push_str("---\n\n");
    }
    new_content.push_str(&extracted_text);

    // Release the DB lock before calling the other command, or just do the upsert logics here inline
    drop(conn);

    let updated_note = upsert_item_note(item_id, new_content, state)?;
    Ok(Some(updated_note))
}

#[tauri::command]
pub fn generate_item_annotations_markdown(
    item_id: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let pdf_path = find_pdf_attachment_path(&conn, &item_id)?;
    drop(conn);

    let Some(path_str) = pdf_path else {
        return Err("No PDF attachment found for this item".to_string());
    };

    let document = read_annotation_sidecar(&PathBuf::from(&path_str)).unwrap_or_default();
    Ok(render_annotations_markdown(&document))
}

#[tauri::command]
pub fn generate_annotation_digest(
    item_id: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<AiAnnotationDigest, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let pdf_path = find_pdf_attachment_path(&conn, &item_id)?;
    drop(conn);

    let Some(path_str) = pdf_path else {
        return Err("No PDF attachment found for this item".to_string());
    };

    let document = read_annotation_sidecar(&PathBuf::from(&path_str)).unwrap_or_default();
    Ok(build_ai_annotation_digest(&document))
}

#[tauri::command]
pub fn summarize_document(
    item_id: String,
    language: Option<String>,
    force_refresh: Option<bool>,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<AiPaperSummary, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let pdf_path = find_pdf_attachment_path(&conn, &item_id)?;
    let item = fetch_item_from_db(&conn, &item_id)
        .map_err(|e| format!("Failed to load item metadata: {}", e))?
        .ok_or("Item not found")?;
    let (api_key, completion_url, model) = get_required_ai_settings(&conn)?;
    let summary_system_prompt = get_ai_summary_system_prompt(&conn)?;
    let output_language = language
        .filter(|value| !value.trim().is_empty())
        .or_else(|| get_setting_value(&conn, "aiSummaryLanguage").ok().flatten())
        .unwrap_or_else(|| "zh-CN".to_string());

    let Some(path_str) = pdf_path else {
        return Err("No PDF attachment found for this item".to_string());
    };
    let path = Path::new(&path_str);
    let prompt_key = make_summary_prompt_key(&completion_url, &summary_system_prompt, &item.title);
    let force_refresh = force_refresh.unwrap_or(false);

    if !force_refresh {
        if let Some(cached) =
            read_cached_paper_summary(&conn, &item_id, &output_language, &model, &prompt_key)?
        {
            if let Some((file_size, modified_unix_ms)) = file_signature(path) {
                if cached.file_size == file_size && cached.modified_unix_ms == modified_unix_ms {
                    return Ok(cached.summary);
                }
            } else {
                return Ok(cached.summary);
            }
        }
    }
    drop(conn);

    let extracted_text = extract_document_text_from_path(&path_str, 12, 14000)?;
    if extracted_text.trim().is_empty() {
        return Err("Could not extract readable text from this PDF".to_string());
    }

    let user_prompt = format!(
        "Read the following academic paper excerpt and respond in plain text using this exact format:\nTITLE: <short title>\nSUMMARY: <2-4 sentences>\nKEY_POINTS:\n- <point 1>\n- <point 2>\n- <point 3>\nLIMITATIONS:\n- <limitation 1>\n- <limitation 2>\n\nWrite in language: {}.\n\nPaper metadata title: {}\n\nPaper excerpt:\n{}",
        output_language,
        item.title,
        extracted_text
    );

    let content = call_openai_compatible_chat(
        &completion_url,
        &api_key,
        &model,
        &summary_system_prompt,
        &user_prompt,
    )?;

    let title = parse_tagged_output(&content, "TITLE:")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| item.title.clone());
    let summary = parse_tagged_output(&content, "SUMMARY:")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            content
                .lines()
                .take(4)
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_string()
        });

    let key_points_section = content
        .split("KEY_POINTS:")
        .nth(1)
        .and_then(|section| section.split("LIMITATIONS:").next())
        .unwrap_or("");
    let limitations_section = content.split("LIMITATIONS:").nth(1).unwrap_or("");

    let summary = AiPaperSummary {
        title,
        summary,
        key_points: parse_bullet_lines(key_points_section)
            .into_iter()
            .take(5)
            .collect(),
        limitations: parse_bullet_lines(limitations_section)
            .into_iter()
            .take(4)
            .collect(),
        language: output_language,
        source_excerpt: extracted_text.chars().take(600).collect(),
    };

    if let Some((file_size, modified_unix_ms)) = file_signature(path) {
        let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
        write_cached_paper_summary(
            &conn,
            &item_id,
            &summary.language,
            &model,
            &prompt_key,
            &CachedPaperSummaryRecord {
                file_size,
                modified_unix_ms,
                summary: AiPaperSummary {
                    title: summary.title.clone(),
                    summary: summary.summary.clone(),
                    key_points: summary.key_points.clone(),
                    limitations: summary.limitations.clone(),
                    language: summary.language.clone(),
                    source_excerpt: summary.source_excerpt.clone(),
                },
                updated_at: now_iso8601(),
            },
        )?;
    }

    Ok(summary)
}

#[tauri::command]
pub fn translate_selection(
    text: String,
    target_language: Option<String>,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<AiTranslationResult, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("No text selected".to_string());
    }

    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let translate_engine = get_setting_value(&conn, "aiTranslateEngine")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "google".to_string());
    let resolved_target_language = target_language
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            get_setting_value(&conn, "aiTranslateTargetLanguage")
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| "zh-CN".to_string());
    let translate_engine = translate_engine.trim().to_lowercase();

    let (translation, source_language_hint) = match translate_engine.as_str() {
        "llm" => {
            let (api_key, completion_url, model) = get_required_ai_settings(&conn)?;
            let system_prompt = get_ai_translate_system_prompt(&conn)?;
            drop(conn);

            let user_prompt = format!(
                "Translate the following paper excerpt into {}. Preserve technical meaning and notation. Selected text:\n{}",
                resolved_target_language,
                trimmed
            );

            let content = call_openai_compatible_chat(
                &completion_url,
                &api_key,
                &model,
                &system_prompt,
                &user_prompt,
            )?;

            let source_language_hint = parse_tagged_output(&content, "SOURCE_LANGUAGE_HINT:")
                .unwrap_or_else(|| "unknown".to_string());

            let translation = content
                .lines()
                .filter(|line| !line.trim_start().starts_with("SOURCE_LANGUAGE_HINT:"))
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();

            if translation.is_empty() {
                return Err("AI translation response was empty".to_string());
            }

            (translation, source_language_hint)
        }
        "bing" => {
            drop(conn);
            bing_web_translate_text(trimmed, &resolved_target_language)?
        }
        _ => {
            drop(conn);
            google_translate_text(trimmed, &resolved_target_language)?
        }
    };

    Ok(AiTranslationResult {
        translation,
        source_language_hint,
        target_language: resolved_target_language,
        original_text: trimmed.to_string(),
    })
}

// ─────────────────────────────────────────────────────────────
// Tag Management Commands
// ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct TagInfo {
    pub tag: String,
    pub count: i64,
    pub color: String,
}

const MODERN_TAG_COLORS: [&str; 20] = [
    "#94a3b8", "#9ca3af", "#a1a1aa", "#818cf8", "#a78bfa", "#c4b5fd", "#93c5fd", "#7dd3fc",
    "#67e8f9", "#5eead4", "#6ee7b7", "#86efac", "#bef264", "#fde68a", "#fdba74", "#fca5a5",
    "#f9a8d4", "#f0abfc", "#d8b4fe", "#cbd5e1",
];

fn pick_modern_tag_color(tag: &str) -> &'static str {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut hasher = DefaultHasher::new();
    tag.to_lowercase().hash(&mut hasher);
    let now_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    now_nanos.hash(&mut hasher);

    let idx = (hasher.finish() as usize) % MODERN_TAG_COLORS.len();
    MODERN_TAG_COLORS[idx]
}

pub(crate) fn ensure_tag_color_for_tag(
    conn: &rusqlite::Connection,
    tag: &str,
) -> Result<(), String> {
    let trimmed = tag.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let color = pick_modern_tag_color(trimmed);
    conn.execute(
        "INSERT OR IGNORE INTO tag_colors (tag, color) VALUES (?1, ?2)",
        rusqlite::params![trimmed, color],
    )
    .map_err(|e| format!("Failed to ensure tag color: {}", e))?;

    Ok(())
}

/// Return every tag in the library, with usage count and assigned color.
#[tauri::command]
pub fn get_all_tags(
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<TagInfo>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let mut stmt = conn
        .prepare(
            "SELECT it.tag, COUNT(*) AS cnt, COALESCE(tc.color, '') AS color \
         FROM item_tags it \
         LEFT JOIN tag_colors tc ON LOWER(it.tag) = LOWER(tc.tag) \
         GROUP BY it.tag \
         ORDER BY cnt DESC, it.tag ASC",
        )
        .map_err(|e| format!("Prepare error: {}", e))?;

    let tags: Vec<TagInfo> = stmt
        .query_map([], |row| {
            Ok(TagInfo {
                tag: row.get(0)?,
                count: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(tags)
}

/// Add a single tag to an item (idempotent).
#[tauri::command]
pub fn add_item_tag(
    item_id: String,
    tag: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<(), String> {
    let tag = tag.trim().to_string();
    if tag.is_empty() {
        return Err("Tag name cannot be empty".to_string());
    }
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    conn.execute(
        "INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?1, ?2)",
        rusqlite::params![item_id, tag],
    )
    .map_err(|e| format!("Failed to add tag: {}", e))?;
    ensure_tag_color_for_tag(&conn, &tag)?;
    Ok(())
}

/// Remove a single tag from an item.
#[tauri::command]
pub fn remove_item_tag(
    item_id: String,
    tag: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    conn.execute(
        "DELETE FROM item_tags WHERE item_id = ?1 AND tag = ?2",
        rusqlite::params![item_id, tag],
    )
    .map_err(|e| format!("Failed to remove tag: {}", e))?;
    Ok(())
}

/// Replace all tags for an item atomically.
#[tauri::command]
pub fn update_item_tags(
    item_id: String,
    tags: Vec<String>,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    conn.execute(
        "DELETE FROM item_tags WHERE item_id = ?1",
        rusqlite::params![item_id],
    )
    .map_err(|e| format!("Failed to clear tags: {}", e))?;
    for tag in &tags {
        let t = tag.trim();
        if !t.is_empty() {
            conn.execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?1, ?2)",
                rusqlite::params![item_id, t],
            )
            .map_err(|e| format!("Failed to insert tag: {}", e))?;
            ensure_tag_color_for_tag(&conn, t)?;
        }
    }
    Ok(())
}

/// Persist a display color for a tag (upsert).
#[tauri::command]
pub fn set_tag_color(
    tag: String,
    color: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    conn.execute(
        "INSERT INTO tag_colors (tag, color) VALUES (?1, ?2) \
         ON CONFLICT(tag) DO UPDATE SET color = excluded.color",
        rusqlite::params![tag, color],
    )
    .map_err(|e| format!("Failed to set tag color: {}", e))?;
    Ok(())
}

// ── Citation / Export ────────────────────────────────────────────────────────

/// Citation data row (lighter than the full LibraryItem)
pub struct CitationData {
    pub id: String,
    pub item_type: String,
    pub title: String,
    pub authors: String,
    pub year: String,
    pub publication: String,
    pub volume: String,
    pub issue: String,
    pub pages: String,
    pub publisher: String,
    pub doi: String,
    pub arxiv_id: String,
    pub url: String,
    pub isbn: String,
}

pub fn fetch_citation_data(
    conn: &rusqlite::Connection,
    item_id: &str,
) -> Result<CitationData, String> {
    conn.query_row(
        "SELECT id, item_type, title, authors, year, publication, volume, issue, pages,
                publisher, doi, arxiv_id, url, isbn
         FROM items WHERE id = ?1",
        rusqlite::params![item_id],
        |r| {
            Ok(CitationData {
                id: r.get::<_, String>(0).unwrap_or_default(),
                item_type: r.get::<_, String>(1).unwrap_or_default(),
                title: r.get::<_, String>(2).unwrap_or_default(),
                authors: r.get::<_, String>(3).unwrap_or_default(),
                year: r.get::<_, String>(4).unwrap_or_default(),
                publication: r.get::<_, String>(5).unwrap_or_default(),
                volume: r.get::<_, String>(6).unwrap_or_default(),
                issue: r.get::<_, String>(7).unwrap_or_default(),
                pages: r.get::<_, String>(8).unwrap_or_default(),
                publisher: r.get::<_, String>(9).unwrap_or_default(),
                doi: r.get::<_, String>(10).unwrap_or_default(),
                arxiv_id: r.get::<_, String>(11).unwrap_or_default(),
                url: r.get::<_, String>(12).unwrap_or_default(),
                isbn: r.get::<_, String>(13).unwrap_or_default(),
            })
        },
    )
    .map_err(|e| format!("Item not found: {}", e))
}

/// Split a comma-separated author string into a Vec of individual name strings.
fn split_authors(raw: &str) -> Vec<String> {
    if raw.trim().is_empty() || raw.trim() == "—" {
        return vec![];
    }
    raw.split(',')
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect()
}

/// Best-effort: given a full name like "Jane Smith" or "Smith Jane",
/// return ("Smith", "J.") for APA initials. Falls back to (name, "").
fn name_to_last_initials(name: &str) -> (String, String) {
    let parts: Vec<&str> = name.split_whitespace().collect();
    match parts.len() {
        0 => (String::new(), String::new()),
        1 => (parts[0].to_string(), String::new()),
        _ => {
            // Heuristic: last word is family name
            let last = parts.last().unwrap().to_string();
            let initials: String = parts[..parts.len() - 1]
                .iter()
                .map(|p| {
                    format!(
                        "{}.",
                        p.chars()
                            .next()
                            .unwrap_or(' ')
                            .to_uppercase()
                            .next()
                            .unwrap_or(' ')
                    )
                })
                .collect::<Vec<_>>()
                .join(" ");
            (last, initials)
        }
    }
}

/// Format a DOI as a URL suffix segment.
fn doi_url(doi: &str) -> String {
    if doi.is_empty() {
        return String::new();
    }
    format!("https://doi.org/{}", doi)
}

// ── Format-specific generators ───────────────────────────────────────────────

fn format_apa(item: &CitationData) -> String {
    // APA 7th: Authors (Year). Title. Journal, Volume(Issue), Pages. https://doi.org/…
    let authors_list = split_authors(&item.authors);
    let apa_authors = if authors_list.is_empty() {
        String::from("Unknown Author")
    } else {
        let formatted: Vec<String> = authors_list
            .iter()
            .map(|a| {
                let (last, initials) = name_to_last_initials(a);
                if initials.is_empty() {
                    last
                } else {
                    format!("{}, {}", last, initials)
                }
            })
            .collect();
        let n = formatted.len();
        if n == 1 {
            formatted[0].clone()
        } else {
            format!("{}, & {}", formatted[..n - 1].join(", "), formatted[n - 1])
        }
    };

    let year = if item.year.is_empty() {
        "n.d.".to_string()
    } else {
        format!("({})", item.year)
    };

    let mut source_parts: Vec<String> = Vec::new();
    if !item.publication.is_empty() {
        let mut pub_str = format!("*{}*", item.publication);
        if !item.volume.is_empty() {
            pub_str.push_str(&format!(", *{}*", item.volume));
            if !item.issue.is_empty() {
                pub_str.push_str(&format!("({})", item.issue));
            }
        }
        if !item.pages.is_empty() {
            pub_str.push_str(&format!(", {}", item.pages));
        }
        source_parts.push(pub_str);
    } else if !item.publisher.is_empty() {
        source_parts.push(item.publisher.clone());
    }

    let doi_part = doi_url(&item.doi);

    let mut out = format!("{} {}. {}.", apa_authors, year, item.title);
    if !source_parts.is_empty() {
        out.push(' ');
        out.push_str(&source_parts.join(". "));
        out.push('.');
    }
    if !doi_part.is_empty() {
        out.push(' ');
        out.push_str(&doi_part);
    } else if !item.url.is_empty() {
        out.push(' ');
        out.push_str(&item.url);
    }
    out
}

fn format_mla(item: &CitationData) -> String {
    // MLA 9th: Last, First, et al. "Title." Journal, vol. V, no. I, Year, pp. P, doi:DOI.
    let authors_list = split_authors(&item.authors);
    let mla_authors = match authors_list.len() {
        0 => "Unknown Author".to_string(),
        1 => {
            let (last, initials) = name_to_last_initials(&authors_list[0]);
            if initials.is_empty() {
                last
            } else {
                let first = authors_list[0]
                    .split_whitespace()
                    .take(authors_list[0].split_whitespace().count().saturating_sub(1))
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("{}, {}", last, first)
            }
        }
        2 => {
            let (l0, _) = name_to_last_initials(&authors_list[0]);
            let first0 = authors_list[0]
                .split_whitespace()
                .take(authors_list[0].split_whitespace().count().saturating_sub(1))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{}, {}, and {}", l0, first0, authors_list[1])
        }
        _ => {
            let (l0, _) = name_to_last_initials(&authors_list[0]);
            let first0 = authors_list[0]
                .split_whitespace()
                .take(authors_list[0].split_whitespace().count().saturating_sub(1))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{}, {}, et al.", l0, first0)
        }
    };

    let mut out = format!("{}. \"{}.", mla_authors, item.title);
    if !item.publication.is_empty() {
        out.push_str(&format!("\" *{}*", item.publication));
        if !item.volume.is_empty() {
            out.push_str(&format!(", vol. {}", item.volume));
        }
        if !item.issue.is_empty() {
            out.push_str(&format!(", no. {}", item.issue));
        }
        if !item.year.is_empty() {
            out.push_str(&format!(", {}", item.year));
        }
        if !item.pages.is_empty() {
            out.push_str(&format!(", pp. {}", item.pages));
        }
        if !item.doi.is_empty() {
            out.push_str(&format!(", doi:{}", item.doi));
        }
        out.push('.');
    } else {
        if !item.publisher.is_empty() {
            out.push_str(&format!("\" {}", item.publisher));
        }
        if !item.year.is_empty() {
            out.push_str(&format!(", {}", item.year));
        }
        out.push('.');
    }
    out
}

fn format_chicago(item: &CitationData) -> String {
    // Chicago 17th author-date: Authors. "Title." Journal Volume, no. Issue (Year): Pages. DOI.
    let authors_list = split_authors(&item.authors);
    let chicago_authors = if authors_list.is_empty() {
        "Unknown Author".to_string()
    } else {
        authors_list.join(", ")
    };

    let mut out = format!("{}. \"{}.", chicago_authors, item.title);
    if !item.publication.is_empty() {
        out.push_str(&format!("\" *{}*", item.publication));
        if !item.volume.is_empty() {
            out.push_str(&format!(" {}", item.volume));
        }
        if !item.issue.is_empty() {
            out.push_str(&format!(", no. {}", item.issue));
        }
        if !item.year.is_empty() {
            out.push_str(&format!(" ({})", item.year));
        }
        if !item.pages.is_empty() {
            out.push_str(&format!(": {}", item.pages));
        }
        out.push('.');
    } else {
        if !item.publisher.is_empty() {
            out.push_str(&format!("\" {}", item.publisher));
        }
        if !item.year.is_empty() {
            out.push_str(&format!(", {}", item.year));
        }
        out.push('.');
    }
    if !item.doi.is_empty() {
        out.push(' ');
        out.push_str(&doi_url(&item.doi));
        out.push('.');
    }
    out
}

fn format_gbt(item: &CitationData) -> String {
    // GB/T 7714-2015: Authors. Title[J]. Journal, Year, Volume(Issue): Pages. DOI.
    let authors_list = split_authors(&item.authors);
    let gbt_authors = if authors_list.is_empty() {
        String::new()
    } else {
        authors_list.join(", ")
    };

    let type_mark = match item.item_type.as_str() {
        "book" => "[M]",
        "thesis" => "[D]",
        "conference" => "[C]",
        _ => "[J]",
    };

    let mut out = if gbt_authors.is_empty() {
        format!("{}{}", item.title, type_mark)
    } else {
        format!("{}. {}{}", gbt_authors, item.title, type_mark)
    };

    if !item.publication.is_empty() {
        out.push_str(&format!(". {}", item.publication));
        if !item.year.is_empty() {
            out.push_str(&format!(", {}", item.year));
        }
        if !item.volume.is_empty() {
            out.push_str(&format!(", {}", item.volume));
            if !item.issue.is_empty() {
                out.push_str(&format!("({})", item.issue));
            }
        }
        if !item.pages.is_empty() {
            out.push_str(&format!(": {}", item.pages));
        }
        out.push('.');
    } else if !item.publisher.is_empty() {
        out.push_str(&format!(". {}", item.publisher));
        if !item.year.is_empty() {
            out.push_str(&format!(", {}", item.year));
        }
        out.push('.');
    }

    if !item.doi.is_empty() {
        out.push_str(&format!(" DOI: {}", item.doi));
    }
    out
}

fn format_bibtex(item: &CitationData) -> String {
    // Generate a cite key from first-author-last + year
    let first_author = split_authors(&item.authors)
        .into_iter()
        .next()
        .unwrap_or_default();
    let (last, _) = name_to_last_initials(&first_author);
    let key_last = last
        .to_lowercase()
        .replace(' ', "")
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>();
    let key_year = if item.year.is_empty() {
        "nd".to_string()
    } else {
        item.year.clone()
    };
    let cite_key = if key_last.is_empty() {
        format!("item{}", key_year)
    } else {
        format!("{}{}", key_last, key_year)
    };

    let entry_type = match item.item_type.as_str() {
        "book" => "book",
        "thesis" => "phdthesis",
        "conference" => "inproceedings",
        _ => "article",
    };

    let journal_field = if entry_type == "article" {
        "journal"
    } else {
        "booktitle"
    };

    // BibTeX author: join with " and "
    let bibtex_authors = split_authors(&item.authors).join(" and ");

    let mut fields: Vec<String> = Vec::new();
    if !item.title.is_empty() {
        fields.push(format!("  title     = {{{}}}", item.title));
    }
    if !bibtex_authors.is_empty() {
        fields.push(format!("  author    = {{{}}}", bibtex_authors));
    }
    if !item.publication.is_empty() {
        fields.push(format!("  {}   = {{{}}}", journal_field, item.publication));
    }
    if !item.year.is_empty() {
        fields.push(format!("  year      = {{{}}}", item.year));
    }
    if !item.volume.is_empty() {
        fields.push(format!("  volume    = {{{}}}", item.volume));
    }
    if !item.issue.is_empty() {
        fields.push(format!("  number    = {{{}}}", item.issue));
    }
    if !item.pages.is_empty() {
        fields.push(format!("  pages     = {{{}}}", item.pages));
    }
    if !item.publisher.is_empty() {
        fields.push(format!("  publisher = {{{}}}", item.publisher));
    }
    if !item.doi.is_empty() {
        fields.push(format!("  doi       = {{{}}}", item.doi));
    }
    if !item.arxiv_id.is_empty() {
        fields.push(format!("  eprint    = {{{}}}", item.arxiv_id));
    }
    if !item.isbn.is_empty() {
        fields.push(format!("  isbn      = {{{}}}", item.isbn));
    }
    if !item.url.is_empty() {
        fields.push(format!("  url       = {{{}}}", item.url));
    }

    format!("@{}{{{},\n{}\n}}", entry_type, cite_key, fields.join(",\n"))
}

fn format_ris(item: &CitationData) -> String {
    let ty = match item.item_type.as_str() {
        "book" => "BOOK",
        "thesis" => "THES",
        "conference" => "CONF",
        _ => "JOUR",
    };

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("TY  - {}", ty));
    if !item.title.is_empty() {
        lines.push(format!("TI  - {}", item.title));
    }
    for author in split_authors(&item.authors) {
        lines.push(format!("AU  - {}", author));
    }
    if !item.year.is_empty() {
        lines.push(format!("PY  - {}", item.year));
    }
    if !item.publication.is_empty() {
        lines.push(format!("JO  - {}", item.publication));
    }
    if !item.volume.is_empty() {
        lines.push(format!("VL  - {}", item.volume));
    }
    if !item.issue.is_empty() {
        lines.push(format!("IS  - {}", item.issue));
    }
    if !item.pages.is_empty() {
        let ps: Vec<&str> = item.pages.splitn(2, '-').collect();
        lines.push(format!("SP  - {}", ps[0].trim()));
        if ps.len() > 1 {
            lines.push(format!("EP  - {}", ps[1].trim()));
        }
    }
    if !item.publisher.is_empty() {
        lines.push(format!("PB  - {}", item.publisher));
    }
    if !item.doi.is_empty() {
        lines.push(format!("DO  - {}", item.doi));
    }
    if !item.isbn.is_empty() {
        lines.push(format!("SN  - {}", item.isbn));
    }
    if !item.url.is_empty() {
        lines.push(format!("UR  - {}", item.url));
    }
    lines.push("ER  - ".to_string());
    lines.join("\n")
}

fn format_csljson_one(item: &CitationData) -> String {
    // Minimal CSL-JSON for one item
    let csl_type = match item.item_type.as_str() {
        "book" => "book",
        "thesis" => "thesis",
        "conference" => "paper-conference",
        _ => "article-journal",
    };

    let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");

    let author_json: String = split_authors(&item.authors)
        .iter()
        .map(|a| {
            let (last, _) = name_to_last_initials(a);
            let first_parts: Vec<&str> = a.split_whitespace().collect();
            let given = if first_parts.len() > 1 {
                first_parts[..first_parts.len() - 1].join(" ")
            } else {
                String::new()
            };
            format!(
                "{{\"family\":\"{}\",\"given\":\"{}\"}}",
                escape(&last),
                escape(&given)
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    let mut fields: Vec<String> = Vec::new();
    fields.push(format!("\"id\":\"{}\"", escape(&item.id)));
    fields.push(format!("\"type\":\"{}\"", csl_type));
    if !item.title.is_empty() {
        fields.push(format!("\"title\":\"{}\"", escape(&item.title)));
    }
    if !author_json.is_empty() {
        fields.push(format!("\"author\":[{}]", author_json));
    }
    if !item.year.is_empty() {
        fields.push(format!("\"issued\":{{\"date-parts\":[[{}]]}}", item.year));
    }
    if !item.publication.is_empty() {
        fields.push(format!(
            "\"container-title\":\"{}\"",
            escape(&item.publication)
        ));
    }
    if !item.volume.is_empty() {
        fields.push(format!("\"volume\":\"{}\"", escape(&item.volume)));
    }
    if !item.issue.is_empty() {
        fields.push(format!("\"issue\":\"{}\"", escape(&item.issue)));
    }
    if !item.pages.is_empty() {
        fields.push(format!("\"page\":\"{}\"", escape(&item.pages)));
    }
    if !item.publisher.is_empty() {
        fields.push(format!("\"publisher\":\"{}\"", escape(&item.publisher)));
    }
    if !item.doi.is_empty() {
        fields.push(format!("\"DOI\":\"{}\"", escape(&item.doi)));
    }
    if !item.isbn.is_empty() {
        fields.push(format!("\"ISBN\":\"{}\"", escape(&item.isbn)));
    }
    if !item.url.is_empty() {
        fields.push(format!("\"URL\":\"{}\"", escape(&item.url)));
    }
    format!("{{{}}}", fields.join(","))
}

pub fn apply_format(item: &CitationData, format: &str) -> String {
    match format {
        "apa" => format_apa(item),
        "mla" => format_mla(item),
        "chicago" => format_chicago(item),
        "gbt" => format_gbt(item),
        "bibtex" => format_bibtex(item),
        "ris" => format_ris(item),
        "csljson" => format!("[{}]", format_csljson_one(item)),
        _ => format_apa(item),
    }
}

/// Generate a formatted citation string for a single library item.
#[tauri::command]
pub fn generate_citation(
    item_id: String,
    format: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let item = fetch_citation_data(&conn, &item_id)?;
    Ok(apply_format(&item, &format))
}

/// Export one or more library items in the requested format.
/// For text formats (APA/MLA/Chicago/GBT) items are joined with newlines.
/// For BibTeX/RIS entries are joined with blank lines.
/// For CSL-JSON a JSON array is returned.
/// DB-only export – usable from CLI without tauri::State.
pub fn export_items_db(
    conn: &rusqlite::Connection,
    item_ids: &[String],
    format: &str,
) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    for id in item_ids {
        match fetch_citation_data(conn, id) {
            Ok(item) => parts.push(apply_format(&item, format)),
            Err(_) => {} // skip missing items silently
        }
    }
    let sep = match format {
        "bibtex" | "ris" => "\n\n",
        _ => "\n",
    };
    if format == "csljson" {
        // Unwrap individual JSON objects and wrap in one array
        let objects: Vec<String> = parts
            .iter()
            .map(|p| p.trim_start_matches('[').trim_end_matches(']').to_string())
            .collect();
        return Ok(std::format!("[{}]", objects.join(",")));
    }
    Ok(parts.join(sep))
}

#[tauri::command]
pub fn export_items(
    item_ids: Vec<String>,
    format: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    export_items_db(&conn, &item_ids, &format)
}

// ─────────────────────────────────────────────────────────────
// Settings Commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<crate::models::Setting>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| format!("Prepare error: {}", e))?;

    let settings: Vec<crate::models::Setting> = stmt
        .query_map([], |row| {
            Ok(crate::models::Setting {
                key: row.get(0)?,
                value: row.get(1)?,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(settings)
}

#[tauri::command]
pub fn save_setting(
    key: String,
    value: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        rusqlite::params![&key, &value],
    )
    .map_err(|e| format!("Failed to save setting: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_ai_annotation_digest, build_library_item, delete_item_records,
        delete_trashed_item_records, normalize_bing_web_language_code, parse_bibtex_references,
        parse_bing_web_auth_state, parse_csljson_references, parse_ris_references,
        render_annotations_markdown, sync_item_to_db,
    };
    use crate::db::{ensure_schema, init_db_at_path};
    use crate::models::{
        SavedAnnotationPath, SavedAnnotationPoint, SavedPdfAnnotationsDocument,
        SavedPdfPageAnnotations, SavedTextAnnotation,
    };
    use rusqlite::Connection;
    use std::collections::HashMap;
    use std::fs;

    fn text_annotation(y: f32, text: &str) -> SavedTextAnnotation {
        SavedTextAnnotation {
            x: 24.0,
            y,
            text: text.to_string(),
            font_size: 13.0,
        }
    }

    fn path_annotation(tool: &str, y: f64) -> SavedAnnotationPath {
        SavedAnnotationPath {
            tool: tool.to_string(),
            points: vec![
                SavedAnnotationPoint { x: 10.0, y },
                SavedAnnotationPoint {
                    x: 20.0,
                    y: y + 3.0,
                },
            ],
        }
    }

    #[test]
    fn render_annotations_markdown_returns_empty_for_empty_document() {
        let document = SavedPdfAnnotationsDocument::default();
        assert_eq!(render_annotations_markdown(&document), "");
    }

    #[test]
    fn render_annotations_markdown_sorts_pages_and_text_annotations() {
        let mut pages = HashMap::new();
        pages.insert(
            "1".to_string(),
            SavedPdfPageAnnotations {
                paths: vec![],
                text_annotations: vec![
                    text_annotation(80.0, "Later note"),
                    text_annotation(20.0, "Earlier note\nSecond line"),
                ],
            },
        );
        pages.insert(
            "0".to_string(),
            SavedPdfPageAnnotations {
                paths: vec![],
                text_annotations: vec![text_annotation(12.0, "Intro quote")],
            },
        );

        let output =
            render_annotations_markdown(&SavedPdfAnnotationsDocument { version: 1, pages });

        let expected = "### Annotations on Page 1\n\n> Intro quote\n\n### Annotations on Page 2\n\n> Earlier note\n> Second line\n\n> Later note";
        assert_eq!(output, expected);
    }

    #[test]
    fn render_annotations_markdown_includes_highlight_and_ink_summaries() {
        let mut pages = HashMap::new();
        pages.insert(
            "2".to_string(),
            SavedPdfPageAnnotations {
                paths: vec![
                    path_annotation("highlight", 8.0),
                    path_annotation("highlight", 30.0),
                    path_annotation("draw", 42.0),
                ],
                text_annotations: vec![text_annotation(14.0, "Key takeaway")],
            },
        );

        let output =
            render_annotations_markdown(&SavedPdfAnnotationsDocument { version: 1, pages });

        let expected = "### Annotations on Page 3\n\n> Key takeaway\n\n- 2 highlight strokes\n\n- 1 ink stroke";
        assert_eq!(output, expected);
    }

    #[test]
    fn render_annotations_markdown_skips_empty_pages_and_is_stable_across_pages() {
        let mut pages = HashMap::new();
        pages.insert("4".to_string(), SavedPdfPageAnnotations::default());
        pages.insert(
            "1".to_string(),
            SavedPdfPageAnnotations {
                paths: vec![path_annotation("draw", 12.0)],
                text_annotations: vec![],
            },
        );
        pages.insert(
            "3".to_string(),
            SavedPdfPageAnnotations {
                paths: vec![],
                text_annotations: vec![text_annotation(16.0, "Final page note")],
            },
        );

        let output =
            render_annotations_markdown(&SavedPdfAnnotationsDocument { version: 1, pages });

        let expected = "### Annotations on Page 2\n\n- 1 ink stroke\n\n### Annotations on Page 4\n\n> Final page note";
        assert_eq!(output, expected);
    }

    #[test]
    fn build_ai_annotation_digest_classifies_text_annotations_into_sections() {
        let mut pages = HashMap::new();
        pages.insert(
            "0".to_string(),
            SavedPdfPageAnnotations {
                paths: vec![
                    path_annotation("highlight", 10.0),
                    path_annotation("draw", 20.0),
                ],
                text_annotations: vec![
                    text_annotation(10.0, "Why does the baseline collapse on small datasets?"),
                    text_annotation(20.0, "Accuracy improves from 82.1% to 88.4% on test split."),
                    text_annotation(
                        30.0,
                        "The method uses a two-stage training schedule with 3 ablations.",
                    ),
                    text_annotation(
                        40.0,
                        "The paper notes a limitation in cross-domain generalization.",
                    ),
                ],
            },
        );

        let digest = build_ai_annotation_digest(&SavedPdfAnnotationsDocument { version: 1, pages });

        assert_eq!(digest.stats.text_annotations, 4);
        assert_eq!(digest.stats.highlight_strokes, 1);
        assert_eq!(digest.stats.ink_strokes, 1);
        assert!(digest.markdown.contains("# AI Annotation Digest"));

        let questions = digest
            .sections
            .iter()
            .find(|section| section.id == "questions")
            .unwrap();
        assert_eq!(questions.entries.len(), 1);
        assert_eq!(questions.entries[0].page, 1);

        let data = digest
            .sections
            .iter()
            .find(|section| section.id == "data")
            .unwrap();
        assert_eq!(data.entries.len(), 1);

        let methods = digest
            .sections
            .iter()
            .find(|section| section.id == "methods")
            .unwrap();
        assert_eq!(methods.entries.len(), 1);

        let limitations = digest
            .sections
            .iter()
            .find(|section| section.id == "limitations")
            .unwrap();
        assert_eq!(limitations.entries.len(), 1);
    }

    #[test]
    fn build_ai_annotation_digest_reports_limits_without_text_annotations() {
        let mut pages = HashMap::new();
        pages.insert(
            "1".to_string(),
            SavedPdfPageAnnotations {
                paths: vec![
                    path_annotation("highlight", 10.0),
                    path_annotation("draw", 20.0),
                ],
                text_annotations: vec![],
            },
        );

        let digest = build_ai_annotation_digest(&SavedPdfAnnotationsDocument { version: 1, pages });

        assert_eq!(digest.stats.text_annotations, 0);
        assert!(digest
            .coverage_note
            .contains("No saved text annotations were found"));
        assert!(digest.overview.contains("no text annotations"));
    }

    #[test]
    fn parse_bibtex_references_extracts_core_fields() {
        let content = r#"
@article{attention2017,
  title = {Attention Is All You Need},
  author = {Ashish Vaswani and Noam Shazeer},
  year = {2017},
  journal = {NeurIPS},
  doi = {10.48550/arXiv.1706.03762},
  keywords = {transformer; attention}
}
"#;

        let items = parse_bibtex_references(content).expect("bibtex should parse");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Attention Is All You Need");
        assert_eq!(items[0].authors, "Ashish Vaswani, Noam Shazeer");
        assert_eq!(items[0].publication, "NeurIPS");
        assert_eq!(items[0].tags, vec!["transformer", "attention"]);
    }

    #[test]
    fn parse_ris_references_extracts_core_fields() {
        let content = "\
TY  - JOUR\n\
TI  - Attention Is All You Need\n\
AU  - Vaswani, Ashish\n\
AU  - Shazeer, Noam\n\
PY  - 2017/06/12\n\
JO  - NeurIPS\n\
DO  - 10.48550/arXiv.1706.03762\n\
KW  - transformer\n\
KW  - attention\n\
ER  -\n";

        let items = parse_ris_references(content).expect("ris should parse");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].year, "2017");
        assert_eq!(items[0].publication, "NeurIPS");
        assert_eq!(items[0].tags, vec!["transformer", "attention"]);
    }

    #[test]
    fn parse_csljson_references_extracts_core_fields() {
        let content = r#"
[
  {
    "type": "article-journal",
    "title": "Attention Is All You Need",
    "author": [
      { "family": "Vaswani", "given": "Ashish" },
      { "family": "Shazeer", "given": "Noam" }
    ],
    "issued": { "date-parts": [[2017, 6, 12]] },
    "container-title": "NeurIPS",
    "DOI": "10.48550/arXiv.1706.03762",
    "keyword": "transformer, attention"
  }
]
"#;

        let items = parse_csljson_references(content).expect("csljson should parse");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].year, "2017");
        assert_eq!(items[0].publication, "NeurIPS");
        assert_eq!(items[0].tags, vec!["transformer", "attention"]);
    }

    #[test]
    fn build_library_item_sets_import_timestamps() {
        let temp_dir = std::env::temp_dir().join(format!("lume-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let pdf_path = temp_dir.join("paper.pdf");
        fs::write(&pdf_path, b"%PDF-1.4").unwrap();

        let item = build_library_item(&pdf_path);

        assert!(!item.date_added.trim().is_empty());
        assert_eq!(item.date_modified, item.date_added);

        let _ = fs::remove_file(pdf_path);
    }

    #[test]
    fn sync_item_to_db_backfills_missing_import_timestamp() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();

        let temp_dir = std::env::temp_dir().join(format!("lume-sync-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let pdf_path = temp_dir.join("paper.pdf");
        fs::write(&pdf_path, b"%PDF-1.4").unwrap();

        let mut item = build_library_item(&pdf_path);
        item.date_added.clear();
        item.date_modified.clear();

        sync_item_to_db(&conn, &item).unwrap();

        let stored: (String, String) = conn
            .query_row(
                "SELECT date_added, date_modified FROM items WHERE id = ?1",
                rusqlite::params![item.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert!(!stored.0.trim().is_empty());
        assert_eq!(stored.0, stored.1);

        let _ = fs::remove_file(pdf_path);
    }

    #[test]
    fn init_db_at_path_enables_foreign_keys() {
        let temp_dir = std::env::temp_dir().join(format!("lume-db-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let db_path = temp_dir.join("foreign_keys.sqlite");
        let _ = fs::remove_file(&db_path);

        let conn = init_db_at_path(&db_path).unwrap();
        let foreign_keys: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();

        assert_eq!(foreign_keys, 1);

        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn delete_item_records_removes_item_and_related_rows() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO items (id, item_type, title, folder_path) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["item-1", "Journal Article", "Paper", "root"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (id, item_id, name, path, attachment_type) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["att-1", "item-1", "paper", "/tmp/paper.pdf", "PDF"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, item_id, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["note-1", "item-1", "note", "now", "now"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO item_tags (item_id, tag) VALUES (?1, ?2)",
            rusqlite::params!["item-1", "ml"],
        )
        .unwrap();

        delete_item_records(&conn, "item-1").unwrap();

        let item_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE id = 'item-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let attachment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE item_id = 'item-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let note_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE item_id = 'item-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let tag_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM item_tags WHERE item_id = 'item-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(item_count, 0);
        assert_eq!(attachment_count, 0);
        assert_eq!(note_count, 0);
        assert_eq!(tag_count, 0);
    }

    #[test]
    fn delete_trashed_item_records_only_removes_trashed_rows() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO items (id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path, is_trashed, trashed_at)
             VALUES (?1, ?2, ?3, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ?4, 1, ?5)",
            rusqlite::params![
                "trash-item",
                "Journal Article",
                "Trash",
                "__trash__",
                "2026-03-20T00:00:00Z"
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (id, item_id, name, path, attachment_type) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["att-trash", "trash-item", "paper", "/tmp/trash.pdf", "PDF"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO items (id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path, is_trashed)
             VALUES (?1, ?2, ?3, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ?4, 0)",
            rusqlite::params!["live-item", "Journal Article", "Live", "root"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (id, item_id, name, path, attachment_type) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["att-live", "live-item", "paper", "/tmp/live.pdf", "PDF"],
        )
        .unwrap();

        delete_trashed_item_records(&conn).unwrap();

        let trashed_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE id = 'trash-item'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let trashed_attachment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE item_id = 'trash-item'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let live_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE id = 'live-item'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let live_attachment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE item_id = 'live-item'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(trashed_count, 0);
        assert_eq!(trashed_attachment_count, 0);
        assert_eq!(live_count, 1);
        assert_eq!(live_attachment_count, 1);
    }

    #[test]
    fn normalize_bing_web_language_code_maps_chinese_variants() {
        assert_eq!(normalize_bing_web_language_code("zh-CN"), "zh-Hans");
        assert_eq!(normalize_bing_web_language_code("zh-TW"), "zh-Hant");
        assert_eq!(normalize_bing_web_language_code("ja"), "ja");
    }

    #[test]
    fn parse_bing_web_auth_state_reads_live_page_markers() {
        let html = r#"
            <script>
              _G={IG:"ABCDEF123456"};
            </script>
            <div id="rich_tta" data-iid="translator.5023"></div>
            <script>
              var params_AbusePreventionHelper = [1773776417014,"token-value",3600000];
            </script>
        "#;

        let parsed = parse_bing_web_auth_state(html).unwrap();
        assert_eq!(parsed.ig, "ABCDEF123456");
        assert_eq!(parsed.iid, "translator.5023");
        assert_eq!(parsed.key, "1773776417014");
        assert_eq!(parsed.token, "token-value");
    }
}
