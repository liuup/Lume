use regex::Regex;
/// Module: src-tauri/src/metadata_fetch.rs
/// Purpose: Encapsulates all fetching logic for Crossref and arXiv metadata APIs.
/// Capabilities: Defines internal regex engines to extract DOIs and arXiv IDs and exposes methods to query external literature APIs.
use reqwest::blocking::Client;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::models::{
    CrossrefAuthor, CrossrefSearchResponse, CrossrefWorkMessage, CrossrefWorkResponse, LibraryItem,
    MetadataFetchReport, MetadataFetchStep, ParsedPdfMetadata, RetrieveMetadataResult,
};

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
static URL_VALIDATION_CLIENT: OnceLock<Client> = OnceLock::new();
static DOI_REGEX: OnceLock<Regex> = OnceLock::new();
static ARXIV_REGEX: OnceLock<Regex> = OnceLock::new();
static ARXIV_LEGACY_REGEX: OnceLock<Regex> = OnceLock::new();
static XML_ENTRY_REGEX: OnceLock<Regex> = OnceLock::new();
static METADATA_REQUEST_CACHE: OnceLock<Mutex<HashMap<String, MetadataRequestCacheEntry>>> =
    OnceLock::new();
const FUZZY_METADATA_MATCH_THRESHOLD: f32 = 0.74;
const EXACT_DOI_MATCH_THRESHOLD: f32 = 0.88;
const METADATA_REQUEST_MAX_ATTEMPTS: usize = 2;
const METADATA_REQUEST_RETRY_DELAY_MS: u64 = 250;
const METADATA_REQUEST_SUCCESS_CACHE_SECS: u64 = 600;
const METADATA_REQUEST_EMPTY_CACHE_SECS: u64 = 180;
const METADATA_REQUEST_ERROR_COOLDOWN_SECS: u64 = 90;

#[derive(Clone, Copy)]
enum MetadataProvider {
    ArxivId,
    CrossrefDoi,
    OpenAlexDoi,
    OpenAlexTitle,
    CrossrefTitle,
    ArxivTitle,
}

impl MetadataProvider {
    fn priority(self) -> usize {
        match self {
            MetadataProvider::OpenAlexDoi => 10,
            MetadataProvider::CrossrefDoi => 20,
            MetadataProvider::ArxivId => 30,
            MetadataProvider::OpenAlexTitle => 110,
            MetadataProvider::CrossrefTitle => 120,
            MetadataProvider::ArxivTitle => 130,
        }
    }

    fn name(self) -> &'static str {
        match self {
            MetadataProvider::ArxivId => "arxiv_id",
            MetadataProvider::CrossrefDoi => "crossref_doi",
            MetadataProvider::OpenAlexDoi => "openalex_doi",
            MetadataProvider::OpenAlexTitle => "openalex_title",
            MetadataProvider::CrossrefTitle => "crossref_title",
            MetadataProvider::ArxivTitle => "arxiv_title",
        }
    }
}

#[derive(Clone, Copy)]
enum MetadataStage {
    Precise,
    Fuzzy,
    Refresh,
}

impl MetadataStage {
    fn name(self) -> &'static str {
        match self {
            MetadataStage::Precise => "precise",
            MetadataStage::Fuzzy => "fuzzy",
            MetadataStage::Refresh => "refresh",
        }
    }
}

impl MetadataStage {
    fn is_precise_like(self) -> bool {
        matches!(self, MetadataStage::Precise | MetadataStage::Refresh)
    }
}

#[derive(Default)]
struct MetadataMergePriority {
    title: usize,
    authors: usize,
    year: usize,
    abstract_text: usize,
    doi: usize,
    arxiv_id: usize,
    publication: usize,
    volume: usize,
    issue: usize,
    pages: usize,
    publisher: usize,
    isbn: usize,
    url: usize,
    language: usize,
}

impl MetadataMergePriority {
    fn new() -> Self {
        Self {
            title: usize::MAX,
            authors: usize::MAX,
            year: usize::MAX,
            abstract_text: usize::MAX,
            doi: usize::MAX,
            arxiv_id: usize::MAX,
            publication: usize::MAX,
            volume: usize::MAX,
            issue: usize::MAX,
            pages: usize::MAX,
            publisher: usize::MAX,
            isbn: usize::MAX,
            url: usize::MAX,
            language: usize::MAX,
        }
    }
}

#[derive(Deserialize)]
struct OpenAlexWorksResponse {
    #[serde(default)]
    results: Vec<OpenAlexWork>,
}

#[derive(Deserialize)]
struct OpenAlexWork {
    #[serde(default)]
    display_name: String,
    doi: Option<String>,
    publication_year: Option<i32>,
    #[serde(default)]
    r#type: String,
    language: Option<String>,
    primary_location: Option<OpenAlexPrimaryLocation>,
    #[serde(default)]
    authorships: Vec<OpenAlexAuthorship>,
    biblio: Option<OpenAlexBiblio>,
    abstract_inverted_index: Option<HashMap<String, Vec<usize>>>,
}

#[derive(Deserialize)]
struct OpenAlexPrimaryLocation {
    landing_page_url: Option<String>,
    pdf_url: Option<String>,
    source: Option<OpenAlexSource>,
    raw_source_name: Option<String>,
}

#[derive(Deserialize)]
struct OpenAlexSource {
    display_name: Option<String>,
    host_organization_name: Option<String>,
}

#[derive(Deserialize)]
struct OpenAlexAuthorship {
    author: Option<OpenAlexAuthor>,
    raw_author_name: Option<String>,
}

#[derive(Deserialize)]
struct OpenAlexAuthor {
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct OpenAlexBiblio {
    volume: Option<String>,
    issue: Option<String>,
    first_page: Option<String>,
    last_page: Option<String>,
}

pub struct RemoteMetadataEnrichmentResult {
    pub meta: ParsedPdfMetadata,
    pub network_complete: bool,
    pub report: MetadataFetchReport,
}

#[derive(Clone)]
struct MetadataRequestCacheEntry {
    expires_at: Instant,
    result: Result<Option<ParsedPdfMetadata>, String>,
}

pub fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("Lume/0.1 (metadata enrichment)")
            .build()
            .expect("failed to build metadata HTTP client")
    })
}

fn url_validation_client() -> &'static Client {
    URL_VALIDATION_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(6))
            .redirect(reqwest::redirect::Policy::limited(6))
            .user_agent("Lume/0.1 (metadata url validation)")
            .build()
            .expect("failed to build metadata URL validation HTTP client")
    })
}

fn metadata_request_cache() -> &'static Mutex<HashMap<String, MetadataRequestCacheEntry>> {
    METADATA_REQUEST_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_metadata_request_query(provider: MetadataProvider, query: &str) -> String {
    match provider {
        MetadataProvider::CrossrefDoi | MetadataProvider::OpenAlexDoi => {
            normalize_doi(query).unwrap_or_else(|| query.trim().to_lowercase())
        }
        MetadataProvider::ArxivId => {
            normalize_arxiv_id(query).unwrap_or_else(|| query.trim().to_lowercase())
        }
        MetadataProvider::OpenAlexTitle
        | MetadataProvider::CrossrefTitle
        | MetadataProvider::ArxivTitle => normalize_title_for_match(query),
    }
}

fn metadata_request_cache_key(provider: MetadataProvider, query: &str) -> String {
    format!(
        "{}:{}",
        provider.name(),
        normalize_metadata_request_query(provider, query)
    )
}

fn get_cached_metadata_request(
    provider: MetadataProvider,
    query: &str,
) -> Option<Result<Option<ParsedPdfMetadata>, String>> {
    let key = metadata_request_cache_key(provider, query);
    let now = Instant::now();
    let mut cache = metadata_request_cache().lock().ok()?;

    match cache.get(&key) {
        Some(entry) if entry.expires_at > now => Some(entry.result.clone()),
        Some(_) => {
            cache.remove(&key);
            None
        }
        None => None,
    }
}

fn store_cached_metadata_request(
    provider: MetadataProvider,
    query: &str,
    result: &Result<Option<ParsedPdfMetadata>, String>,
) {
    let ttl_secs = match result {
        Ok(Some(_)) => METADATA_REQUEST_SUCCESS_CACHE_SECS,
        Ok(None) => METADATA_REQUEST_EMPTY_CACHE_SECS,
        Err(_) => METADATA_REQUEST_ERROR_COOLDOWN_SECS,
    };

    if let Ok(mut cache) = metadata_request_cache().lock() {
        cache.insert(
            metadata_request_cache_key(provider, query),
            MetadataRequestCacheEntry {
                expires_at: Instant::now() + Duration::from_secs(ttl_secs),
                result: result.clone(),
            },
        );
    }
}

fn should_retry_metadata_error(error: &str) -> bool {
    let lower = error.to_lowercase();

    lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection")
        || lower.contains("transport")
        || lower.contains("dns")
        || lower.contains("tempor")
        || lower.contains("429")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
}

fn retry_metadata_request<T, F>(mut operation: F) -> Result<T, String>
where
    F: FnMut() -> Result<T, String>,
{
    let mut last_error = None;

    for attempt in 0..METADATA_REQUEST_MAX_ATTEMPTS {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) => {
                let is_last_attempt = attempt + 1 == METADATA_REQUEST_MAX_ATTEMPTS;
                if is_last_attempt || !should_retry_metadata_error(&error) {
                    return Err(error);
                }

                last_error = Some(error);
                std::thread::sleep(Duration::from_millis(
                    METADATA_REQUEST_RETRY_DELAY_MS * (attempt as u64 + 1),
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "metadata request failed".to_string()))
}

fn execute_metadata_request<F>(
    provider: MetadataProvider,
    query: &str,
    operation: F,
) -> Result<Option<ParsedPdfMetadata>, String>
where
    F: FnOnce() -> Result<Option<ParsedPdfMetadata>, String>,
{
    if let Some(cached) = get_cached_metadata_request(provider, query) {
        return cached;
    }

    let result = operation();
    store_cached_metadata_request(provider, query, &result);
    result
}

pub fn doi_regex() -> &'static Regex {
    DOI_REGEX.get_or_init(|| {
        Regex::new(r"(?i)\b(?:https?://(?:dx\.)?doi\.org/|doi\s*[:：]\s*)?(10\.\d{4,9}/[-._;()/:a-z0-9]+)\b")
            .expect("invalid DOI regex")
    })
}

pub fn arxiv_regex() -> &'static Regex {
    ARXIV_REGEX.get_or_init(|| {
        Regex::new(r"(?i)\barxiv\s*[:：]\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b")
            .expect("invalid arXiv regex")
    })
}

pub fn arxiv_legacy_regex() -> &'static Regex {
    ARXIV_LEGACY_REGEX.get_or_init(|| {
        Regex::new(r"(?i)\barxiv\s*[:：]\s*([a-z\-]+(?:\.[a-z\-]+)?/\d{7}(?:v\d+)?)\b")
            .expect("invalid legacy arXiv regex")
    })
}

pub fn xml_entry_regex() -> &'static Regex {
    XML_ENTRY_REGEX.get_or_init(|| {
        Regex::new(r"(?is)<entry\b[^>]*>(.*?)</entry>").expect("invalid XML entry regex")
    })
}

pub fn clean_title_text(value: &str) -> String {
    value
        .replace(['\r', '\n', '\t', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', '.', '-', '_', ':', ';'])
        .to_string()
}

pub fn is_plausible_title(value: &str) -> bool {
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

pub fn clean_author_text(value: &str) -> String {
    value
        .replace(['\r', '\n', '\t'], " ")
        .replace('*', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', ',', '.', ';', ':'])
        .to_string()
}

pub fn is_plausible_author_line(value: &str) -> bool {
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

pub fn normalize_authors(value: &str) -> String {
    clean_author_text(value)
        .replace(" and ", ", ")
        .replace(" ; ", ", ")
}

pub fn normalize_author_for_match(value: &str) -> String {
    normalize_authors(value)
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn author_tokens(value: &str) -> HashSet<String> {
    normalize_author_for_match(value)
        .split_whitespace()
        .filter(|token| token.len() > 1)
        .filter(|token| !matches!(*token, "and" | "et" | "al"))
        .map(|token| token.to_string())
        .collect()
}

pub fn author_match_score(left: &str, right: &str) -> f32 {
    let left_normalized = normalize_author_for_match(left);
    let right_normalized = normalize_author_for_match(right);

    if left_normalized.is_empty() || right_normalized.is_empty() {
        return 0.0;
    }

    if left_normalized == right_normalized {
        return 1.0;
    }

    let left_tokens = author_tokens(left);
    let right_tokens = author_tokens(right);
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return 0.0;
    }

    let shared = left_tokens.intersection(&right_tokens).count() as f32;
    let coverage = shared / left_tokens.len().max(right_tokens.len()) as f32;
    let jaccard = shared / left_tokens.union(&right_tokens).count() as f32;
    coverage.max(jaccard)
}

pub fn extract_year_from_text(value: &str) -> Option<String> {
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

pub fn normalize_doi(value: &str) -> Option<String> {
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

fn normalize_doi_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let lowered = trimmed.to_lowercase();
    let is_doi_url = lowered.starts_with("https://doi.org/")
        || lowered.starts_with("http://doi.org/")
        || lowered.starts_with("https://dx.doi.org/")
        || lowered.starts_with("http://dx.doi.org/");

    if is_doi_url {
        normalize_doi(trimmed)
    } else {
        None
    }
}

fn looks_like_web_url(value: &str) -> bool {
    let lowered = value.trim().to_lowercase();
    lowered.starts_with("https://") || lowered.starts_with("http://")
}

fn is_definitively_broken_url_status(status: u16) -> bool {
    matches!(status, 404 | 410)
}

fn url_validation_error_indicates_broken_target(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("too many redirects")
        || lower.contains("redirect loop")
        || lower.contains("redirect")
            && (lower.contains("limit") || lower.contains("loop") || lower.contains("cyclic"))
}

fn probe_metadata_url(url: &str, use_head: bool) -> Result<Option<bool>, String> {
    let response = if use_head {
        url_validation_client().head(url).send()
    } else {
        url_validation_client().get(url).send()
    }
    .map_err(|e| format!("metadata URL validation failed: {}", e))?;

    let status = response.status().as_u16();
    if use_head && matches!(status, 405 | 501) {
        return Ok(None);
    }

    Ok(Some(!is_definitively_broken_url_status(status)))
}

fn validate_metadata_url(url: &str) -> Result<bool, String> {
    if !looks_like_web_url(url) {
        return Ok(true);
    }

    retry_metadata_request(|| match probe_metadata_url(url, true) {
        Ok(Some(result)) => Ok(result),
        Ok(None) => probe_metadata_url(url, false).map(|result| result.unwrap_or(true)),
        Err(error) => {
            if url_validation_error_indicates_broken_target(&error) {
                Ok(false)
            } else {
                Err(error)
            }
        }
    })
}

pub fn strip_invalid_metadata_url(meta: &mut ParsedPdfMetadata) -> Result<bool, String> {
    strip_invalid_metadata_url_with(meta, validate_metadata_url)
}

fn strip_invalid_metadata_url_with<F>(
    meta: &mut ParsedPdfMetadata,
    validate: F,
) -> Result<bool, String>
where
    F: FnOnce(&str) -> Result<bool, String>,
{
    let Some(url) = meta.url.clone() else {
        return Ok(false);
    };

    if validate(&url)? {
        Ok(false)
    } else {
        meta.url = None;
        Ok(true)
    }
}

fn provider_supplies_unstable_publisher(provider: MetadataProvider) -> bool {
    matches!(
        provider,
        MetadataProvider::OpenAlexDoi | MetadataProvider::OpenAlexTitle
    )
}

fn item_type_key(item_type: &str) -> String {
    item_type
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn item_type_supports_automatic_publisher(item_type: &str) -> bool {
    let normalized = item_type_key(item_type);

    normalized.contains("book")
        || normalized.contains("report")
        || normalized.contains("thesis")
        || normalized.contains("dissertation")
        || normalized.contains("manual")
        || normalized.contains("standard")
}

fn metadata_has_match_context(meta: &ParsedPdfMetadata) -> bool {
    meta.title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
}

fn exact_identifier_candidate_matches_context(
    context: &ParsedPdfMetadata,
    candidate: &ParsedPdfMetadata,
) -> bool {
    let Some(title) = context
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };

    metadata_candidate_match_score(
        title,
        context.authors.as_deref(),
        context.year.as_deref(),
        candidate,
    ) >= EXACT_DOI_MATCH_THRESHOLD
}

fn sanitize_incoming_metadata(
    current: &ParsedPdfMetadata,
    mut incoming: ParsedPdfMetadata,
    provider: MetadataProvider,
    stage: MetadataStage,
    score: Option<f32>,
) -> ParsedPdfMetadata {
    if provider_supplies_unstable_publisher(provider) {
        incoming.publisher = None;
    }

    if matches!(stage, MetadataStage::Fuzzy) {
        let _ = current;
        let _ = score;
        incoming.doi = None;
        incoming.arxiv_id = None;
        incoming.publisher = None;
        if incoming
            .url
            .as_deref()
            .and_then(normalize_doi_url)
            .is_some()
        {
            incoming.url = None;
        }
    }

    incoming
}

fn validate_incoming_metadata(
    current: &ParsedPdfMetadata,
    incoming: &ParsedPdfMetadata,
    provider: MetadataProvider,
    stage: MetadataStage,
    query: &str,
) -> Result<(), String> {
    if matches!(
        provider,
        MetadataProvider::CrossrefDoi | MetadataProvider::OpenAlexDoi
    ) && stage.is_precise_like()
    {
        if let Some(expected_doi) = normalize_doi(query) {
            let actual_doi = incoming.doi.as_deref().and_then(normalize_doi);
            if actual_doi.as_deref() != Some(expected_doi.as_str()) {
                return Err(format!(
                    "rejected {} result because returned DOI did not match the queried DOI",
                    provider.name()
                ));
            }
        }

        if metadata_has_match_context(current)
            && !exact_identifier_candidate_matches_context(current, incoming)
        {
            return Err(format!(
                "rejected {} result because title/author/year did not match the PDF-derived metadata",
                provider.name()
            ));
        }
    }

    Ok(())
}

pub fn normalize_arxiv_id(value: &str) -> Option<String> {
    let trimmed = value
        .trim()
        .trim_start_matches("https://arxiv.org/abs/")
        .trim_start_matches("http://arxiv.org/abs/")
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:")
        .trim()
        .trim_matches([' ', '.', ',', ';', ')', ']', '}']);

    if trimmed.is_empty() {
        return None;
    }

    let lowered = trimmed.to_lowercase();
    let modern = Regex::new(r"^\d{4}\.\d{4,5}(?:v\d+)?$").expect("invalid arxiv modern regex");
    let legacy = Regex::new(r"^[a-z\-]+(?:\.[a-z\-]+)?/\d{7}(?:v\d+)?$")
        .expect("invalid arxiv legacy regex");

    if modern.is_match(&lowered) || legacy.is_match(&lowered) {
        Some(lowered)
    } else {
        None
    }
}

pub fn strip_xml_like_tags(value: &str) -> String {
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

pub fn decode_basic_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

pub fn clean_abstract_text(value: &str) -> String {
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

pub fn is_plausible_abstract(value: &str) -> bool {
    let cleaned = clean_abstract_text(value);
    let lower = cleaned.to_lowercase();

    cleaned.len() >= 40
        && cleaned.len() <= 5000
        && !lower.starts_with("introduction")
        && !lower.starts_with("keywords")
        && !lower.starts_with("contents")
}

pub fn looks_like_section_heading(line: &str) -> bool {
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

pub fn join_text_fragments(parts: &[String]) -> String {
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

pub fn extract_abstract_from_lines(lines: &[String]) -> Option<String> {
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
            .or_else(|| {
                line.split_once('.')
                    .map(|(_, rest)| rest.trim().to_string())
            })
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

pub fn extract_doi_from_text(value: &str) -> Option<String> {
    doi_regex()
        .captures(value)
        .and_then(|captures| captures.get(1).map(|matched| matched.as_str()))
        .and_then(normalize_doi)
}

pub fn extract_arxiv_id_from_text(value: &str) -> Option<String> {
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

pub fn extract_arxiv_id_from_filename(path: &std::path::Path) -> Option<String> {
    let stem = path.file_stem().and_then(|value| value.to_str())?;
    let modern = Regex::new(r"(?i)\b(\d{4}\.\d{4,5}(?:v\d+)?)\b").ok()?;
    modern
        .captures(stem)
        .and_then(|captures| captures.get(1).map(|matched| matched.as_str()))
        .and_then(normalize_arxiv_id)
}

pub fn clean_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let cleaned = clean_title_text(&text);
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    })
}

pub fn overwrite_if_present(target: &mut Option<String>, incoming: Option<String>) {
    if let Some(value) = incoming.filter(|value| !value.trim().is_empty()) {
        *target = Some(value);
    }
}

pub fn fill_if_missing(target: &mut Option<String>, incoming: Option<String>) {
    let is_missing = target
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true);
    if is_missing {
        overwrite_if_present(target, incoming);
    }
}

pub fn merge_arxiv_metadata(target: &mut ParsedPdfMetadata, incoming: ParsedPdfMetadata) {
    overwrite_if_present(&mut target.title, incoming.title);
    overwrite_if_present(&mut target.authors, incoming.authors);
    overwrite_if_present(&mut target.year, incoming.year);
    overwrite_if_present(&mut target.r#abstract, incoming.r#abstract);
    overwrite_if_present(&mut target.arxiv_id, incoming.arxiv_id);
    fill_if_missing(&mut target.doi, incoming.doi);
    fill_if_missing(&mut target.publication, incoming.publication);
    fill_if_missing(&mut target.publisher, incoming.publisher);
    fill_if_missing(&mut target.url, incoming.url);
}

pub fn merge_crossref_metadata(target: &mut ParsedPdfMetadata, incoming: ParsedPdfMetadata) {
    overwrite_if_present(&mut target.title, incoming.title);
    overwrite_if_present(&mut target.authors, incoming.authors);
    overwrite_if_present(&mut target.year, incoming.year);
    overwrite_if_present(&mut target.doi, incoming.doi);
    fill_if_missing(&mut target.r#abstract, incoming.r#abstract);
    overwrite_if_present(&mut target.publication, incoming.publication);
    overwrite_if_present(&mut target.volume, incoming.volume);
    overwrite_if_present(&mut target.issue, incoming.issue);
    overwrite_if_present(&mut target.pages, incoming.pages);
    overwrite_if_present(&mut target.publisher, incoming.publisher);
    overwrite_if_present(&mut target.url, incoming.url);
    overwrite_if_present(&mut target.language, incoming.language);
}

pub fn normalize_title_for_match(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn title_tokens(value: &str) -> HashSet<String> {
    normalize_title_for_match(value)
        .split_whitespace()
        .filter(|token| token.len() > 2)
        .map(|token| token.to_string())
        .collect::<HashSet<_>>()
}

pub fn title_match_score(left: &str, right: &str) -> f32 {
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

pub fn titles_confidently_match(left: &str, right: &str) -> bool {
    title_match_score(left, right) >= 0.72
}

fn strip_balanced_title_segments(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut round_depth = 0usize;
    let mut square_depth = 0usize;

    for ch in value.chars() {
        match ch {
            '(' => round_depth += 1,
            ')' => round_depth = round_depth.saturating_sub(1),
            '[' => square_depth += 1,
            ']' => square_depth = square_depth.saturating_sub(1),
            _ if round_depth == 0 && square_depth == 0 => output.push(ch),
            _ => {}
        }
    }

    clean_title_text(&output)
}

fn push_title_variant(variants: &mut Vec<String>, candidate: String) {
    let cleaned = clean_title_text(&candidate);
    if !is_plausible_title(&cleaned) {
        return;
    }

    let normalized = normalize_title_for_match(&cleaned);
    if normalized.is_empty() {
        return;
    }

    if variants
        .iter()
        .any(|existing| normalize_title_for_match(existing) == normalized)
    {
        return;
    }

    variants.push(cleaned);
}

pub fn build_title_query_variants(title: &str) -> Vec<String> {
    let cleaned = clean_title_text(title);
    let mut variants = Vec::new();

    push_title_variant(&mut variants, cleaned.clone());
    push_title_variant(&mut variants, strip_balanced_title_segments(&cleaned));

    for separator in [":", " - ", " | ", " -- "] {
        if let Some((prefix, _)) = cleaned.split_once(separator) {
            push_title_variant(&mut variants, prefix.to_string());
        }
    }

    if let Some(stripped) = cleaned
        .strip_prefix("arxiv:")
        .or_else(|| cleaned.strip_prefix("Arxiv:"))
        .or_else(|| cleaned.strip_prefix("preprint:"))
        .or_else(|| cleaned.strip_prefix("Preprint:"))
    {
        push_title_variant(&mut variants, stripped.to_string());
    }

    variants
}

pub fn is_preprint_publication(value: &str) -> bool {
    let lower = value.trim().to_lowercase();
    !lower.is_empty()
        && (lower.contains("arxiv")
            || lower.contains("biorxiv")
            || lower.contains("medrxiv")
            || lower.contains("chemrxiv")
            || lower.contains("openreview")
            || lower.contains("corr")
            || lower == "preprint")
}

pub fn is_preprint_metadata(meta: &ParsedPdfMetadata) -> bool {
    meta.publication
        .as_deref()
        .map(is_preprint_publication)
        .unwrap_or(false)
}

pub fn is_metadata_completed(meta: &ParsedPdfMetadata) -> bool {
    let title = meta.title.as_deref().map(str::trim).unwrap_or_default();
    let authors = meta.authors.as_deref().map(str::trim).unwrap_or_default();
    let publication = meta
        .publication
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    let year = meta.year.as_deref().map(str::trim).unwrap_or_default();

    !title.is_empty()
        && !authors.is_empty()
        && !publication.is_empty()
        && !year.is_empty()
        && !is_preprint_metadata(meta)
}

pub fn year_match_score(left: &str, right: &str) -> f32 {
    match (left.trim().parse::<i32>(), right.trim().parse::<i32>()) {
        (Ok(left_year), Ok(right_year)) if left_year == right_year => 1.0,
        (Ok(left_year), Ok(right_year)) if (left_year - right_year).abs() == 1 => 0.7,
        (Ok(_), Ok(_)) => 0.0,
        _ => 0.0,
    }
}

pub fn metadata_candidate_match_score(
    title: &str,
    authors: Option<&str>,
    year: Option<&str>,
    candidate: &ParsedPdfMetadata,
) -> f32 {
    let Some(candidate_title) = candidate.title.as_deref() else {
        return 0.0;
    };

    let title_score = title_match_score(title, candidate_title);
    if title_score == 0.0 {
        return 0.0;
    }

    let mut score = title_score;

    if let (Some(candidate_authors), Some(query_authors)) = (
        candidate
            .authors
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        authors.filter(|value| !value.trim().is_empty()),
    ) {
        let author_score = author_match_score(query_authors, candidate_authors);
        score = (score * 0.82) + (author_score * 0.18);

        if author_score < 0.2 && title_score < 0.95 {
            score *= 0.7;
        }
    }

    if let (Some(candidate_year), Some(query_year)) = (
        candidate
            .year
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        year.filter(|value| !value.trim().is_empty()),
    ) {
        let year_score = year_match_score(query_year, candidate_year);
        score = (score * 0.95) + (year_score * 0.05);

        if year_score == 0.0 && title_score < 0.95 {
            score *= 0.85;
        }
    }

    score
}

pub fn extract_xml_tag_values(block: &str, tag_name: &str) -> Vec<String> {
    let pattern = format!(
        r"(?is)<(?:[a-z0-9_\-]+:)?{}\b[^>]*>(.*?)</(?:[a-z0-9_\-]+:)?{}>",
        regex::escape(tag_name),
        regex::escape(tag_name)
    );
    let regex = Regex::new(&pattern).expect("invalid XML tag regex");
    regex
        .captures_iter(block)
        .filter_map(|captures| {
            captures
                .get(1)
                .map(|matched| clean_abstract_text(matched.as_str()))
        })
        .filter(|value| !value.is_empty())
        .collect()
}

pub fn extract_xml_tag_value(block: &str, tag_name: &str) -> Option<String> {
    extract_xml_tag_values(block, tag_name).into_iter().next()
}

pub fn parse_arxiv_year(value: &str) -> Option<String> {
    extract_year_from_text(value)
}

pub fn parse_arxiv_entry(block: &str) -> ParsedPdfMetadata {
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
    let year = extract_xml_tag_value(block, "published").and_then(|value| parse_arxiv_year(&value));
    let doi = extract_xml_tag_value(block, "doi").and_then(|value| normalize_doi(&value));
    let arxiv_id = extract_xml_tag_value(block, "id").and_then(|value| normalize_arxiv_id(&value));

    ParsedPdfMetadata {
        title,
        authors,
        year,
        r#abstract: summary,
        doi,
        arxiv_id,
        publication: Some("arXiv".to_string()),
        volume: None,
        issue: None,
        pages: None,
        publisher: Some("Cornell University".to_string()),
        isbn: None,
        url: extract_xml_tag_value(block, "id"),
        language: None,
    }
}

pub fn parse_arxiv_feed_entries(xml: &str) -> Vec<ParsedPdfMetadata> {
    xml_entry_regex()
        .captures_iter(xml)
        .filter_map(|captures| {
            captures
                .get(1)
                .map(|matched| parse_arxiv_entry(matched.as_str()))
        })
        .collect()
}

pub fn crossref_authors(authors: &[CrossrefAuthor]) -> Option<String> {
    let names = authors
        .iter()
        .filter_map(|author| {
            if let Some(name) = author
                .name
                .as_ref()
                .map(|value| clean_author_text(value))
                .filter(|value| !value.is_empty())
            {
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

pub fn crossref_year(message: &CrossrefWorkMessage) -> Option<String> {
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

pub fn crossref_message_to_metadata(message: CrossrefWorkMessage) -> ParsedPdfMetadata {
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
    let publication = message
        .container_title
        .iter()
        .map(|value| clean_title_text(value))
        .find(|value| !value.is_empty());
    let volume = message
        .volume
        .as_deref()
        .map(clean_title_text)
        .filter(|value| !value.is_empty());
    let issue = message
        .issue
        .as_deref()
        .map(clean_title_text)
        .filter(|value| !value.is_empty());
    let pages = message
        .page
        .as_deref()
        .map(clean_title_text)
        .filter(|value| !value.is_empty());
    let publisher = message
        .publisher
        .as_deref()
        .map(clean_title_text)
        .filter(|value| !value.is_empty());
    let url = message
        .resource
        .as_ref()
        .and_then(|resource| resource.primary.as_ref())
        .and_then(|primary| primary.url.as_deref())
        .map(clean_title_text)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            message
        .url
        .as_deref()
        .map(clean_title_text)
        .filter(|value| !value.is_empty())
        });
    let language = message
        .language
        .as_deref()
        .map(clean_title_text)
        .filter(|value| !value.is_empty());

    ParsedPdfMetadata {
        title,
        authors,
        year,
        r#abstract: abstract_text,
        doi,
        arxiv_id: None,
        publication,
        volume,
        issue,
        pages,
        publisher,
        isbn: None,
        url,
        language,
    }
}

pub fn openalex_abstract_to_text(
    abstract_inverted_index: &HashMap<String, Vec<usize>>,
) -> Option<String> {
    let max_index = abstract_inverted_index
        .values()
        .flat_map(|positions| positions.iter().copied())
        .max()?;
    let mut tokens = vec![String::new(); max_index + 1];

    for (word, positions) in abstract_inverted_index {
        for position in positions {
            if *position < tokens.len() {
                tokens[*position] = word.clone();
            }
        }
    }

    let abstract_text = tokens
        .into_iter()
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = clean_abstract_text(&abstract_text);
    if is_plausible_abstract(&cleaned) {
        Some(cleaned)
    } else {
        None
    }
}

fn openalex_authors(authorships: &[OpenAlexAuthorship]) -> Option<String> {
    let authors = authorships
        .iter()
        .filter_map(|authorship| {
            authorship
                .author
                .as_ref()
                .and_then(|author| author.display_name.as_deref())
                .map(clean_author_text)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    authorship
                        .raw_author_name
                        .as_deref()
                        .map(clean_author_text)
                        .filter(|value| !value.is_empty())
                })
        })
        .collect::<Vec<_>>();

    if authors.is_empty() {
        None
    } else {
        Some(authors.join(", "))
    }
}

fn openalex_work_to_metadata(work: OpenAlexWork) -> ParsedPdfMetadata {
    let doi = work.doi.as_deref().and_then(normalize_doi);
    let mut arxiv_id = doi
        .as_deref()
        .and_then(|value| value.split("/arxiv.").nth(1))
        .and_then(normalize_arxiv_id);
    let title =
        Some(clean_title_text(&work.display_name)).filter(|value| is_plausible_title(value));
    let authors = openalex_authors(&work.authorships);
    let year = work.publication_year.map(|year| year.to_string());

    let publication = work
        .primary_location
        .as_ref()
        .and_then(|location| {
            location
                .source
                .as_ref()
                .and_then(|source| source.display_name.clone())
                .or_else(|| location.raw_source_name.clone())
        })
        .map(|value| clean_title_text(&value))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if work.r#type.eq_ignore_ascii_case("preprint") && arxiv_id.is_some() {
                Some("arXiv".to_string())
            } else {
                None
            }
        });

    if arxiv_id.is_none() {
        arxiv_id = work
            .primary_location
            .as_ref()
            .and_then(|location| location.landing_page_url.as_deref())
            .and_then(normalize_arxiv_id);
    }

    let pages = work.biblio.as_ref().and_then(|biblio| {
        match (
            biblio.first_page.as_deref().map(clean_title_text),
            biblio.last_page.as_deref().map(clean_title_text),
        ) {
            (Some(first), Some(last)) if !first.is_empty() && !last.is_empty() && first != last => {
                Some(format!("{}-{}", first, last))
            }
            (Some(first), _) if !first.is_empty() => Some(first),
            _ => None,
        }
    });

    ParsedPdfMetadata {
        title,
        authors,
        year,
        r#abstract: work
            .abstract_inverted_index
            .as_ref()
            .and_then(openalex_abstract_to_text),
        doi,
        arxiv_id,
        publication,
        volume: work
            .biblio
            .as_ref()
            .and_then(|biblio| biblio.volume.as_deref())
            .map(clean_title_text)
            .filter(|value| !value.is_empty()),
        issue: work
            .biblio
            .as_ref()
            .and_then(|biblio| biblio.issue.as_deref())
            .map(clean_title_text)
            .filter(|value| !value.is_empty()),
        pages,
        publisher: work
            .primary_location
            .as_ref()
            .and_then(|location| location.source.as_ref())
            .and_then(|source| source.host_organization_name.as_deref())
            .map(clean_title_text)
            .filter(|value| !value.is_empty()),
        isbn: None,
        url: work
            .primary_location
            .as_ref()
            .and_then(|location| {
                location
                    .landing_page_url
                    .clone()
                    .or_else(|| location.pdf_url.clone())
            })
            .map(|value| clean_title_text(&value))
            .filter(|value| !value.is_empty()),
        language: work
            .language
            .as_deref()
            .map(clean_title_text)
            .filter(|value| !value.is_empty()),
    }
}

pub fn fetch_crossref_metadata_by_doi(doi: &str) -> Result<Option<ParsedPdfMetadata>, String> {
    let url = format!(
        "https://api.crossref.org/works/{}",
        urlencoding::encode(doi)
    );
    execute_metadata_request(MetadataProvider::CrossrefDoi, doi, || {
        retry_metadata_request(|| {
            let response = http_client()
                .get(&url)
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
        })
    })
}

pub fn fetch_openalex_metadata_by_doi(doi: &str) -> Result<Option<ParsedPdfMetadata>, String> {
    let filter = format!("doi:{}", doi);
    execute_metadata_request(MetadataProvider::OpenAlexDoi, doi, || {
        retry_metadata_request(|| {
            let payload = http_client()
                .get("https://api.openalex.org/works")
                .query(&[("filter", filter.clone()), ("per-page", "1".to_string())])
                .send()
                .map_err(|e| format!("OpenAlex DOI lookup failed: {}", e))?
                .error_for_status()
                .map_err(|e| format!("OpenAlex DOI lookup failed: {}", e))?
                .json::<OpenAlexWorksResponse>()
                .map_err(|e| format!("Failed to decode OpenAlex DOI response: {}", e))?;

            Ok(payload
                .results
                .into_iter()
                .next()
                .map(openalex_work_to_metadata))
        })
    })
}

pub fn fetch_crossref_metadata_by_title(
    title: &str,
    authors: Option<&str>,
    year: Option<&str>,
) -> Result<Option<ParsedPdfMetadata>, String> {
    let cache_query = format!(
        "{} | {} | {}",
        title,
        authors.unwrap_or(""),
        year.unwrap_or("")
    );
    execute_metadata_request(MetadataProvider::CrossrefTitle, &cache_query, || {
        retry_metadata_request(|| {
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
                    let parsed = crossref_message_to_metadata(item);
                    let score = metadata_candidate_match_score(title, authors, year, &parsed);
                    (score, parsed)
                })
                .filter(|(score, _)| *score >= FUZZY_METADATA_MATCH_THRESHOLD)
                .max_by(|(left_score, _), (right_score, _)| {
                    left_score
                        .partial_cmp(right_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(_, parsed)| parsed);

            Ok(candidate)
        })
    })
}

pub fn fetch_arxiv_metadata_by_id(arxiv_id: &str) -> Result<Option<ParsedPdfMetadata>, String> {
    execute_metadata_request(MetadataProvider::ArxivId, arxiv_id, || {
        retry_metadata_request(|| {
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
        })
    })
}

pub fn fetch_openalex_metadata_by_title(
    title: &str,
    authors: Option<&str>,
    year: Option<&str>,
) -> Result<Option<ParsedPdfMetadata>, String> {
    let cache_query = format!(
        "{} | {} | {}",
        title,
        authors.unwrap_or(""),
        year.unwrap_or("")
    );
    execute_metadata_request(MetadataProvider::OpenAlexTitle, &cache_query, || {
        retry_metadata_request(|| {
            let payload = http_client()
                .get("https://api.openalex.org/works")
                .query(&[("search", title.to_string()), ("per-page", "5".to_string())])
                .send()
                .map_err(|e| format!("OpenAlex title search failed: {}", e))?
                .error_for_status()
                .map_err(|e| format!("OpenAlex title search failed: {}", e))?
                .json::<OpenAlexWorksResponse>()
                .map_err(|e| format!("Failed to decode OpenAlex title response: {}", e))?;

            let candidate = payload
                .results
                .into_iter()
                .map(openalex_work_to_metadata)
                .map(|parsed| {
                    let score = metadata_candidate_match_score(title, authors, year, &parsed);
                    (score, parsed)
                })
                .filter(|(score, _)| *score >= FUZZY_METADATA_MATCH_THRESHOLD)
                .max_by(|(left_score, _), (right_score, _)| {
                    left_score
                        .partial_cmp(right_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(_, parsed)| parsed);

            Ok(candidate)
        })
    })
}

pub fn fetch_arxiv_metadata_by_title(
    title: &str,
    authors: Option<&str>,
    year: Option<&str>,
) -> Result<Option<ParsedPdfMetadata>, String> {
    let search_query = format!("ti:\"{}\"", title);
    let cache_query = format!(
        "{} | {} | {}",
        title,
        authors.unwrap_or(""),
        year.unwrap_or("")
    );
    execute_metadata_request(MetadataProvider::ArxivTitle, &cache_query, || {
        retry_metadata_request(|| {
            let xml = http_client()
                .get("https://export.arxiv.org/api/query")
                .query(&[
                    ("search_query", search_query.as_str()),
                    ("start", "0"),
                    ("max_results", "5"),
                ])
                .send()
                .map_err(|e| format!("arXiv title search failed: {}", e))?
                .error_for_status()
                .map_err(|e| format!("arXiv title search failed: {}", e))?
                .text()
                .map_err(|e| format!("Failed to read arXiv search response: {}", e))?;

            let candidate = parse_arxiv_feed_entries(&xml)
                .into_iter()
                .map(|parsed| {
                    let score = metadata_candidate_match_score(title, authors, year, &parsed);
                    (score, parsed)
                })
                .filter(|(score, _)| *score >= FUZZY_METADATA_MATCH_THRESHOLD)
                .max_by(|(left_score, _), (right_score, _)| {
                    left_score
                        .partial_cmp(right_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(_, parsed)| parsed);

            Ok(candidate)
        })
    })
}

fn metadata_option_changed(left: &Option<String>, right: &Option<String>) -> bool {
    let left_value = left
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let right_value = right
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    left_value != right_value
}

fn metadata_fields_changed(before: &ParsedPdfMetadata, after: &ParsedPdfMetadata) -> Vec<String> {
    let mut changed = Vec::new();

    if metadata_option_changed(&before.title, &after.title) {
        changed.push("title".to_string());
    }
    if metadata_option_changed(&before.authors, &after.authors) {
        changed.push("authors".to_string());
    }
    if metadata_option_changed(&before.year, &after.year) {
        changed.push("year".to_string());
    }
    if metadata_option_changed(&before.r#abstract, &after.r#abstract) {
        changed.push("abstract".to_string());
    }
    if metadata_option_changed(&before.doi, &after.doi) {
        changed.push("doi".to_string());
    }
    if metadata_option_changed(&before.arxiv_id, &after.arxiv_id) {
        changed.push("arxiv_id".to_string());
    }
    if metadata_option_changed(&before.publication, &after.publication) {
        changed.push("publication".to_string());
    }
    if metadata_option_changed(&before.volume, &after.volume) {
        changed.push("volume".to_string());
    }
    if metadata_option_changed(&before.issue, &after.issue) {
        changed.push("issue".to_string());
    }
    if metadata_option_changed(&before.pages, &after.pages) {
        changed.push("pages".to_string());
    }
    if metadata_option_changed(&before.publisher, &after.publisher) {
        changed.push("publisher".to_string());
    }
    if metadata_option_changed(&before.isbn, &after.isbn) {
        changed.push("isbn".to_string());
    }
    if metadata_option_changed(&before.url, &after.url) {
        changed.push("url".to_string());
    }
    if metadata_option_changed(&before.language, &after.language) {
        changed.push("language".to_string());
    }

    changed
}

fn update_report_state(
    report: &mut MetadataFetchReport,
    resolved: &ParsedPdfMetadata,
    network_complete: bool,
) {
    report.network_complete = network_complete;
    report.metadata_completed = is_metadata_completed(resolved);
    report.is_preprint = is_preprint_metadata(resolved);
}

fn build_report_summary(report: &MetadataFetchReport) -> String {
    let last_useful_step = report
        .steps
        .iter()
        .rev()
        .find(|step| matches!(step.status.as_str(), "hit" | "redundant"));

    let state = if report.metadata_completed {
        "complete"
    } else if report.is_preprint {
        "preprint"
    } else {
        "partial"
    };

    match last_useful_step {
        Some(step) if !step.fields_changed.is_empty() => format!(
            "{} metadata after {} via {} ({})",
            state,
            step.stage,
            step.provider,
            step.fields_changed.join(", ")
        ),
        Some(step) => format!("{} metadata confirmed via {}", state, step.provider),
        None if report.network_complete => format!("{} metadata with no remote matches", state),
        None => format!("{} metadata with network gaps", state),
    }
}

fn merge_metadata_field(
    current: &mut Option<String>,
    incoming: Option<String>,
    priority_slot: &mut usize,
    incoming_priority: usize,
) {
    let incoming_value = incoming
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let current_value = current
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let Some(incoming_value) = incoming_value else {
        return;
    };

    if current_value.as_deref() == Some(incoming_value.as_str()) {
        return;
    }

    if current_value.is_none() || incoming_priority < *priority_slot {
        *current = Some(incoming_value);
        *priority_slot = incoming_priority;
    }
}

fn merge_provider_metadata(
    target: &mut ParsedPdfMetadata,
    priorities: &mut MetadataMergePriority,
    incoming: ParsedPdfMetadata,
    provider: MetadataProvider,
) {
    let provider_priority = provider.priority();
    let target_is_preprint = is_preprint_metadata(target);
    let incoming_is_preprint = is_preprint_metadata(&incoming);
    let can_override_bibliographic_fields = !incoming_is_preprint || target_is_preprint;

    merge_metadata_field(
        &mut target.title,
        incoming.title,
        &mut priorities.title,
        provider_priority,
    );
    merge_metadata_field(
        &mut target.authors,
        incoming.authors,
        &mut priorities.authors,
        provider_priority,
    );
    merge_metadata_field(
        &mut target.r#abstract,
        incoming.r#abstract,
        &mut priorities.abstract_text,
        provider_priority,
    );
    merge_metadata_field(
        &mut target.doi,
        incoming.doi,
        &mut priorities.doi,
        provider_priority,
    );
    merge_metadata_field(
        &mut target.arxiv_id,
        incoming.arxiv_id,
        &mut priorities.arxiv_id,
        provider_priority,
    );
    merge_metadata_field(
        &mut target.url,
        incoming.url,
        &mut priorities.url,
        provider_priority,
    );
    merge_metadata_field(
        &mut target.language,
        incoming.language,
        &mut priorities.language,
        provider_priority,
    );

    if can_override_bibliographic_fields {
        merge_metadata_field(
            &mut target.year,
            incoming.year,
            &mut priorities.year,
            provider_priority,
        );
        merge_metadata_field(
            &mut target.publication,
            incoming.publication,
            &mut priorities.publication,
            provider_priority,
        );
        merge_metadata_field(
            &mut target.volume,
            incoming.volume,
            &mut priorities.volume,
            provider_priority,
        );
        merge_metadata_field(
            &mut target.issue,
            incoming.issue,
            &mut priorities.issue,
            provider_priority,
        );
        merge_metadata_field(
            &mut target.pages,
            incoming.pages,
            &mut priorities.pages,
            provider_priority,
        );
        merge_metadata_field(
            &mut target.publisher,
            incoming.publisher,
            &mut priorities.publisher,
            provider_priority,
        );
        merge_metadata_field(
            &mut target.isbn,
            incoming.isbn,
            &mut priorities.isbn,
            provider_priority,
        );
    }
}

fn apply_provider_result(
    resolved: &mut ParsedPdfMetadata,
    priorities: &mut MetadataMergePriority,
    report: &mut MetadataFetchReport,
    network_complete: &mut bool,
    stage: MetadataStage,
    provider: MetadataProvider,
    query: String,
    score: Option<f32>,
    result: Result<Option<ParsedPdfMetadata>, String>,
) -> bool {
    match result {
        Ok(Some(incoming)) => {
            if let Err(note) =
                validate_incoming_metadata(resolved, &incoming, provider, stage, &query)
            {
                if matches!(
                    provider,
                    MetadataProvider::CrossrefDoi | MetadataProvider::OpenAlexDoi
                ) && stage.is_precise_like()
                    && resolved.doi.as_deref().and_then(normalize_doi) == normalize_doi(&query)
                {
                    resolved.doi = None;
                    priorities.doi = usize::MAX;
                }

                report.steps.push(MetadataFetchStep {
                    stage: stage.name().to_string(),
                    provider: provider.name().to_string(),
                    query,
                    status: "miss".to_string(),
                    score,
                    fields_changed: Vec::new(),
                    note: Some(note),
                    metadata_completed: is_metadata_completed(resolved),
                });
                update_report_state(report, resolved, *network_complete);
                return false;
            }

            let incoming = sanitize_incoming_metadata(resolved, incoming, provider, stage, score);
            let before = resolved.clone();
            merge_provider_metadata(resolved, priorities, incoming, provider);
            let fields_changed = metadata_fields_changed(&before, resolved);
            report.steps.push(MetadataFetchStep {
                stage: stage.name().to_string(),
                provider: provider.name().to_string(),
                query,
                status: if fields_changed.is_empty() {
                    "redundant".to_string()
                } else {
                    "hit".to_string()
                },
                score,
                fields_changed,
                note: None,
                metadata_completed: is_metadata_completed(resolved),
            });
            update_report_state(report, resolved, *network_complete);
            true
        }
        Ok(None) => {
            report.steps.push(MetadataFetchStep {
                stage: stage.name().to_string(),
                provider: provider.name().to_string(),
                query,
                status: "miss".to_string(),
                score,
                fields_changed: Vec::new(),
                note: None,
                metadata_completed: is_metadata_completed(resolved),
            });
            update_report_state(report, resolved, *network_complete);
            false
        }
        Err(error) => {
            *network_complete = false;
            report.steps.push(MetadataFetchStep {
                stage: stage.name().to_string(),
                provider: provider.name().to_string(),
                query,
                status: "error".to_string(),
                score,
                fields_changed: Vec::new(),
                note: Some(error),
                metadata_completed: is_metadata_completed(resolved),
            });
            update_report_state(report, resolved, *network_complete);
            false
        }
    }
}

fn apply_precise_provider(
    resolved: &mut ParsedPdfMetadata,
    priorities: &mut MetadataMergePriority,
    report: &mut MetadataFetchReport,
    network_complete: &mut bool,
    stage: MetadataStage,
    provider: MetadataProvider,
    query: String,
    result: Result<Option<ParsedPdfMetadata>, String>,
) {
    let _ = apply_provider_result(
        resolved,
        priorities,
        report,
        network_complete,
        stage,
        provider,
        query,
        None,
        result,
    );
}

fn run_precise_provider_lookup(
    provider: MetadataProvider,
    query: &str,
) -> Result<Option<ParsedPdfMetadata>, String> {
    match provider {
        MetadataProvider::ArxivId => fetch_arxiv_metadata_by_id(query),
        MetadataProvider::CrossrefDoi => fetch_crossref_metadata_by_doi(query),
        MetadataProvider::OpenAlexDoi => fetch_openalex_metadata_by_doi(query),
        _ => Err(format!(
            "unsupported precise metadata provider: {}",
            provider.name()
        )),
    }
}

fn collect_precise_provider_results(
    mut lookups: Vec<(MetadataProvider, String)>,
) -> Vec<(
    MetadataProvider,
    String,
    Result<Option<ParsedPdfMetadata>, String>,
)> {
    lookups.sort_by_key(|(provider, _)| provider.priority());

    if lookups.len() <= 1 {
        return lookups
            .into_iter()
            .map(|(provider, query)| {
                let result = run_precise_provider_lookup(provider, &query);
                (provider, query, result)
            })
            .collect();
    }

    thread::scope(|scope| {
        let mut handles = Vec::new();

        for (provider, query) in lookups {
            let query_for_task = query.clone();
            let handle =
                scope.spawn(move || run_precise_provider_lookup(provider, &query_for_task));
            handles.push((provider, query, handle));
        }

        handles
            .into_iter()
            .map(|(provider, query, handle)| {
                let result = handle
                    .join()
                    .unwrap_or_else(|_| Err(format!("{} lookup panicked", provider.name())));
                (provider, query, result)
            })
            .collect()
    })
}

fn apply_precise_provider_batch(
    resolved: &mut ParsedPdfMetadata,
    priorities: &mut MetadataMergePriority,
    report: &mut MetadataFetchReport,
    network_complete: &mut bool,
    stage: MetadataStage,
    lookups: Vec<(MetadataProvider, String)>,
) {
    for (provider, query, result) in collect_precise_provider_results(lookups) {
        apply_precise_provider(
            resolved,
            priorities,
            report,
            network_complete,
            stage,
            provider,
            query,
            result,
        );
    }
}

fn apply_fuzzy_provider_with_queries(
    resolved: &mut ParsedPdfMetadata,
    priorities: &mut MetadataMergePriority,
    report: &mut MetadataFetchReport,
    network_complete: &mut bool,
    provider: MetadataProvider,
    original_title: &str,
    queries: &[String],
) {
    for query in queries {
        let authors = resolved.authors.clone();
        let year = resolved.year.clone();
        let result = match provider {
            MetadataProvider::OpenAlexTitle => {
                fetch_openalex_metadata_by_title(query, authors.as_deref(), year.as_deref())
            }
            MetadataProvider::CrossrefTitle => {
                fetch_crossref_metadata_by_title(query, authors.as_deref(), year.as_deref())
            }
            MetadataProvider::ArxivTitle => {
                fetch_arxiv_metadata_by_title(query, authors.as_deref(), year.as_deref())
            }
            _ => continue,
        };

        let score = match &result {
            Ok(Some(incoming)) => Some(metadata_candidate_match_score(
                original_title,
                authors.as_deref(),
                year.as_deref(),
                incoming,
            )),
            _ => None,
        };

        if apply_provider_result(
            resolved,
            priorities,
            report,
            network_complete,
            MetadataStage::Fuzzy,
            provider,
            query.clone(),
            score,
            result,
        ) {
            break;
        }
    }
}

pub fn enrich_metadata_with_remote_providers(
    local: &ParsedPdfMetadata,
) -> RemoteMetadataEnrichmentResult {
    let mut resolved = local.clone();
    let mut priorities = MetadataMergePriority::new();
    let mut network_complete = true;
    let original_doi = resolved.doi.clone();
    let original_arxiv_id = resolved.arxiv_id.clone();
    let mut report = MetadataFetchReport {
        network_complete,
        metadata_completed: is_metadata_completed(&resolved),
        is_preprint: is_preprint_metadata(&resolved),
        ..MetadataFetchReport::default()
    };

    let mut initial_precise_lookups = Vec::new();
    if let Some(doi) = resolved.doi.clone() {
        initial_precise_lookups.push((MetadataProvider::OpenAlexDoi, doi.clone()));
        initial_precise_lookups.push((MetadataProvider::CrossrefDoi, doi));
    }
    if let Some(arxiv_id) = resolved.arxiv_id.clone() {
        initial_precise_lookups.push((MetadataProvider::ArxivId, arxiv_id));
    }
    apply_precise_provider_batch(
        &mut resolved,
        &mut priorities,
        &mut report,
        &mut network_complete,
        MetadataStage::Precise,
        initial_precise_lookups,
    );

    if let Some(title) = resolved.title.clone() {
        report.title_queries = build_title_query_variants(&title);
        let title_queries = report.title_queries.clone();
        if !is_metadata_completed(&resolved) {
            apply_fuzzy_provider_with_queries(
                &mut resolved,
                &mut priorities,
                &mut report,
                &mut network_complete,
                MetadataProvider::OpenAlexTitle,
                &title,
                &title_queries,
            );

            if !is_metadata_completed(&resolved) {
                apply_fuzzy_provider_with_queries(
                    &mut resolved,
                    &mut priorities,
                    &mut report,
                    &mut network_complete,
                    MetadataProvider::CrossrefTitle,
                    &title,
                    &title_queries,
                );
            }

            if !is_metadata_completed(&resolved) {
                apply_fuzzy_provider_with_queries(
                    &mut resolved,
                    &mut priorities,
                    &mut report,
                    &mut network_complete,
                    MetadataProvider::ArxivTitle,
                    &title,
                    &title_queries,
                );
            }
        }
    }

    if resolved.doi != original_doi {
        if let Some(doi) = resolved.doi.clone() {
            apply_precise_provider_batch(
                &mut resolved,
                &mut priorities,
                &mut report,
                &mut network_complete,
                MetadataStage::Refresh,
                vec![
                    (MetadataProvider::OpenAlexDoi, doi.clone()),
                    (MetadataProvider::CrossrefDoi, doi),
                ],
            );
        }
    }

    if resolved.arxiv_id != original_arxiv_id {
        if let Some(arxiv_id) = resolved.arxiv_id.clone() {
            apply_precise_provider_batch(
                &mut resolved,
                &mut priorities,
                &mut report,
                &mut network_complete,
                MetadataStage::Refresh,
                vec![(MetadataProvider::ArxivId, arxiv_id)],
            );
        }
    }

    update_report_state(&mut report, &resolved, network_complete);
    report.summary = build_report_summary(&report);

    RemoteMetadataEnrichmentResult {
        meta: resolved,
        network_complete,
        report,
    }
}

#[tauri::command]
pub fn update_item_metadata(
    payload: crate::models::UpdateMetadataPayload,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<(), String> {
    let conn_mutex = state.db.clone();
    let conn = conn_mutex
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    let mut stmt = conn.prepare("UPDATE items SET title = ?1, authors = ?2, year = ?3, abstract = ?4, doi = ?5, arxiv_id = ?6, publication = ?7, volume = ?8, issue = ?9, pages = ?10, publisher = ?11, isbn = ?12, url = ?13, language = ?14, date_modified = datetime('now') WHERE id = ?15").map_err(|e| format!("Prepare error: {}", e))?;
    stmt.execute(rusqlite::params![
        payload.title,
        payload.authors,
        payload.year,
        payload.r#abstract,
        payload.doi,
        payload.arxiv_id,
        payload.publication,
        payload.volume,
        payload.issue,
        payload.pages,
        payload.publisher,
        payload.isbn,
        payload.url,
        payload.language,
        payload.id
    ])
    .map_err(|e| format!("Execute error: {}", e))?;

    // Sync tags – replace all existing tags for this item
    conn.execute(
        "DELETE FROM item_tags WHERE item_id = ?1",
        rusqlite::params![payload.id],
    )
    .map_err(|e| format!("Failed to clear tags: {}", e))?;
    for tag in &payload.tags {
        let t = tag.trim();
        if !t.is_empty() {
            conn.execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?1, ?2)",
                rusqlite::params![payload.id, t],
            )
            .map_err(|e| format!("Failed to insert tag: {}", e))?;
            crate::library_commands::ensure_tag_color_for_tag(&conn, t)?;
        }
    }

    Ok(())
}

fn has_meaningful_metadata(meta: &ParsedPdfMetadata) -> bool {
    [
        meta.title.as_deref(),
        meta.authors.as_deref(),
        meta.r#abstract.as_deref(),
        meta.doi.as_deref(),
        meta.arxiv_id.as_deref(),
        meta.publication.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| !value.trim().is_empty())
}

fn pick_metadata_value(current: &str, incoming: &Option<String>) -> String {
    incoming
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(current)
        .to_string()
}

fn has_meaningful_item_value(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed != "—"
}

fn pick_metadata_value_with_override(
    current: &str,
    incoming: &Option<String>,
    allow_override: bool,
) -> String {
    if !allow_override && has_meaningful_item_value(current) {
        return current.to_string();
    }

    pick_metadata_value(current, incoming)
}

fn pick_metadata_value_if_allowed(
    current: &str,
    incoming: &Option<String>,
    allow_fill: bool,
    allow_override: bool,
) -> String {
    if !allow_fill {
        return current.to_string();
    }

    pick_metadata_value_with_override(current, incoming, allow_override)
}

fn pick_item_url(current: &LibraryItem, parsed: &ParsedPdfMetadata) -> String {
    let Some(incoming_url) = parsed
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return current.url.clone();
    };

    let current_url = current.url.trim();
    if has_meaningful_item_value(current_url) {
        if let Some(incoming_doi) = normalize_doi_url(incoming_url) {
            let current_doi = normalize_doi(&current.doi);
            let parsed_doi = parsed.doi.as_deref().and_then(normalize_doi);

            // Do not replace an existing landing page URL with a DOI redirect
            // unless the DOI is already confirmed by the current item.
            if normalize_doi_url(current_url).is_none()
                && current_doi.as_deref() != Some(incoming_doi.as_str())
            {
                return current.url.clone();
            }

            if let Some(known_doi) = current_doi.or(parsed_doi) {
                if known_doi != incoming_doi {
                    return current.url.clone();
                }
            }
        }
    }

    incoming_url.to_string()
}

fn merge_item_with_parsed_metadata(
    current: &LibraryItem,
    parsed: &ParsedPdfMetadata,
) -> LibraryItem {
    let current_is_preprint = is_preprint_publication(&current.publication);
    let incoming_is_preprint = is_preprint_metadata(parsed);
    let can_override_bibliographic_fields = !incoming_is_preprint || current_is_preprint;
    let can_fill_publisher = item_type_supports_automatic_publisher(&current.item_type);

    LibraryItem {
        id: current.id.clone(),
        item_type: current.item_type.clone(),
        title: pick_metadata_value(&current.title, &parsed.title),
        authors: pick_metadata_value(&current.authors, &parsed.authors),
        year: pick_metadata_value_with_override(
            &current.year,
            &parsed.year,
            can_override_bibliographic_fields,
        ),
        r#abstract: pick_metadata_value(&current.r#abstract, &parsed.r#abstract),
        doi: pick_metadata_value(&current.doi, &parsed.doi),
        arxiv_id: pick_metadata_value(&current.arxiv_id, &parsed.arxiv_id),
        publication: pick_metadata_value_with_override(
            &current.publication,
            &parsed.publication,
            can_override_bibliographic_fields,
        ),
        volume: pick_metadata_value_with_override(
            &current.volume,
            &parsed.volume,
            can_override_bibliographic_fields,
        ),
        issue: pick_metadata_value_with_override(
            &current.issue,
            &parsed.issue,
            can_override_bibliographic_fields,
        ),
        pages: pick_metadata_value_with_override(
            &current.pages,
            &parsed.pages,
            can_override_bibliographic_fields,
        ),
        publisher: pick_metadata_value_if_allowed(
            &current.publisher,
            &parsed.publisher,
            can_fill_publisher,
            can_override_bibliographic_fields,
        ),
        isbn: pick_metadata_value_with_override(
            &current.isbn,
            &parsed.isbn,
            can_override_bibliographic_fields,
        ),
        url: pick_item_url(current, parsed),
        language: pick_metadata_value(&current.language, &parsed.language),
        date_added: current.date_added.clone(),
        date_modified: current.date_modified.clone(),
        folder_path: current.folder_path.clone(),
        tags: current.tags.clone(),
        attachments: current.attachments.clone(),
    }
}
#[tauri::command]
pub fn retrieve_item_metadata(
    item_id: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<RetrieveMetadataResult, String> {
    refresh_item_metadata_in_db(&state.db, &item_id)
}

pub fn refresh_item_metadata_in_db(
    db: &Arc<Mutex<rusqlite::Connection>>,
    item_id: &str,
) -> Result<RetrieveMetadataResult, String> {
    let current_item = {
        let conn = db
            .lock()
            .map_err(|e| format!("Database lock error: {}", e))?;

        crate::library_commands::fetch_item_from_db(&conn, item_id)
            .map_err(|e| format!("Failed to load current item: {}", e))?
            .ok_or("Item not found".to_string())?
    };

    let pdf_path = current_item
        .attachments
        .iter()
        .find(|attachment| attachment.attachment_type.eq_ignore_ascii_case("PDF"))
        .map(|attachment| attachment.path.clone())
        .unwrap_or_else(|| current_item.id.clone());

    let pdf_path_buf = std::path::PathBuf::from(&pdf_path);
    if !pdf_path_buf.exists() {
        return Err("PDF file does not exist".to_string());
    }

    crate::library_commands::remove_cached_pdf_metadata(&pdf_path_buf);
    let resolved = crate::library_commands::resolve_pdf_metadata_with_report(&pdf_path_buf);
    if !has_meaningful_metadata(&resolved.meta) {
        return Err("No metadata could be identified for this PDF".to_string());
    }

    let merged = merge_item_with_parsed_metadata(&current_item, &resolved.meta);

    let conn = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;

    conn.execute(
        "UPDATE items SET title = ?1, authors = ?2, year = ?3, abstract = ?4, doi = ?5, arxiv_id = ?6, publication = ?7, volume = ?8, issue = ?9, pages = ?10, publisher = ?11, isbn = ?12, url = ?13, language = ?14, date_modified = datetime('now') WHERE id = ?15",
        rusqlite::params![
            merged.title,
            merged.authors,
            merged.year,
            merged.r#abstract,
            merged.doi,
            merged.arxiv_id,
            merged.publication,
            merged.volume,
            merged.issue,
            merged.pages,
            merged.publisher,
            merged.isbn,
            merged.url,
            merged.language,
            merged.id,
        ],
    )
    .map_err(|e| format!("Failed to update item metadata: {}", e))?;

    let item = crate::library_commands::fetch_item_from_db(&conn, item_id)
        .map_err(|e| format!("Failed to reload item metadata: {}", e))?
        .ok_or("Updated item not found".to_string())?;

    Ok(RetrieveMetadataResult {
        item,
        report: resolved.report,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        author_match_score, build_title_query_variants, crossref_message_to_metadata,
        is_metadata_completed, is_preprint_metadata, item_type_supports_automatic_publisher,
        merge_item_with_parsed_metadata, merge_provider_metadata, metadata_candidate_match_score,
        metadata_request_cache_key, normalize_arxiv_id, openalex_work_to_metadata,
        sanitize_incoming_metadata, strip_invalid_metadata_url_with, validate_incoming_metadata,
        MetadataMergePriority, MetadataProvider, MetadataStage, OpenAlexAuthor, OpenAlexAuthorship,
        OpenAlexBiblio, OpenAlexPrimaryLocation, OpenAlexSource, OpenAlexWork,
        ParsedPdfMetadata,
    };
    use crate::models::{CrossrefWorkMessage, LibraryAttachment, LibraryItem};

    fn sample_item() -> LibraryItem {
        LibraryItem {
            id: "paper-1".to_string(),
            item_type: "Journal Article".to_string(),
            title: "Fallback Title".to_string(),
            authors: "Existing Author".to_string(),
            year: "2023".to_string(),
            r#abstract: "".to_string(),
            doi: "".to_string(),
            arxiv_id: "".to_string(),
            publication: "".to_string(),
            volume: "".to_string(),
            issue: "".to_string(),
            pages: "".to_string(),
            publisher: "".to_string(),
            isbn: "".to_string(),
            url: "".to_string(),
            language: "".to_string(),
            date_added: "1710000000".to_string(),
            date_modified: "1710000000".to_string(),
            folder_path: "root".to_string(),
            tags: vec!["ml".to_string()],
            attachments: vec![LibraryAttachment {
                id: "att-paper-1".to_string(),
                item_id: "paper-1".to_string(),
                name: "paper".to_string(),
                path: "/tmp/paper.pdf".to_string(),
                attachment_type: "PDF".to_string(),
            }],
        }
    }

    #[test]
    fn crossref_message_to_metadata_extracts_extended_fields() {
        let message = CrossrefWorkMessage {
            title: vec!["Attention Is All You Need".to_string()],
            container_title: vec!["NeurIPS".to_string()],
            author: vec![],
            published_print: None,
            published_online: None,
            created: None,
            issued: None,
            abstract_field: Some("<jats:p>Sequence models are powerful.</jats:p>".to_string()),
            doi: "10.5555/test-doi".to_string(),
            volume: Some("30".to_string()),
            issue: Some("1".to_string()),
            page: Some("100-110".to_string()),
            publisher: Some("Curran Associates".to_string()),
            resource: None,
            url: Some("https://example.com/paper".to_string()),
            language: Some("en".to_string()),
        };

        let parsed = crossref_message_to_metadata(message);

        assert_eq!(parsed.publication.as_deref(), Some("NeurIPS"));
        assert_eq!(parsed.volume.as_deref(), Some("30"));
        assert_eq!(parsed.issue.as_deref(), Some("1"));
        assert_eq!(parsed.pages.as_deref(), Some("100-110"));
        assert_eq!(parsed.publisher.as_deref(), Some("Curran Associates"));
        assert_eq!(parsed.url.as_deref(), Some("https://example.com/paper"));
        assert_eq!(parsed.language.as_deref(), Some("en"));
    }

    #[test]
    fn crossref_message_to_metadata_prefers_primary_resource_url() {
        let message = CrossrefWorkMessage {
            title: vec!["Attention Is All You Need".to_string()],
            container_title: vec![],
            author: vec![],
            published_print: None,
            published_online: None,
            created: None,
            issued: None,
            abstract_field: None,
            doi: "10.5555/test-doi".to_string(),
            volume: None,
            issue: None,
            page: None,
            publisher: None,
            resource: Some(crate::models::CrossrefResource {
                primary: Some(crate::models::CrossrefPrimaryResource {
                    url: Some("https://publisher.example.com/paper".to_string()),
                }),
            }),
            url: Some("https://doi.org/10.5555/test-doi".to_string()),
            language: None,
        };

        let parsed = crossref_message_to_metadata(message);

        assert_eq!(
            parsed.url.as_deref(),
            Some("https://publisher.example.com/paper")
        );
    }

    #[test]
    fn merge_item_with_parsed_metadata_preserves_existing_values_when_missing() {
        let item = sample_item();
        let parsed = ParsedPdfMetadata {
            title: Some("Updated Title".to_string()),
            authors: None,
            year: Some("2024".to_string()),
            r#abstract: Some("New abstract".to_string()),
            doi: Some("10.1000/example".to_string()),
            arxiv_id: None,
            publication: Some("Journal of Testing".to_string()),
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            isbn: None,
            url: Some("https://example.com".to_string()),
            language: None,
        };

        let merged = merge_item_with_parsed_metadata(&item, &parsed);

        assert_eq!(merged.title, "Updated Title");
        assert_eq!(merged.authors, "Existing Author");
        assert_eq!(merged.year, "2024");
        assert_eq!(merged.publication, "Journal of Testing");
        assert_eq!(merged.url, "https://example.com");
        assert_eq!(merged.tags, vec!["ml".to_string()]);
    }

    #[test]
    fn merge_item_with_parsed_metadata_preserves_formal_publication_against_preprint() {
        let mut item = sample_item();
        item.year = "2018".to_string();
        item.publication = "NeurIPS".to_string();
        item.volume = "31".to_string();
        item.pages = "6000-6010".to_string();

        let parsed = ParsedPdfMetadata {
            year: Some("2017".to_string()),
            publication: Some("arXiv".to_string()),
            volume: Some("1".to_string()),
            pages: Some("1-10".to_string()),
            arxiv_id: Some("1706.03762".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let merged = merge_item_with_parsed_metadata(&item, &parsed);

        assert_eq!(merged.publication, "NeurIPS");
        assert_eq!(merged.year, "2018");
        assert_eq!(merged.volume, "31");
        assert_eq!(merged.pages, "6000-6010");
        assert_eq!(merged.arxiv_id, "1706.03762");
    }

    #[test]
    fn merge_item_with_parsed_metadata_does_not_autofill_publisher_for_articles() {
        let item = sample_item();
        let parsed = ParsedPdfMetadata {
            publication: Some("Nature".to_string()),
            publisher: Some("Springer Nature".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let merged = merge_item_with_parsed_metadata(&item, &parsed);

        assert_eq!(merged.publication, "Nature");
        assert_eq!(merged.publisher, "");
    }

    #[test]
    fn merge_item_with_parsed_metadata_allows_publisher_for_books() {
        let mut item = sample_item();
        item.item_type = "Book".to_string();
        let parsed = ParsedPdfMetadata {
            publisher: Some("MIT Press".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let merged = merge_item_with_parsed_metadata(&item, &parsed);

        assert_eq!(merged.publisher, "MIT Press");
    }

    #[test]
    fn openalex_work_to_metadata_extracts_extended_fields() {
        let work = OpenAlexWork {
            display_name: "Attention Is All You Need".to_string(),
            doi: Some("https://doi.org/10.48550/arxiv.1706.03762".to_string()),
            publication_year: Some(2017),
            r#type: "preprint".to_string(),
            language: Some("en".to_string()),
            primary_location: Some(OpenAlexPrimaryLocation {
                landing_page_url: Some("https://arxiv.org/abs/1706.03762".to_string()),
                pdf_url: None,
                source: None,
                raw_source_name: None,
            }),
            authorships: vec![OpenAlexAuthorship {
                author: Some(OpenAlexAuthor {
                    display_name: Some("Ashish Vaswani".to_string()),
                }),
                raw_author_name: None,
            }],
            biblio: Some(OpenAlexBiblio {
                volume: Some("30".to_string()),
                issue: Some("1".to_string()),
                first_page: Some("5998".to_string()),
                last_page: Some("6008".to_string()),
            }),
            abstract_inverted_index: Some(std::collections::HashMap::from([
                ("Attention".to_string(), vec![0]),
                ("is".to_string(), vec![1]),
                ("all".to_string(), vec![2]),
                ("you".to_string(), vec![3]),
                ("need".to_string(), vec![4]),
            ])),
        };

        let parsed = openalex_work_to_metadata(work);

        assert_eq!(parsed.title.as_deref(), Some("Attention Is All You Need"));
        assert_eq!(parsed.authors.as_deref(), Some("Ashish Vaswani"));
        assert_eq!(parsed.publication.as_deref(), Some("arXiv"));
        assert_eq!(parsed.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(parsed.pages.as_deref(), Some("5998-6008"));
        assert_eq!(parsed.language.as_deref(), Some("en"));
    }

    #[test]
    fn sanitize_incoming_metadata_strips_openalex_publisher() {
        let current = ParsedPdfMetadata::default();
        let incoming = ParsedPdfMetadata {
            publisher: Some("Elsevier".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let sanitized = sanitize_incoming_metadata(
            &current,
            incoming,
            MetadataProvider::OpenAlexDoi,
            MetadataStage::Precise,
            None,
        );

        assert_eq!(sanitized.publisher, None);
    }

    #[test]
    fn sanitize_incoming_metadata_strips_identifiers_from_fuzzy_results() {
        let current = ParsedPdfMetadata::default();
        let incoming = ParsedPdfMetadata {
            doi: Some("10.1000/example".to_string()),
            arxiv_id: Some("1706.03762".to_string()),
            publisher: Some("Fake Publisher".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let sanitized = sanitize_incoming_metadata(
            &current,
            incoming,
            MetadataProvider::CrossrefTitle,
            MetadataStage::Fuzzy,
            Some(0.96),
        );

        assert_eq!(sanitized.doi, None);
        assert_eq!(sanitized.arxiv_id, None);
        assert_eq!(sanitized.publisher, None);
    }

    #[test]
    fn sanitize_incoming_metadata_strips_doi_urls_from_fuzzy_results() {
        let current = ParsedPdfMetadata::default();
        let incoming = ParsedPdfMetadata {
            url: Some("https://doi.org/10.65215/2q58a426".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let sanitized = sanitize_incoming_metadata(
            &current,
            incoming,
            MetadataProvider::OpenAlexTitle,
            MetadataStage::Fuzzy,
            Some(0.88),
        );

        assert_eq!(sanitized.url, None);
    }

    #[test]
    fn validate_incoming_metadata_rejects_exact_doi_result_that_mismatches_context() {
        let current = ParsedPdfMetadata {
            title: Some("Attention Is All You Need".to_string()),
            authors: Some("Ashish Vaswani, Noam Shazeer".to_string()),
            year: Some("2017".to_string()),
            doi: Some("10.1111/wrong".to_string()),
            ..ParsedPdfMetadata::default()
        };
        let incoming = ParsedPdfMetadata {
            title: Some("A Completely Different Paper".to_string()),
            authors: Some("Different Author".to_string()),
            year: Some("2024".to_string()),
            doi: Some("10.1111/wrong".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let result = validate_incoming_metadata(
            &current,
            &incoming,
            MetadataProvider::CrossrefDoi,
            MetadataStage::Precise,
            "10.1111/wrong",
        );

        assert!(result.is_err());
    }

    #[test]
    fn item_type_supports_automatic_publisher_is_restricted_to_bookish_types() {
        assert!(item_type_supports_automatic_publisher("Book"));
        assert!(item_type_supports_automatic_publisher("thesis"));
        assert!(!item_type_supports_automatic_publisher("Journal Article"));
        assert!(!item_type_supports_automatic_publisher("conferencePaper"));
    }

    #[test]
    fn normalize_arxiv_id_rejects_non_arxiv_urls() {
        assert_eq!(
            normalize_arxiv_id("https://doi.org/10.65215/2q58a426"),
            None
        );
        assert_eq!(
            normalize_arxiv_id("1706.03762"),
            Some("1706.03762".to_string())
        );
        assert_eq!(
            normalize_arxiv_id("https://arxiv.org/abs/1706.03762v1"),
            Some("1706.03762v1".to_string())
        );
    }

    #[test]
    fn strip_invalid_metadata_url_removes_404_targets() {
        let mut meta = ParsedPdfMetadata {
            url: Some("https://example.com/missing".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let stripped =
            strip_invalid_metadata_url_with(&mut meta, |_| Ok(false)).expect("validation should succeed");

        assert!(stripped);
        assert_eq!(meta.url, None);
    }

    #[test]
    fn strip_invalid_metadata_url_falls_back_to_get_after_head_405() {
        let mut meta = ParsedPdfMetadata {
            url: Some("https://example.com/fallback".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let stripped =
            strip_invalid_metadata_url_with(&mut meta, |_| Ok(false)).expect("validation should succeed");

        assert!(stripped);
        assert_eq!(meta.url, None);
    }

    #[test]
    fn strip_invalid_metadata_url_keeps_healthy_targets() {
        let url = "https://example.com/paper".to_string();
        let mut meta = ParsedPdfMetadata {
            url: Some(url.clone()),
            ..ParsedPdfMetadata::default()
        };

        let stripped =
            strip_invalid_metadata_url_with(&mut meta, |_| Ok(true)).expect("validation should succeed");

        assert!(!stripped);
        assert_eq!(meta.url.as_deref(), Some(url.as_str()));
    }

    #[test]
    fn build_title_query_variants_adds_shorter_search_forms() {
        let variants = build_title_query_variants(
            "Attention Is All You Need: Revisiting Sequence Transduction (Preprint)",
        );

        assert_eq!(
            variants.first().map(String::as_str),
            Some("Attention Is All You Need: Revisiting Sequence Transduction (Preprint)")
        );
        assert!(variants.iter().any(
            |variant| variant == "Attention Is All You Need: Revisiting Sequence Transduction"
        ));
        assert!(variants
            .iter()
            .any(|variant| variant == "Attention Is All You Need"));
    }

    #[test]
    fn metadata_request_cache_key_for_title_search_includes_match_context() {
        let first = metadata_request_cache_key(
            MetadataProvider::CrossrefTitle,
            "Attention Is All You Need | Ashish Vaswani | 2017",
        );
        let second = metadata_request_cache_key(
            MetadataProvider::CrossrefTitle,
            "Attention Is All You Need | Different Author | 2024",
        );

        assert_ne!(first, second);
    }

    #[test]
    fn metadata_candidate_match_score_uses_authors_and_year() {
        let strong = ParsedPdfMetadata {
            title: Some("Attention Is All You Need".to_string()),
            authors: Some("Ashish Vaswani, Noam Shazeer".to_string()),
            year: Some("2017".to_string()),
            ..ParsedPdfMetadata::default()
        };
        let weak = ParsedPdfMetadata {
            title: Some("Attention Is All You Need".to_string()),
            authors: Some("Completely Different".to_string()),
            year: Some("2025".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let strong_score = metadata_candidate_match_score(
            "Attention Is All You Need",
            Some("Ashish Vaswani, Noam Shazeer"),
            Some("2017"),
            &strong,
        );
        let weak_score = metadata_candidate_match_score(
            "Attention Is All You Need",
            Some("Ashish Vaswani, Noam Shazeer"),
            Some("2017"),
            &weak,
        );

        assert!(strong_score > weak_score);
        assert!(author_match_score("Ashish Vaswani", "Ashish Vaswani, Noam Shazeer") > 0.4);
    }

    #[test]
    fn merge_provider_metadata_preserves_non_preprint_publication() {
        let mut resolved = ParsedPdfMetadata {
            title: Some("Attention Is All You Need".to_string()),
            authors: Some("Ashish Vaswani".to_string()),
            year: Some("2018".to_string()),
            publication: Some("NeurIPS".to_string()),
            ..ParsedPdfMetadata::default()
        };
        let incoming = ParsedPdfMetadata {
            title: Some("Attention Is All You Need".to_string()),
            authors: Some("Ashish Vaswani".to_string()),
            year: Some("2017".to_string()),
            publication: Some("arXiv".to_string()),
            arxiv_id: Some("1706.03762".to_string()),
            ..ParsedPdfMetadata::default()
        };

        merge_provider_metadata(
            &mut resolved,
            &mut MetadataMergePriority::new(),
            incoming,
            MetadataProvider::ArxivTitle,
        );

        assert_eq!(resolved.publication.as_deref(), Some("NeurIPS"));
        assert_eq!(resolved.year.as_deref(), Some("2018"));
        assert_eq!(resolved.arxiv_id.as_deref(), Some("1706.03762"));
    }

    #[test]
    fn merge_item_with_parsed_metadata_preserves_existing_url_against_conflicting_doi_url() {
        let mut item = sample_item();
        item.url = "https://example.com/paper".to_string();
        item.doi = "10.1000/correct".to_string();
        let parsed = ParsedPdfMetadata {
            url: Some("https://doi.org/10.65215/2q58a426".to_string()),
            doi: Some("10.65215/2q58a426".to_string()),
            ..ParsedPdfMetadata::default()
        };

        let merged = merge_item_with_parsed_metadata(&item, &parsed);

        assert_eq!(merged.url, "https://example.com/paper");
    }

    #[test]
    fn metadata_completed_treats_preprint_as_incomplete() {
        let complete = ParsedPdfMetadata {
            title: Some("Paper".to_string()),
            authors: Some("Author".to_string()),
            year: Some("2024".to_string()),
            publication: Some("Nature".to_string()),
            ..ParsedPdfMetadata::default()
        };
        let preprint = ParsedPdfMetadata {
            publication: Some("arXiv".to_string()),
            ..complete.clone()
        };

        assert!(is_metadata_completed(&complete));
        assert!(is_preprint_metadata(&preprint));
        assert!(!is_metadata_completed(&preprint));
    }

    #[test]
    fn openalex_work_to_metadata_exposes_source_publisher_before_sanitization() {
        let work = OpenAlexWork {
            display_name: "Published Paper".to_string(),
            doi: Some("https://doi.org/10.1000/example".to_string()),
            publication_year: Some(2024),
            r#type: "article".to_string(),
            language: None,
            primary_location: Some(OpenAlexPrimaryLocation {
                landing_page_url: Some("https://example.com".to_string()),
                pdf_url: None,
                source: Some(OpenAlexSource {
                    display_name: Some("Journal of Examples".to_string()),
                    host_organization_name: Some("Elsevier".to_string()),
                }),
                raw_source_name: None,
            }),
            authorships: vec![],
            biblio: None,
            abstract_inverted_index: None,
        };

        let parsed = openalex_work_to_metadata(work);

        assert_eq!(parsed.publisher.as_deref(), Some("Elsevier"));
    }
}
