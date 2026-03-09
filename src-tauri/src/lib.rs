use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use pdfium_render::prelude::*;
use regex::Regex;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, State};

use std::sync::OnceLock;

struct GlobalPdfium(&'static Pdfium);
unsafe impl Sync for GlobalPdfium {}
unsafe impl Send for GlobalPdfium {}

static GLOBAL_PDFIUM: OnceLock<GlobalPdfium> = OnceLock::new();
static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
static DOI_REGEX: OnceLock<Regex> = OnceLock::new();
static ARXIV_REGEX: OnceLock<Regex> = OnceLock::new();
static ARXIV_LEGACY_REGEX: OnceLock<Regex> = OnceLock::new();
static XML_ENTRY_REGEX: OnceLock<Regex> = OnceLock::new();

struct ThreadSafeDoc(PdfDocument<'static>);
unsafe impl Send for ThreadSafeDoc {}
unsafe impl Sync for ThreadSafeDoc {}

struct AppState {
    documents: Arc<Mutex<HashMap<String, Arc<Mutex<ThreadSafeDoc>>>>>,
}

#[derive(Serialize)]
struct LibraryPdfMeta {
    title: String,
    authors: String,
    year: String,
    r#abstract: String,
    doi: String,
    #[serde(rename = "arxivId")]
    arxiv_id: String,
    tags: Vec<String>,
}

#[derive(Serialize)]
struct LibraryPdfEntry {
    id: String,
    name: String,
    path: String,
    meta: LibraryPdfMeta,
}

#[derive(Serialize)]
struct LibraryFolderNode {
    id: String,
    name: String,
    path: String,
    children: Vec<LibraryFolderNode>,
    pdfs: Vec<LibraryPdfEntry>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct ParsedPdfMetadata {
    title: Option<String>,
    authors: Option<String>,
    year: Option<String>,
    r#abstract: Option<String>,
    doi: Option<String>,
    #[serde(rename = "arxivId")]
    arxiv_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct CachedPdfMetadataRecord {
    file_size: u64,
    modified_unix_ms: u64,
    network_complete: bool,
    meta: ParsedPdfMetadata,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPdfAnnotationsDocument {
    #[serde(default = "default_annotation_version")]
    version: u8,
    #[serde(default)]
    pages: HashMap<String, SavedPdfPageAnnotations>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPdfPageAnnotations {
    #[serde(default)]
    paths: Vec<SavedAnnotationPath>,
    #[serde(default)]
    text_annotations: Vec<SavedTextAnnotation>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedAnnotationPath {
    tool: String,
    points: Vec<SavedAnnotationPoint>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedAnnotationPoint {
    x: f32,
    y: f32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedTextAnnotation {
    x: f32,
    y: f32,
    text: String,
    font_size: f32,
}

fn default_annotation_version() -> u8 {
    1
}

#[derive(Deserialize, Clone)]
struct CrossrefWorkResponse {
    message: CrossrefWorkMessage,
}

#[derive(Deserialize)]
struct CrossrefSearchResponse {
    message: CrossrefSearchMessage,
}

#[derive(Deserialize)]
struct CrossrefSearchMessage {
    #[serde(default)]
    items: Vec<CrossrefWorkMessage>,
}

#[derive(Deserialize, Clone)]
struct CrossrefWorkMessage {
    #[serde(default)]
    title: Vec<String>,
    #[serde(default)]
    author: Vec<CrossrefAuthor>,
    #[serde(default, rename = "published-print")]
    published_print: Option<CrossrefDateParts>,
    #[serde(default, rename = "published-online")]
    published_online: Option<CrossrefDateParts>,
    #[serde(default)]
    created: Option<CrossrefDateParts>,
    #[serde(default)]
    issued: Option<CrossrefDateParts>,
    #[serde(default)]
    #[serde(rename = "abstract")]
    abstract_field: Option<String>,
    #[serde(default, rename = "DOI")]
    doi: String,
}

#[derive(Deserialize, Clone)]
struct CrossrefAuthor {
    #[serde(default)]
    given: Option<String>,
    #[serde(default)]
    family: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize, Clone)]
struct CrossrefDateParts {
    #[serde(rename = "date-parts")]
    date_parts: Vec<Vec<u16>>,
}

fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent("Lume/0.1 (metadata enrichment)")
            .build()
            .expect("failed to build metadata HTTP client")
    })
}

fn doi_regex() -> &'static Regex {
    DOI_REGEX.get_or_init(|| {
        Regex::new(r"(?i)\b(?:https?://(?:dx\.)?doi\.org/|doi\s*[:：]\s*)?(10\.\d{4,9}/[-._;()/:a-z0-9]+)\b")
            .expect("invalid DOI regex")
    })
}

fn arxiv_regex() -> &'static Regex {
    ARXIV_REGEX.get_or_init(|| {
        Regex::new(r"(?i)\barxiv\s*[:：]\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b")
            .expect("invalid arXiv regex")
    })
}

fn arxiv_legacy_regex() -> &'static Regex {
    ARXIV_LEGACY_REGEX.get_or_init(|| {
        Regex::new(r"(?i)\barxiv\s*[:：]\s*([a-z\-]+(?:\.[a-z\-]+)?/\d{7}(?:v\d+)?)\b")
            .expect("invalid legacy arXiv regex")
    })
}

fn xml_entry_regex() -> &'static Regex {
    XML_ENTRY_REGEX.get_or_init(|| {
        Regex::new(r"(?is)<entry\b[^>]*>(.*?)</entry>").expect("invalid XML entry regex")
    })
}

fn library_root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {:?}", e))?
        .join("library");

    fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create library root: {}", e))?;

    Ok(root)
}

fn is_pdf_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn unique_directory_path(parent: &Path, desired_name: &str) -> PathBuf {
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

fn unique_file_path(parent: &Path, file_name: &str) -> PathBuf {
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

fn sanitize_file_name(name: &str) -> String {
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

fn is_path_within(base: &Path, candidate: &Path) -> bool {
    candidate == base || candidate.starts_with(base)
}

fn clean_title_text(value: &str) -> String {
    value
        .replace(['\r', '\n', '\t', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', '.', '-', '_', ':', ';'])
        .to_string()
}

fn is_plausible_title(value: &str) -> bool {
    let trimmed = clean_title_text(value);
    let lower = trimmed.to_lowercase();

    !trimmed.is_empty()
        && trimmed.len() >= 8
        && trimmed.len() <= 240
        && lower != "title"
        && lower != "untitled"
        && !lower.starts_with("abstract")
        && !lower.starts_with("introduction")
        && !lower.starts_with("contents")
}

fn clean_author_text(value: &str) -> String {
    value
        .replace(['\r', '\n', '\t'], " ")
        .replace('*', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', ',', '.', ';', ':'])
        .to_string()
}

fn is_plausible_author_line(value: &str) -> bool {
    let cleaned = clean_author_text(value);
    let lower = cleaned.to_lowercase();
    let has_alpha = cleaned.chars().any(|ch| ch.is_alphabetic());
    let word_count = cleaned.split_whitespace().count();
    let digit_count = cleaned.chars().filter(|ch| ch.is_ascii_digit()).count();

    has_alpha
        && cleaned.len() >= 3
        && cleaned.len() <= 180
        && word_count <= 24
        && digit_count <= 8
        && !lower.starts_with("abstract")
        && !lower.starts_with("introduction")
        && !lower.starts_with("keywords")
        && !lower.starts_with("arxiv")
        && !lower.contains("university")
        && !lower.contains("institute")
        && !lower.contains("department")
        && !lower.contains("school of")
        && !lower.contains("@")
}

fn normalize_authors(value: &str) -> String {
    clean_author_text(value)
        .replace(" and ", ", ")
        .replace(" ; ", ", ")
}

fn extract_year_from_text(value: &str) -> Option<String> {
    let digits = value.chars().collect::<Vec<_>>();

    for window in digits.windows(4) {
        if window.iter().all(|ch| ch.is_ascii_digit()) {
            let candidate = window.iter().collect::<String>();
            if let Ok(year) = candidate.parse::<u16>() {
                if (1900..=2099).contains(&year) {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

fn normalize_doi(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let extracted = doi_regex()
        .captures(trimmed)
        .and_then(|captures| captures.get(1).map(|matched| matched.as_str()))
        .unwrap_or(trimmed)
        .trim()
        .trim_matches([' ', '.', ',', ';', ')', ']', '}']);

    if extracted.is_empty() {
        None
    } else {
        Some(extracted.to_lowercase())
    }
}

fn normalize_arxiv_id(value: &str) -> Option<String> {
    let trimmed = value
        .trim()
        .trim_start_matches("https://arxiv.org/abs/")
        .trim_start_matches("http://arxiv.org/abs/")
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:")
        .trim()
        .trim_matches([' ', '.', ',', ';', ')', ']', '}']);

    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_lowercase())
    }
}

fn strip_xml_like_tags(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_tag = false;

    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }

    output
}

fn decode_basic_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

fn clean_abstract_text(value: &str) -> String {
    let decoded = decode_basic_entities(value);
    let without_tags = strip_xml_like_tags(&decoded);
    without_tags
        .replace(['\r', '\n', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', '.', ';'])
        .to_string()
}

fn is_plausible_abstract(value: &str) -> bool {
    let cleaned = clean_abstract_text(value);
    let lower = cleaned.to_lowercase();

    cleaned.len() >= 40
        && cleaned.len() <= 5000
        && !lower.starts_with("introduction")
        && !lower.starts_with("keywords")
        && !lower.starts_with("contents")
}

fn clean_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let cleaned = clean_title_text(&text);
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    })
}

fn overwrite_if_present(target: &mut Option<String>, incoming: Option<String>) {
    if let Some(value) = incoming.filter(|value| !value.trim().is_empty()) {
        *target = Some(value);
    }
}

fn fill_if_missing(target: &mut Option<String>, incoming: Option<String>) {
    let is_missing = target.as_deref().map(|value| value.trim().is_empty()).unwrap_or(true);
    if is_missing {
        overwrite_if_present(target, incoming);
    }
}

fn merge_arxiv_metadata(target: &mut ParsedPdfMetadata, incoming: ParsedPdfMetadata) {
    overwrite_if_present(&mut target.title, incoming.title);
    overwrite_if_present(&mut target.authors, incoming.authors);
    overwrite_if_present(&mut target.year, incoming.year);
    overwrite_if_present(&mut target.r#abstract, incoming.r#abstract);
    overwrite_if_present(&mut target.arxiv_id, incoming.arxiv_id);
    fill_if_missing(&mut target.doi, incoming.doi);
}

fn merge_crossref_metadata(target: &mut ParsedPdfMetadata, incoming: ParsedPdfMetadata) {
    overwrite_if_present(&mut target.title, incoming.title);
    overwrite_if_present(&mut target.authors, incoming.authors);
    overwrite_if_present(&mut target.year, incoming.year);
    overwrite_if_present(&mut target.doi, incoming.doi);
    fill_if_missing(&mut target.r#abstract, incoming.r#abstract);
}

fn normalize_title_for_match(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn title_tokens(value: &str) -> HashSet<String> {
    normalize_title_for_match(value)
        .split_whitespace()
        .filter(|token| token.len() > 2)
        .map(|token| token.to_string())
        .collect::<HashSet<_>>()
}

fn title_match_score(left: &str, right: &str) -> f32 {
    let left_normalized = normalize_title_for_match(left);
    let right_normalized = normalize_title_for_match(right);

    if left_normalized.is_empty() || right_normalized.is_empty() {
        return 0.0;
    }

    if left_normalized == right_normalized {
        return 1.0;
    }

    if left_normalized.contains(&right_normalized) || right_normalized.contains(&left_normalized) {
        return 0.94;
    }

    let left_tokens = title_tokens(left);
    let right_tokens = title_tokens(right);
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return 0.0;
    }

    let shared = left_tokens.intersection(&right_tokens).count() as f32;
    let union = left_tokens.union(&right_tokens).count() as f32;
    let coverage = shared / left_tokens.len().max(right_tokens.len()) as f32;
    let jaccard = if union > 0.0 { shared / union } else { 0.0 };

    coverage.max(jaccard)
}

fn titles_confidently_match(left: &str, right: &str) -> bool {
    title_match_score(left, right) >= 0.72
}

fn extract_xml_tag_values(block: &str, tag_name: &str) -> Vec<String> {
    let pattern = format!(r"(?is)<(?:[a-z0-9_\-]+:)?{}\b[^>]*>(.*?)</(?:[a-z0-9_\-]+:)?{}>", regex::escape(tag_name), regex::escape(tag_name));
    let regex = Regex::new(&pattern).expect("invalid XML tag regex");
    regex
        .captures_iter(block)
        .filter_map(|captures| captures.get(1).map(|matched| clean_abstract_text(matched.as_str())))
        .filter(|value| !value.is_empty())
        .collect()
}

fn extract_xml_tag_value(block: &str, tag_name: &str) -> Option<String> {
    extract_xml_tag_values(block, tag_name).into_iter().next()
}

fn parse_arxiv_year(value: &str) -> Option<String> {
    extract_year_from_text(value)
}

fn parse_arxiv_entry(block: &str) -> ParsedPdfMetadata {
    let title = clean_optional_text(extract_xml_tag_value(block, "title"))
        .filter(|value| is_plausible_title(value));
    let authors = {
        let names = extract_xml_tag_values(block, "name");
        if names.is_empty() {
            None
        } else {
            Some(names.join(", "))
        }
    };
    let summary = extract_xml_tag_value(block, "summary")
        .filter(|value| is_plausible_abstract(value))
        .map(|value| clean_abstract_text(&value));
    let year = extract_xml_tag_value(block, "published")
        .and_then(|value| parse_arxiv_year(&value));
    let doi = extract_xml_tag_value(block, "doi").and_then(|value| normalize_doi(&value));
    let arxiv_id = extract_xml_tag_value(block, "id").and_then(|value| normalize_arxiv_id(&value));

    ParsedPdfMetadata {
        title,
        authors,
        year,
        r#abstract: summary,
        doi,
        arxiv_id,
    }
}

fn parse_arxiv_feed_entries(xml: &str) -> Vec<ParsedPdfMetadata> {
    xml_entry_regex()
        .captures_iter(xml)
        .filter_map(|captures| captures.get(1).map(|matched| parse_arxiv_entry(matched.as_str())))
        .collect()
}

fn crossref_authors(authors: &[CrossrefAuthor]) -> Option<String> {
    let names = authors
        .iter()
        .filter_map(|author| {
            if let Some(name) = author.name.as_ref().map(|value| clean_author_text(value)).filter(|value| !value.is_empty()) {
                return Some(name);
            }

            let given = author.given.as_deref().unwrap_or_default().trim();
            let family = author.family.as_deref().unwrap_or_default().trim();
            let full = format!("{} {}", given, family).trim().to_string();

            if full.is_empty() {
                None
            } else {
                Some(full)
            }
        })
        .collect::<Vec<_>>();

    if names.is_empty() {
        None
    } else {
        Some(names.join(", "))
    }
}

fn crossref_year(message: &CrossrefWorkMessage) -> Option<String> {
    message
        .published_print
        .as_ref()
        .or(message.published_online.as_ref())
        .or(message.issued.as_ref())
        .or(message.created.as_ref())
        .and_then(|date_parts| date_parts.date_parts.first())
        .and_then(|parts| parts.first())
        .map(|year| year.to_string())
}

fn crossref_message_to_metadata(message: CrossrefWorkMessage) -> ParsedPdfMetadata {
    let title = message
        .title
        .iter()
        .map(|value| clean_title_text(value))
        .find(|value| is_plausible_title(value));
    let authors = crossref_authors(&message.author);
    let year = crossref_year(&message);
    let abstract_text = message
        .abstract_field
        .as_ref()
        .map(|value| clean_abstract_text(value))
        .filter(|value| is_plausible_abstract(value));
    let doi = normalize_doi(&message.doi);

    ParsedPdfMetadata {
        title,
        authors,
        year,
        r#abstract: abstract_text,
        doi,
        arxiv_id: None,
    }
}

fn fetch_crossref_metadata_by_doi(doi: &str) -> Result<Option<ParsedPdfMetadata>, String> {
    let url = format!(
        "https://api.crossref.org/works/{}",
        urlencoding::encode(doi)
    );
    let response = http_client()
        .get(url)
        .send()
        .map_err(|e| format!("Crossref lookup failed: {}", e))?;

    if response.status().as_u16() == 404 {
        return Ok(None);
    }

    let payload = response
        .error_for_status()
        .map_err(|e| format!("Crossref lookup failed: {}", e))?
        .json::<CrossrefWorkResponse>()
        .map_err(|e| format!("Failed to decode Crossref response: {}", e))?;

    Ok(Some(crossref_message_to_metadata(payload.message)))
}

fn fetch_crossref_metadata_by_title(title: &str) -> Result<Option<ParsedPdfMetadata>, String> {
    let payload = http_client()
        .get("https://api.crossref.org/works")
        .query(&[("query.bibliographic", title), ("rows", "5")])
        .send()
        .map_err(|e| format!("Crossref title search failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Crossref title search failed: {}", e))?
        .json::<CrossrefSearchResponse>()
        .map_err(|e| format!("Failed to decode Crossref search response: {}", e))?;

    let candidate = payload
        .message
        .items
        .into_iter()
        .map(|item| {
            let score = item
                .title
                .first()
                .map(|candidate_title| title_match_score(title, candidate_title))
                .unwrap_or(0.0);
            (score, item)
        })
        .filter(|(score, _)| *score >= 0.72)
        .max_by(|(left_score, _), (right_score, _)| {
            left_score
                .partial_cmp(right_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(_, item)| crossref_message_to_metadata(item));

    Ok(candidate)
}

fn fetch_arxiv_metadata_by_id(arxiv_id: &str) -> Result<Option<ParsedPdfMetadata>, String> {
    let xml = http_client()
        .get("https://export.arxiv.org/api/query")
        .query(&[("id_list", arxiv_id)])
        .send()
        .map_err(|e| format!("arXiv lookup failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("arXiv lookup failed: {}", e))?
        .text()
        .map_err(|e| format!("Failed to read arXiv response: {}", e))?;

    Ok(parse_arxiv_feed_entries(&xml).into_iter().next())
}

fn fetch_arxiv_metadata_by_title(title: &str) -> Result<Option<ParsedPdfMetadata>, String> {
    let search_query = format!("ti:\"{}\"", title);
    let xml = http_client()
        .get("https://export.arxiv.org/api/query")
        .query(&[("search_query", search_query.as_str()), ("start", "0"), ("max_results", "5")])
        .send()
        .map_err(|e| format!("arXiv title search failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("arXiv title search failed: {}", e))?
        .text()
        .map_err(|e| format!("Failed to read arXiv search response: {}", e))?;

    let candidate = parse_arxiv_feed_entries(&xml)
        .into_iter()
        .filter(|item| {
            item.title
                .as_deref()
                .map(|candidate_title| titles_confidently_match(title, candidate_title))
                .unwrap_or(false)
        })
        .max_by(|left, right| {
            let left_score = left
                .title
                .as_deref()
                .map(|candidate_title| title_match_score(title, candidate_title))
                .unwrap_or(0.0);
            let right_score = right
                .title
                .as_deref()
                .map(|candidate_title| title_match_score(title, candidate_title))
                .unwrap_or(0.0);
            left_score
                .partial_cmp(&right_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

    Ok(candidate)
}

fn metadata_cache_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.pdf");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".{}.Lume-meta.json", file_name))
}

fn annotation_sidecar_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.pdf");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".{}.Lume-annotations.json", file_name))
}

fn file_signature(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let modified_unix_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;

    Some((metadata.len(), modified_unix_ms))
}

fn read_cached_pdf_metadata(path: &Path) -> Option<CachedPdfMetadataRecord> {
    let cache_path = metadata_cache_path(path);
    let content = fs::read_to_string(cache_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_cached_pdf_metadata(path: &Path, record: &CachedPdfMetadataRecord) {
    let cache_path = metadata_cache_path(path);
    if let Ok(content) = serde_json::to_string_pretty(record) {
        let _ = fs::write(cache_path, content);
    }
}

fn remove_cached_pdf_metadata(path: &Path) {
    let _ = fs::remove_file(metadata_cache_path(path));
}

fn rename_cached_pdf_metadata(old_path: &Path, new_path: &Path) {
    let old_cache = metadata_cache_path(old_path);
    let new_cache = metadata_cache_path(new_path);
    if old_cache == new_cache || !old_cache.exists() {
        return;
    }

    let _ = fs::rename(old_cache, new_cache);
}

fn read_annotation_sidecar(path: &Path) -> Option<SavedPdfAnnotationsDocument> {
    let sidecar_path = annotation_sidecar_path(path);
    let content = fs::read_to_string(sidecar_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_annotation_sidecar(path: &Path, document: &SavedPdfAnnotationsDocument) -> Result<(), String> {
    let sidecar_path = annotation_sidecar_path(path);
    let content = serde_json::to_string_pretty(document)
        .map_err(|e| format!("Failed to serialize annotations: {}", e))?;
    fs::write(sidecar_path, content)
        .map_err(|e| format!("Failed to write annotations: {}", e))
}

fn remove_annotation_sidecar(path: &Path) {
    let _ = fs::remove_file(annotation_sidecar_path(path));
}

fn rename_annotation_sidecar(old_path: &Path, new_path: &Path) {
    let old_sidecar = annotation_sidecar_path(old_path);
    let new_sidecar = annotation_sidecar_path(new_path);

    if old_sidecar == new_sidecar || !old_sidecar.exists() {
        return;
    }

    let _ = fs::rename(old_sidecar, new_sidecar);
}

fn copy_annotation_sidecar(source_path: &Path, target_path: &Path) {
    let source_sidecar = annotation_sidecar_path(source_path);
    let target_sidecar = annotation_sidecar_path(target_path);

    if !source_sidecar.exists() || source_sidecar == target_sidecar {
        return;
    }

    let _ = fs::copy(source_sidecar, target_sidecar);
}

fn is_annotation_payload_empty(payload: &SavedPdfPageAnnotations) -> bool {
    payload.paths.is_empty() && payload.text_annotations.is_empty()
}

fn merge_page_text_nodes(page: &PdfPage<'_>) -> Result<Vec<TextNode>, String> {
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
                let y_tolerance = f32::max(node.height, h) * 0.3;
                let horizontal_gap = x - (node.x + node.width);

                if (node.y - y).abs() < y_tolerance && x >= node.x && horizontal_gap < node.height * 3.0 {
                    if horizontal_gap > node.height * 0.25 && !node.text.ends_with(' ') && !ch_str.starts_with(' ') {
                        node.text.push(' ');
                    }
                    node.text.push_str(&ch_str);

                    let new_right = f32::max(node.x + node.width, x + w);
                    node.y = f32::min(node.y, y);
                    let new_bottom = f32::max(node.y + node.height, y + h);
                    node.width = new_right - node.x;
                    node.height = new_bottom - node.y;
                    current_node = Some(node);
                } else {
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

fn infer_title_from_first_page(document: &PdfDocument<'_>) -> Option<String> {
    let page = document.pages().get(0).ok()?;
    let page_height = page.height().value;
    let mut candidates = merge_page_text_nodes(&page).ok()?
        .into_iter()
        .map(|node| {
            let cleaned = clean_title_text(&node.text);
            (node, cleaned)
        })
        .filter(|(node, cleaned)| {
            node.y < page_height * 0.38
                && node.width > 120.0
                && node.height > 10.0
                && is_plausible_title(cleaned)
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return None;
    }

    candidates.sort_by(|(left_node, left_text), (right_node, right_text)| {
        right_node.height
            .partial_cmp(&left_node.height)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left_node.y.partial_cmp(&right_node.y).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| right_text.len().cmp(&left_text.len()))
    });

    let anchor_height = candidates[0].0.height;
    let anchor_y = candidates[0].0.y;
    let min_height = anchor_height * 0.72;
    let max_y = anchor_y + anchor_height * 2.8;

    let mut title_lines = candidates
        .into_iter()
        .filter(|(node, _)| node.height >= min_height && node.y >= anchor_y - anchor_height * 0.5 && node.y <= max_y)
        .collect::<Vec<_>>();

    title_lines.sort_by(|(left, _), (right, _)| {
        left.y
            .partial_cmp(&right.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.x.partial_cmp(&right.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    let title = title_lines
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = clean_title_text(&title);

    if is_plausible_title(&cleaned) {
        Some(cleaned)
    } else {
        None
    }
}

fn infer_authors_from_first_page(document: &PdfDocument<'_>, inferred_title: Option<&str>) -> Option<String> {
    let page = document.pages().get(0).ok()?;
    let page_height = page.height().value;
    let nodes = merge_page_text_nodes(&page).ok()?;

    let title_anchor = nodes
        .iter()
        .map(|node| (node, clean_title_text(&node.text)))
        .filter(|(node, cleaned)| {
            node.y < page_height * 0.4
                && node.width > 120.0
                && node.height > 10.0
                && is_plausible_title(cleaned)
                && inferred_title.map(|title| cleaned.contains(title) || title.contains(cleaned)).unwrap_or(true)
        })
        .max_by(|(left_node, _), (right_node, _)| {
            left_node.height
                .partial_cmp(&right_node.height)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

    let (anchor_y, anchor_height) = title_anchor
        .map(|(node, _)| (node.y, node.height))
        .unwrap_or((page_height * 0.12, page_height * 0.035));

    let mut candidates = nodes
        .into_iter()
        .map(|node| {
            let cleaned = normalize_authors(&node.text);
            (node, cleaned)
        })
        .filter(|(node, cleaned)| {
            node.y >= anchor_y + anchor_height * 0.45
                && node.y <= anchor_y + anchor_height * 5.0
                && node.y < page_height * 0.55
                && node.height >= anchor_height * 0.28
                && node.height <= anchor_height * 0.95
                && node.width > 80.0
                && is_plausible_author_line(cleaned)
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return None;
    }

    candidates.sort_by(|(left, _), (right, _)| {
        left.y
            .partial_cmp(&right.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.width.partial_cmp(&left.width).unwrap_or(std::cmp::Ordering::Equal))
    });

    let author_line = candidates.first()?.1.clone();
    if is_plausible_author_line(&author_line) {
        Some(author_line)
    } else {
        None
    }
}

fn extract_page_lines(page: &PdfPage<'_>) -> Result<Vec<String>, String> {
    let mut nodes = merge_page_text_nodes(page)?;
    nodes.sort_by(|left, right| {
        left.y
            .partial_cmp(&right.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.x.partial_cmp(&right.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut lines: Vec<(f32, f32, Vec<String>)> = Vec::new();

    for node in nodes {
        let cleaned = clean_abstract_text(&node.text);
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
        .map(|(_, _, parts)| clean_abstract_text(&parts.join(" ")))
        .filter(|line| !line.is_empty())
        .collect())
}

fn extract_document_lines(document: &PdfDocument<'_>, max_pages: usize) -> Vec<String> {
    document
        .pages()
        .iter()
        .take(max_pages)
        .filter_map(|page| extract_page_lines(&page).ok())
        .flatten()
        .collect()
}

fn looks_like_section_heading(line: &str) -> bool {
    let normalized = normalize_title_for_match(line);

    normalized == "abstract"
        || normalized.starts_with("keywords")
        || normalized.starts_with("introduction")
        || normalized.starts_with("contents")
        || normalized.starts_with("index terms")
        || normalized.starts_with("ccs concepts")
        || normalized.starts_with("1 introduction")
        || normalized.starts_with("i introduction")
        || normalized.starts_with("1 preliminaries")
        || normalized.starts_with("related work")
}

fn join_text_fragments(parts: &[String]) -> String {
    let mut combined = String::new();

    for part in parts {
        let piece = clean_abstract_text(part);
        if piece.is_empty() {
            continue;
        }

        if combined.ends_with('-') {
            combined.pop();
            combined.push_str(piece.trim_start());
        } else {
            if !combined.is_empty() {
                combined.push(' ');
            }
            combined.push_str(piece.trim());
        }
    }

    clean_abstract_text(&combined)
}

fn extract_abstract_from_lines(lines: &[String]) -> Option<String> {
    for (index, line) in lines.iter().enumerate() {
        let lower = line.to_lowercase();
        if !(lower == "abstract"
            || lower.starts_with("abstract ")
            || lower.starts_with("abstract:")
            || lower.starts_with("abstract."))
        {
            continue;
        }

        let mut fragments = Vec::new();
        let inline = line
            .split_once(':')
            .map(|(_, rest)| rest.trim().to_string())
            .or_else(|| line.split_once('.').map(|(_, rest)| rest.trim().to_string()))
            .or_else(|| {
                line.strip_prefix("Abstract")
                    .or_else(|| line.strip_prefix("ABSTRACT"))
                    .map(|rest| rest.trim().to_string())
            })
            .filter(|value| !value.is_empty());

        if let Some(inline_value) = inline {
            fragments.push(inline_value);
        }

        let mut total_len = fragments.iter().map(|part| part.len()).sum::<usize>();

        for next_line in lines.iter().skip(index + 1) {
            let cleaned = clean_abstract_text(next_line);
            if cleaned.is_empty() {
                if total_len > 120 {
                    break;
                }
                continue;
            }

            if looks_like_section_heading(&cleaned) && total_len > 120 {
                break;
            }

            total_len += cleaned.len();
            fragments.push(cleaned);

            if total_len >= 2400 {
                break;
            }
        }

        let abstract_text = join_text_fragments(&fragments);
        if is_plausible_abstract(&abstract_text) {
            return Some(abstract_text);
        }
    }

    None
}

fn extract_doi_from_text(value: &str) -> Option<String> {
    doi_regex()
        .captures(value)
        .and_then(|captures| captures.get(1).map(|matched| matched.as_str()))
        .and_then(normalize_doi)
}

fn extract_arxiv_id_from_text(value: &str) -> Option<String> {
    arxiv_regex()
        .captures(value)
        .and_then(|captures| captures.get(1).map(|matched| matched.as_str()))
        .and_then(normalize_arxiv_id)
        .or_else(|| {
            arxiv_legacy_regex()
                .captures(value)
                .and_then(|captures| captures.get(1).map(|matched| matched.as_str()))
                .and_then(normalize_arxiv_id)
        })
}

fn extract_arxiv_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem().and_then(|value| value.to_str())?;
    let modern = Regex::new(r"(?i)\b(\d{4}\.\d{4,5}(?:v\d+)?)\b").ok()?;
    modern
        .captures(stem)
        .and_then(|captures| captures.get(1).map(|matched| matched.as_str()))
        .and_then(normalize_arxiv_id)
}

fn extract_pdf_metadata(path: &Path) -> Option<ParsedPdfMetadata> {
    let pdfium = GLOBAL_PDFIUM.get()?;
    let document = pdfium.0.load_pdf_from_file(path, None).ok()?;
    let document_lines = extract_document_lines(&document, 3);
    let searchable_text = document_lines.join("\n");
    let file_name_text = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(clean_title_text);

    let metadata_title = document
        .metadata()
        .get(PdfDocumentMetadataTagType::Title)
        .map(|tag| clean_title_text(tag.value()))
        .filter(|title| is_plausible_title(title));

    let metadata_authors = document
        .metadata()
        .get(PdfDocumentMetadataTagType::Author)
        .map(|tag| normalize_authors(tag.value()))
        .filter(|authors| is_plausible_author_line(authors));

    let metadata_year = document
        .metadata()
        .get(PdfDocumentMetadataTagType::CreationDate)
        .and_then(|tag| extract_year_from_text(tag.value()))
        .or_else(|| {
            document
                .metadata()
                .get(PdfDocumentMetadataTagType::ModificationDate)
                .and_then(|tag| extract_year_from_text(tag.value()))
        });

    let inferred_title = metadata_title
        .clone()
        .or_else(|| infer_title_from_first_page(&document))
        .or_else(|| file_name_text.filter(|title| is_plausible_title(title)));
    let inferred_authors = metadata_authors.clone().or_else(|| infer_authors_from_first_page(&document, inferred_title.as_deref()));

    let inferred_year = metadata_year.or_else(|| {
        inferred_title
            .as_deref()
            .and_then(extract_year_from_text)
    });

    let inferred_abstract = extract_abstract_from_lines(&document_lines);
    let inferred_doi = extract_doi_from_text(&searchable_text)
        .or_else(|| path.file_stem().and_then(|value| value.to_str()).and_then(extract_doi_from_text));
    let inferred_arxiv_id = extract_arxiv_id_from_text(&searchable_text)
        .or_else(|| extract_arxiv_id_from_filename(path));

    Some(ParsedPdfMetadata {
        title: inferred_title,
        authors: inferred_authors,
        year: inferred_year,
        r#abstract: inferred_abstract,
        doi: inferred_doi,
        arxiv_id: inferred_arxiv_id,
    })
}

fn should_try_remote_metadata(meta: &ParsedPdfMetadata) -> bool {
    meta.doi.is_some()
        || meta.arxiv_id.is_some()
        || meta.title.is_some()
}

fn resolve_pdf_metadata(path: &Path) -> ParsedPdfMetadata {
    let local = extract_pdf_metadata(path).unwrap_or_default();
    let Some((file_size, modified_unix_ms)) = file_signature(path) else {
        return local;
    };

    if let Some(cached) = read_cached_pdf_metadata(path) {
        if cached.file_size == file_size
            && cached.modified_unix_ms == modified_unix_ms
            && cached.network_complete
        {
            return cached.meta;
        }
    }

    let mut resolved = local.clone();
    let mut network_complete = true;

    if should_try_remote_metadata(&resolved) {
        let title_for_search = resolved.title.clone();

        if let Some(arxiv_id) = resolved.arxiv_id.clone() {
            match fetch_arxiv_metadata_by_id(&arxiv_id) {
                Ok(Some(remote)) => merge_arxiv_metadata(&mut resolved, remote),
                Ok(None) => {}
                Err(_) => network_complete = false,
            }
        }

        if let Some(doi) = resolved.doi.clone() {
            match fetch_crossref_metadata_by_doi(&doi) {
                Ok(Some(remote)) => merge_crossref_metadata(&mut resolved, remote),
                Ok(None) => {}
                Err(_) => network_complete = false,
            }
        }

        if let Some(title) = title_for_search.as_deref() {
            if resolved.doi.is_none() || resolved.authors.is_none() || resolved.year.is_none() {
                match fetch_crossref_metadata_by_title(title) {
                    Ok(Some(remote)) => merge_crossref_metadata(&mut resolved, remote),
                    Ok(None) => {}
                    Err(_) => network_complete = false,
                }
            }

            if resolved.arxiv_id.is_none() || resolved.r#abstract.is_none() {
                match fetch_arxiv_metadata_by_title(title) {
                    Ok(Some(remote)) => merge_arxiv_metadata(&mut resolved, remote),
                    Ok(None) => {}
                    Err(_) => network_complete = false,
                }
            }

            if let Some(doi) = resolved.doi.clone() {
                if local.doi.as_ref() != Some(&doi) {
                    match fetch_crossref_metadata_by_doi(&doi) {
                        Ok(Some(remote)) => merge_crossref_metadata(&mut resolved, remote),
                        Ok(None) => {}
                        Err(_) => network_complete = false,
                    }
                }
            }
        }
    }

    write_cached_pdf_metadata(
        path,
        &CachedPdfMetadataRecord {
            file_size,
            modified_unix_ms,
            network_complete,
            meta: resolved.clone(),
        },
    );

    resolved
}

fn build_pdf_entry(path: &Path) -> LibraryPdfEntry {
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled")
        .to_string();
    let path_str = path.to_string_lossy().to_string();
    let parsed = resolve_pdf_metadata(path);
    let title = parsed
        .title
        .clone()
        .unwrap_or_else(|| name.clone());
    let authors = parsed
        .authors
        .clone()
        .unwrap_or_else(|| "—".to_string());
    let year = parsed
        .year
        .clone()
        .unwrap_or_else(|| "—".to_string());
    let abstract_text = parsed.r#abstract.clone().unwrap_or_default();
    let doi = parsed.doi.clone().unwrap_or_default();
    let arxiv_id = parsed.arxiv_id.clone().unwrap_or_default();

    LibraryPdfEntry {
        id: path_str.clone(),
        name: name.clone(),
        path: path_str,
        meta: LibraryPdfMeta {
            title,
            authors,
            year,
            r#abstract: abstract_text,
            doi,
            arxiv_id,
            tags: Vec::new(),
        },
    }
}

fn build_library_tree(path: &Path, is_root: bool) -> Result<LibraryFolderNode, String> {
    fs::create_dir_all(path)
        .map_err(|e| format!("Failed to prepare library folder: {}", e))?;

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
        .map(|child| build_library_tree(&child, false))
        .collect::<Result<Vec<_>, _>>()?;

    let pdfs = pdf_paths
        .into_iter()
        .map(|pdf| build_pdf_entry(&pdf))
        .collect::<Vec<_>>();

    let name = if is_root {
        "My Library".to_string()
    } else {
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled Folder")
            .to_string()
    };
    let path_str = path.to_string_lossy().to_string();

    Ok(LibraryFolderNode {
        id: path_str.clone(),
        name,
        path: path_str,
        children,
        pdfs,
    })
}

#[tauri::command]
fn load_library_tree(app: tauri::AppHandle) -> Result<Vec<LibraryFolderNode>, String> {
    let root = library_root_dir(&app)?;
    Ok(vec![build_library_tree(&root, true)?])
}

#[tauri::command]
fn load_pdf_annotations(path: String, page_index: u16) -> Result<SavedPdfPageAnnotations, String> {
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
fn save_pdf_annotations(
    path: String,
    page_index: u16,
    annotations: SavedPdfPageAnnotations,
) -> Result<(), String> {
    let pdf_path = PathBuf::from(&path);
    if !pdf_path.exists() {
        return Err("PDF does not exist".to_string());
    }

    let mut document = read_annotation_sidecar(&pdf_path).unwrap_or_default();
    document.version = default_annotation_version();

    let page_key = page_index.to_string();
    if is_annotation_payload_empty(&annotations) {
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
fn create_library_folder(parent_path: String, name: String) -> Result<String, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    if trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err("Folder name cannot contain path separators".to_string());
    }

    let parent = PathBuf::from(parent_path);
    fs::create_dir_all(&parent)
        .map_err(|e| format!("Failed to access parent folder: {}", e))?;

    let target = unique_directory_path(&parent, trimmed_name);
    fs::create_dir_all(&target)
        .map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn import_pdf_to_folder(source_path: String, folder_path: String) -> Result<String, String> {
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

    fs::copy(&source, &target)
        .map_err(|e| format!("Failed to import PDF: {}", e))?;
    copy_annotation_sidecar(&source, &target);

    let resolved_meta = resolve_pdf_metadata(&target);

    let final_path = if let Some(title) = resolved_meta
        .title
        .as_deref()
        .map(sanitize_file_name)
        .filter(|title| !title.is_empty())
    {
        let renamed = unique_file_path(&target_folder, &format!("{}.pdf", title));

        if renamed != target {
            fs::rename(&target, &renamed)
                .map_err(|e| format!("Failed to rename imported PDF: {}", e))?;
            renamed
        } else {
            target.clone()
        }
    } else {
        target.clone()
    };

    if final_path != target {
        rename_cached_pdf_metadata(&target, &final_path);
        rename_annotation_sidecar(&target, &final_path);
    }

    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_library_pdf(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        remove_cached_pdf_metadata(&target);
        return Ok(());
    }

    if !target.is_file() || !is_pdf_file(&target) {
        return Err("Only library PDF files can be deleted".to_string());
    }

    {
        let mut docs = state.documents.lock().unwrap();
        docs.remove(&path);
    }

    fs::remove_file(&target)
        .map_err(|e| format!("Failed to delete PDF: {}", e))?;

    remove_cached_pdf_metadata(&target);
    remove_annotation_sidecar(&target);

    Ok(())
}

#[tauri::command]
fn rename_library_pdf(path: String, new_name: String, state: State<'_, AppState>) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err("PDF does not exist".to_string());
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

    fs::rename(&source, &target)
        .map_err(|e| format!("Failed to rename PDF: {}", e))?;

    rename_cached_pdf_metadata(&source, &target);
    rename_annotation_sidecar(&source, &target);

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn rename_library_folder(
    app: tauri::AppHandle,
    path: String,
    new_name: String,
    state: State<'_, AppState>,
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

    fs::rename(&source, &target)
        .map_err(|e| format!("Failed to rename folder: {}", e))?;

    Ok(target.to_string_lossy().to_string())
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
            let max_dim = 3200;
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
        JpegEncoder::new_with_quality(&mut cursor, 68)
            .encode_image(&image)
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
            load_library_tree,
            load_pdf_annotations,
            save_pdf_annotations,
            create_library_folder,
            import_pdf_to_folder,
            delete_library_pdf,
            rename_library_pdf,
            rename_library_folder,
            load_pdf,
            get_pdf_dimensions,
            get_text_rects,
            get_page_text,
            render_page
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lume");
}
