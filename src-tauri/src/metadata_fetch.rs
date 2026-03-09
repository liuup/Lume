/// Module: src-tauri/src/metadata_fetch.rs
/// Purpose: Encapsulates all fetching logic for Crossref and arXiv metadata APIs.
/// Capabilities: Defines internal regex engines to extract DOIs and arXiv IDs and exposes methods to query external literature APIs.

use reqwest::blocking::Client;
use regex::Regex;
use std::sync::OnceLock;
use std::collections::HashSet;
use std::time::Duration;

use crate::models::{
    CrossrefAuthor, CrossrefSearchResponse, CrossrefWorkMessage, CrossrefWorkResponse, ParsedPdfMetadata
};

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
static DOI_REGEX: OnceLock<Regex> = OnceLock::new();
static ARXIV_REGEX: OnceLock<Regex> = OnceLock::new();
static ARXIV_LEGACY_REGEX: OnceLock<Regex> = OnceLock::new();
static XML_ENTRY_REGEX: OnceLock<Regex> = OnceLock::new();

pub fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent("Lume/0.1 (metadata enrichment)")
            .build()
            .expect("failed to build metadata HTTP client")
    })
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
        None
    } else {
        Some(trimmed.to_lowercase())
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
    let is_missing = target.as_deref().map(|value| value.trim().is_empty()).unwrap_or(true);
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
}

pub fn merge_crossref_metadata(target: &mut ParsedPdfMetadata, incoming: ParsedPdfMetadata) {
    overwrite_if_present(&mut target.title, incoming.title);
    overwrite_if_present(&mut target.authors, incoming.authors);
    overwrite_if_present(&mut target.year, incoming.year);
    overwrite_if_present(&mut target.doi, incoming.doi);
    fill_if_missing(&mut target.r#abstract, incoming.r#abstract);
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

pub fn extract_xml_tag_values(block: &str, tag_name: &str) -> Vec<String> {
    let pattern = format!(r"(?is)<(?:[a-z0-9_\-]+:)?{}\b[^>]*>(.*?)</(?:[a-z0-9_\-]+:)?{}>", regex::escape(tag_name), regex::escape(tag_name));
    let regex = Regex::new(&pattern).expect("invalid XML tag regex");
    regex
        .captures_iter(block)
        .filter_map(|captures| captures.get(1).map(|matched| clean_abstract_text(matched.as_str())))
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

pub fn parse_arxiv_feed_entries(xml: &str) -> Vec<ParsedPdfMetadata> {
    xml_entry_regex()
        .captures_iter(xml)
        .filter_map(|captures| captures.get(1).map(|matched| parse_arxiv_entry(matched.as_str())))
        .collect()
}

pub fn crossref_authors(authors: &[CrossrefAuthor]) -> Option<String> {
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

    ParsedPdfMetadata {
        title,
        authors,
        year,
        r#abstract: abstract_text,
        doi,
        arxiv_id: None,
    }
}

pub fn fetch_crossref_metadata_by_doi(doi: &str) -> Result<Option<ParsedPdfMetadata>, String> {
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

pub fn fetch_crossref_metadata_by_title(title: &str) -> Result<Option<ParsedPdfMetadata>, String> {
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

pub fn fetch_arxiv_metadata_by_id(arxiv_id: &str) -> Result<Option<ParsedPdfMetadata>, String> {
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

pub fn fetch_arxiv_metadata_by_title(title: &str) -> Result<Option<ParsedPdfMetadata>, String> {
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

#[tauri::command]
pub fn update_item_metadata(payload: crate::models::UpdateMetadataPayload, state: tauri::State<'_, crate::models::AppState>) -> Result<(), String> {
    let conn_mutex = state.db.clone();
    let conn = conn_mutex.lock().map_err(|e| format!("Database lock error: {}", e))?;
    let mut stmt = conn.prepare("UPDATE items SET title = ?1, authors = ?2, year = ?3, abstract = ?4, doi = ?5, arxiv_id = ?6, publication = ?7, volume = ?8, issue = ?9, pages = ?10, publisher = ?11, isbn = ?12, url = ?13, language = ?14, date_modified = datetime('now') WHERE id = ?15").map_err(|e| format!("Prepare error: {}", e))?;
    stmt.execute(rusqlite::params![payload.title, payload.authors, payload.year, payload.r#abstract, payload.doi, payload.arxiv_id, payload.publication, payload.volume, payload.issue, payload.pages, payload.publisher, payload.isbn, payload.url, payload.language, payload.id]).map_err(|e| format!("Execute error: {}", e))?;

    // Sync tags – replace all existing tags for this item
    conn.execute("DELETE FROM item_tags WHERE item_id = ?1", rusqlite::params![payload.id])
        .map_err(|e| format!("Failed to clear tags: {}", e))?;
    for tag in &payload.tags {
        let t = tag.trim();
        if !t.is_empty() {
            conn.execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?1, ?2)",
                rusqlite::params![payload.id, t],
            )
            .map_err(|e| format!("Failed to insert tag: {}", e))?;
        }
    }

    Ok(())
}