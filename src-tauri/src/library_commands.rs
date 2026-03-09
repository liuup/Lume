/// Module: src-tauri/src/library_commands.rs
/// Purpose: Encapsulates all general file/directory manipulation commands.
/// Capabilities: Moving, renaming, deleting, parsing library structure, managing annotations cache sidecars. 

use crate::models::{CachedPdfMetadataRecord, LibraryItem, ParsedPdfMetadata, SavedPdfAnnotationsDocument, SavedPdfPageAnnotations};
use crate::pdf_handlers::extract_pdf_metadata;
use crate::metadata_fetch::{fetch_arxiv_metadata_by_id, fetch_arxiv_metadata_by_title, fetch_crossref_metadata_by_doi, fetch_crossref_metadata_by_title, merge_arxiv_metadata, merge_crossref_metadata};

use tauri::Manager;
use std::fs;
use std::path::{Path, PathBuf};

pub fn library_root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {:?}", e))?
        .join("library");

    fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create library root: {}", e))?;

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

pub fn write_annotation_sidecar(path: &Path, document: &SavedPdfAnnotationsDocument) -> Result<(), String> {
    let sidecar_path = annotation_sidecar_path(path);
    let content = serde_json::to_string_pretty(document)
        .map_err(|e| format!("Failed to serialize annotations: {}", e))?;
    fs::write(sidecar_path, content)
        .map_err(|e| format!("Failed to write annotations: {}", e))
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
    meta.doi.is_some()
        || meta.arxiv_id.is_some()
        || meta.title.is_some()
}

pub fn resolve_pdf_metadata(path: &Path) -> ParsedPdfMetadata {
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

pub fn build_library_item(path: &Path) -> LibraryItem {
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

    let attachment = crate::models::LibraryAttachment {
        id: format!("att-{}", path_str),
        item_id: path_str.clone(),
        name: name.clone(),
        path: path_str.clone(),
        attachment_type: "PDF".to_string(),
    };

    LibraryItem {
        id: path_str.clone(),
        item_type: "Journal Article".to_string(),
        title,
        authors,
        year,
        r#abstract: abstract_text,
        doi,
        arxiv_id,
        publication: String::new(),
        volume: String::new(),
        issue: String::new(),
        pages: String::new(),
        publisher: String::new(),
        isbn: String::new(),
        url: String::new(),
        language: String::new(),
        date_added: String::new(),
        date_modified: String::new(),
        folder_path: String::new(),
        tags: Vec::new(),
        attachments: vec![attachment],
    }
}

pub fn fetch_item_from_db(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<Option<LibraryItem>> {
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
        let mut att_stmt = conn.prepare("SELECT id, item_id, name, path, attachment_type FROM attachments WHERE item_id = ?1")?;
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

pub fn sync_item_to_db(conn: &rusqlite::Connection, item: &LibraryItem) -> rusqlite::Result<()> {
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
            item.date_added,
            item.date_modified,
            item.folder_path,
        ],
    )?;

    for att in &item.attachments {
        conn.execute(
            "INSERT OR IGNORE INTO attachments (id, item_id, name, path, attachment_type)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                att.id,
                att.item_id,
                att.name,
                att.path,
                att.attachment_type,
            ],
        )?;
    }
    
    Ok(())
}

pub fn build_library_tree(path: &Path, is_root: bool, conn: &rusqlite::Connection) -> Result<crate::models::LibraryFolderNode, String> {
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
        .map(|child| build_library_tree(&child, false, conn))
        .collect::<Result<Vec<_>, _>>()?;

    let items = pdf_paths
        .into_iter()
        .map(|pdf| {
            let id = pdf.to_string_lossy().to_string();
            match fetch_item_from_db(conn, &id).unwrap_or(None) {
                Some(item) => item,
                None => {
                    let new_item = build_library_item(&pdf);
                    let _ = sync_item_to_db(conn, &new_item);
                    new_item
                }
            }
        })
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

    Ok(crate::models::LibraryFolderNode {
        id: path_str.clone(),
        name,
        path: path_str,
        children,
        items,
    })
}

#[tauri::command]
pub fn load_library_tree(app: tauri::AppHandle, state: tauri::State<crate::models::AppState>) -> Result<Vec<crate::models::LibraryFolderNode>, String> {
    let root = library_root_dir(&app)?;
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    Ok(vec![build_library_tree(&root, true, &conn)?])
}

#[tauri::command]
pub fn load_pdf_annotations(path: String, page_index: u16) -> Result<SavedPdfPageAnnotations, String> {
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
    fs::create_dir_all(&parent)
        .map_err(|e| format!("Failed to access parent folder: {}", e))?;

    let target = unique_directory_path(&parent, trimmed_name);
    fs::create_dir_all(&target)
        .map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_pdf_to_folder(source_path: String, folder_path: String, state: tauri::State<'_, crate::models::AppState>) -> Result<String, String> {
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

    if let Ok(conn) = state.db.lock() {
        let new_item = build_library_item(&final_path);
        let _ = sync_item_to_db(&conn, &new_item);
    }

    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_library_pdf(path: String, state: tauri::State<'_, crate::models::AppState>) -> Result<(), String> {
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

        if let Ok(conn) = state.db.lock() {
        let _ = conn.execute("DELETE FROM items WHERE id = ?1", rusqlite::params![&path]);
    }

    Ok(())
}

#[tauri::command]
pub fn rename_library_pdf(path: String, new_name: String, state: tauri::State<'_, crate::models::AppState>) -> Result<String, String> {
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

    let target_path_str = target.to_string_lossy().to_string();
    
    if let Ok(conn) = state.db.lock() {
        if let Ok(Some(mut item)) = fetch_item_from_db(&conn, &path) {
            item.id = target_path_str.clone();
            if let Some(att) = item.attachments.first_mut() {
                att.id = format!("att-{}", target_path_str);
                att.item_id = target_path_str.clone();
                att.path = target_path_str.clone();
            }
            let _ = conn.execute("DELETE FROM items WHERE id = ?1", rusqlite::params![&path]);
            let _ = sync_item_to_db(&conn, &item);
        }
    }

    Ok(target_path_str)
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

    fs::rename(&source, &target)
        .map_err(|e| format!("Failed to rename folder: {}", e))?;

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

// ─────────────────────────────────────────────────────────────
// Global Library Search
// ─────────────────────────────────────────────────────────────

pub fn fetch_item_tags(conn: &rusqlite::Connection, item_id: &str) -> Vec<String> {
    let mut stmt = match conn.prepare(
        "SELECT tag FROM item_tags WHERE item_id = ?1 ORDER BY tag",
    ) {
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

#[tauri::command]
pub fn search_library(
    params: SearchLibraryParams,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<crate::models::LibraryItem>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;

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
                // "all" – search title, authors, DOI, arXiv, publication, abstract, and tags
                conditions.push(
                    "(LOWER(i.title) LIKE ? \
                     OR LOWER(i.authors) LIKE ? \
                     OR LOWER(i.doi) LIKE ? \
                     OR LOWER(i.arxiv_id) LIKE ? \
                     OR LOWER(i.publication) LIKE ? \
                     OR LOWER(i.abstract) LIKE ? \
                     OR EXISTS (SELECT 1 FROM item_tags it \
                                WHERE it.item_id = i.id AND LOWER(it.tag) LIKE ?))"
                        .to_string(),
                );
                for _ in 0..7 {
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
        conditions.join(" AND ")
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Prepare error: {}", e))?;

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
