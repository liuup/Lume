/// Module: src-tauri/src/models.rs
/// Purpose: Defines core data structures and serialization payload definitions
/// Capabilities: Contains representation of items, folders, attachments, internal caches and API shapes.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::pdf_handlers::ThreadSafeDoc;
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub documents: Arc<Mutex<HashMap<String, Arc<Mutex<ThreadSafeDoc>>>>>,
    pub db: Arc<Mutex<Connection>>,
}

#[derive(Serialize)]
pub struct Note {
    pub id: String,
    pub item_id: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct Setting {
    pub key: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDigestEntry {
    pub page: u16,
    pub text: String,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDigestSection {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub entries: Vec<AiDigestEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnnotationDigestStats {
    pub text_annotations: usize,
    pub highlight_strokes: usize,
    pub ink_strokes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnnotationDigest {
    pub overview: String,
    pub coverage_note: String,
    pub limitations: String,
    pub stats: AiAnnotationDigestStats,
    pub sections: Vec<AiDigestSection>,
    pub markdown: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPaperSummary {
    pub title: String,
    pub summary: String,
    pub key_points: Vec<String>,
    pub limitations: Vec<String>,
    pub language: String,
    pub source_excerpt: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTranslationResult {
    pub translation: String,
    pub source_language_hint: String,
    pub target_language: String,
    pub original_text: String,
}

#[derive(Serialize)]
pub struct LibraryPdfMeta {
    pub title: String,
    pub authors: String,
    pub year: String,
    pub r#abstract: String,
    pub doi: String,
    #[serde(rename = "arxivId")]
    pub arxiv_id: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct LibraryAttachment {
    pub id: String,
    pub item_id: String,
    pub name: String,
    pub path: String,
    pub attachment_type: String,
}

#[derive(Deserialize)]
pub struct UpdateMetadataPayload {
    pub id: String,
    pub title: String,
    pub authors: String,
    pub year: String,
    pub r#abstract: String,
    pub doi: String,
    #[serde(rename = "arxivId")]
    pub arxiv_id: String,
    pub publication: String,
    pub volume: String,
    pub issue: String,
    pub pages: String,
    pub publisher: String,
    pub isbn: String,
    pub url: String,
    pub language: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct LibraryItem {
    pub id: String,
    pub item_type: String,
    pub title: String,
    pub authors: String,
    pub year: String,
    pub r#abstract: String,
    pub doi: String,
    pub arxiv_id: String,
    pub publication: String,
    pub volume: String,
    pub issue: String,
    pub pages: String,
    pub publisher: String,
    pub isbn: String,
    pub url: String,
    pub language: String,
    pub date_added: String,
    pub date_modified: String,
    pub folder_path: String,
    pub tags: Vec<String>,
    pub attachments: Vec<LibraryAttachment>,
}

#[derive(Serialize)]
pub struct LibraryFolderNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub children: Vec<LibraryFolderNode>,
    pub items: Vec<LibraryItem>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct ParsedPdfMetadata {
    pub title: Option<String>,
    pub authors: Option<String>,
    pub year: Option<String>,
    pub r#abstract: Option<String>,
    pub doi: Option<String>,
    #[serde(rename = "arxivId")]
    pub arxiv_id: Option<String>,
    pub publication: Option<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
    pub url: Option<String>,
    pub language: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataFetchStep {
    pub stage: String,
    pub provider: String,
    pub query: String,
    pub status: String,
    pub score: Option<f32>,
    #[serde(default)]
    pub fields_changed: Vec<String>,
    pub note: Option<String>,
    pub metadata_completed: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataFetchReport {
    #[serde(default)]
    pub summary: String,
    pub network_complete: bool,
    pub metadata_completed: bool,
    pub is_preprint: bool,
    #[serde(default)]
    pub title_queries: Vec<String>,
    #[serde(default)]
    pub steps: Vec<MetadataFetchStep>,
}

#[derive(Serialize, Deserialize)]
pub struct CachedPdfMetadataRecord {
    pub file_size: u64,
    pub modified_unix_ms: u64,
    pub network_complete: bool,
    pub meta: ParsedPdfMetadata,
    #[serde(default)]
    pub report: Option<MetadataFetchReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieveMetadataResult {
    pub item: LibraryItem,
    pub report: MetadataFetchReport,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPdfAnnotationsDocument {
    #[serde(default = "default_annotation_version")]
    pub version: u8,
    #[serde(default)]
    pub pages: HashMap<String, SavedPdfPageAnnotations>,
}

pub fn default_annotation_version() -> u8 {
    1
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPdfPageAnnotations {
    #[serde(default)]
    pub paths: Vec<SavedAnnotationPath>,
    #[serde(default)]
    pub text_annotations: Vec<SavedTextAnnotation>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAnnotationPath {
    pub tool: String,
    pub points: Vec<SavedAnnotationPoint>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAnnotationPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTextAnnotation {
    pub x: f32,
    pub y: f32,
    pub text: String,
    pub font_size: f32,
}

#[derive(Deserialize, Clone)]
pub struct CrossrefWorkResponse {
    pub message: CrossrefWorkMessage,
}

#[derive(Deserialize)]
pub struct CrossrefSearchResponse {
    pub message: CrossrefSearchMessage,
}

#[derive(Deserialize)]
pub struct CrossrefSearchMessage {
    #[serde(default)]
    pub items: Vec<CrossrefWorkMessage>,
}

#[derive(Deserialize, Clone)]
pub struct CrossrefWorkMessage {
    #[serde(default)]
    pub title: Vec<String>,
    #[serde(default, rename = "container-title")]
    pub container_title: Vec<String>,
    #[serde(default)]
    pub author: Vec<CrossrefAuthor>,
    #[serde(default, rename = "published-print")]
    pub published_print: Option<CrossrefDateParts>,
    #[serde(default, rename = "published-online")]
    pub published_online: Option<CrossrefDateParts>,
    #[serde(default)]
    pub created: Option<CrossrefDateParts>,
    #[serde(default)]
    pub issued: Option<CrossrefDateParts>,
    #[serde(default)]
    #[serde(rename = "abstract")]
    pub abstract_field: Option<String>,
    #[serde(default, rename = "DOI")]
    pub doi: String,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default, rename = "URL")]
    pub url: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct CrossrefAuthor {
    #[serde(default)]
    pub given: Option<String>,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct CrossrefDateParts {
    #[serde(rename = "date-parts")]
    pub date_parts: Vec<Vec<u16>>,
}
