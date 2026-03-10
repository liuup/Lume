/// Module: src-tauri/src/library_commands.rs
/// Purpose: Encapsulates all general file/directory manipulation commands.
/// Capabilities: Moving, renaming, deleting, parsing library structure, managing annotations cache sidecars. 

use crate::models::{CachedPdfMetadataRecord, LibraryItem, ParsedPdfMetadata, SavedPdfAnnotationsDocument, SavedPdfPageAnnotations, Note};
use crate::pdf_handlers::extract_pdf_metadata;
use crate::metadata_fetch::{fetch_arxiv_metadata_by_id, fetch_arxiv_metadata_by_title, fetch_crossref_metadata_by_doi, fetch_crossref_metadata_by_title, merge_arxiv_metadata, merge_crossref_metadata};

use tauri::Manager;
use std::fs;
use std::path::{Path, PathBuf};
use rusqlite::OptionalExtension;

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
pub fn get_all_annotations(path: String) -> Result<SavedPdfAnnotationsDocument, String> {
    let pdf_path = PathBuf::from(&path);
    if !pdf_path.exists() {
        return Err("PDF does not exist".to_string());
    }

    Ok(read_annotation_sidecar(&pdf_path).unwrap_or_default())
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

    // First find the PDF attachment path for this item
    let pdf_path: Option<String> = conn
        .query_row(
            "SELECT path FROM attachments WHERE item_id = ?1 AND attachment_type = 'PDF' LIMIT 1",
            rusqlite::params![&item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Query PDF attachment failed: {}", e))?;

    let Some(path_str) = pdf_path else {
        return Ok(None);
    };

    let pdf_path = PathBuf::from(&path_str);
    let mut extracted_text = String::new();

    if let Some(document) = read_annotation_sidecar(&pdf_path) {
        // Collect pages sorted by their numeric page index
        let mut pages: Vec<(u16, &SavedPdfPageAnnotations)> = document.pages.iter()
            .filter_map(|(k, v)| k.parse::<u16>().ok().map(|idx| (idx, v)))
            .collect();
        pages.sort_by_key(|(idx, _)| *idx);

        for (page_idx, page_anns) in pages {
            let mut page_text = String::new();
            
            // Collect text annotations for the page, sorting top to bottom
            let mut text_anns = page_anns.text_annotations.clone();
            text_anns.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
            
            for ann in text_anns {
                let txt = ann.text.trim();
                if !txt.is_empty() {
                    page_text.push_str("> ");
                    page_text.push_str(&txt.replace("\n", "\n> "));
                    page_text.push_str("\n\n");
                }
            }

            if !page_text.is_empty() {
                extracted_text.push_str(&format!("### Annotations on Page {}\n\n", page_idx + 1));
                extracted_text.push_str(&page_text);
            }
        }
    }

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

// ─────────────────────────────────────────────────────────────
// Tag Management Commands
// ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct TagInfo {
    pub tag: String,
    pub count: i64,
    pub color: String,
}

/// Return every tag in the library, with usage count and assigned color.
#[tauri::command]
pub fn get_all_tags(
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<Vec<TagInfo>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let mut stmt = conn.prepare(
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
                tag:   row.get(0)?,
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

/// Internal citation data row (lighter than the full LibraryItem)
struct CitationData {
    id: String,
    item_type: String,
    title: String,
    authors: String,
    year: String,
    publication: String,
    volume: String,
    issue: String,
    pages: String,
    publisher: String,
    doi: String,
    arxiv_id: String,
    url: String,
    isbn: String,
}

fn fetch_citation_data(conn: &rusqlite::Connection, item_id: &str) -> Result<CitationData, String> {
    conn.query_row(
        "SELECT id, item_type, title, authors, year, publication, volume, issue, pages,
                publisher, doi, arxiv_id, url, isbn
         FROM items WHERE id = ?1",
        rusqlite::params![item_id],
        |r| {
            Ok(CitationData {
                id:          r.get::<_, String>(0).unwrap_or_default(),
                item_type:   r.get::<_, String>(1).unwrap_or_default(),
                title:       r.get::<_, String>(2).unwrap_or_default(),
                authors:     r.get::<_, String>(3).unwrap_or_default(),
                year:        r.get::<_, String>(4).unwrap_or_default(),
                publication: r.get::<_, String>(5).unwrap_or_default(),
                volume:      r.get::<_, String>(6).unwrap_or_default(),
                issue:       r.get::<_, String>(7).unwrap_or_default(),
                pages:       r.get::<_, String>(8).unwrap_or_default(),
                publisher:   r.get::<_, String>(9).unwrap_or_default(),
                doi:         r.get::<_, String>(10).unwrap_or_default(),
                arxiv_id:    r.get::<_, String>(11).unwrap_or_default(),
                url:         r.get::<_, String>(12).unwrap_or_default(),
                isbn:        r.get::<_, String>(13).unwrap_or_default(),
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
    raw.split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect()
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
                .map(|p| format!("{}.", p.chars().next().unwrap_or(' ').to_uppercase().next().unwrap_or(' ')))
                .collect::<Vec<_>>()
                .join(" ");
            (last, initials)
        }
    }
}

/// Format a DOI as a URL suffix segment.
fn doi_url(doi: &str) -> String {
    if doi.is_empty() { return String::new(); }
    format!("https://doi.org/{}", doi)
}

// ── Format-specific generators ───────────────────────────────────────────────

fn format_apa(item: &CitationData) -> String {
    // APA 7th: Authors (Year). Title. Journal, Volume(Issue), Pages. https://doi.org/…
    let authors_list = split_authors(&item.authors);
    let apa_authors = if authors_list.is_empty() {
        String::from("Unknown Author")
    } else {
        let formatted: Vec<String> = authors_list.iter().map(|a| {
            let (last, initials) = name_to_last_initials(a);
            if initials.is_empty() { last } else { format!("{}, {}", last, initials) }
        }).collect();
        let n = formatted.len();
        if n == 1 {
            formatted[0].clone()
        } else {
            format!("{}, & {}", formatted[..n-1].join(", "), formatted[n-1])
        }
    };

    let year = if item.year.is_empty() { "n.d.".to_string() } else { format!("({})", item.year) };

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
            if initials.is_empty() { last } else {
                let first = authors_list[0].split_whitespace()
                    .take(authors_list[0].split_whitespace().count().saturating_sub(1))
                    .collect::<Vec<_>>().join(" ");
                format!("{}, {}", last, first)
            }
        }
        2 => {
            let (l0, _) = name_to_last_initials(&authors_list[0]);
            let first0 = authors_list[0].split_whitespace()
                .take(authors_list[0].split_whitespace().count().saturating_sub(1))
                .collect::<Vec<_>>().join(" ");
            format!("{}, {}, and {}", l0, first0, authors_list[1])
        }
        _ => {
            let (l0, _) = name_to_last_initials(&authors_list[0]);
            let first0 = authors_list[0].split_whitespace()
                .take(authors_list[0].split_whitespace().count().saturating_sub(1))
                .collect::<Vec<_>>().join(" ");
            format!("{}, {}, et al.", l0, first0)
        }
    };

    let mut out = format!("{}. \"{}.", mla_authors, item.title);
    if !item.publication.is_empty() {
        out.push_str(&format!("\" *{}*", item.publication));
        if !item.volume.is_empty() { out.push_str(&format!(", vol. {}", item.volume)); }
        if !item.issue.is_empty()  { out.push_str(&format!(", no. {}", item.issue)); }
        if !item.year.is_empty()   { out.push_str(&format!(", {}", item.year)); }
        if !item.pages.is_empty()  { out.push_str(&format!(", pp. {}", item.pages)); }
        if !item.doi.is_empty()    { out.push_str(&format!(", doi:{}", item.doi)); }
        out.push('.');
    } else {
        if !item.publisher.is_empty() { out.push_str(&format!("\" {}", item.publisher)); }
        if !item.year.is_empty() { out.push_str(&format!(", {}", item.year)); }
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
        if !item.volume.is_empty() { out.push_str(&format!(" {}", item.volume)); }
        if !item.issue.is_empty()  { out.push_str(&format!(", no. {}", item.issue)); }
        if !item.year.is_empty()   { out.push_str(&format!(" ({})", item.year)); }
        if !item.pages.is_empty()  { out.push_str(&format!(": {}", item.pages)); }
        out.push('.');
    } else {
        if !item.publisher.is_empty() { out.push_str(&format!("\" {}", item.publisher)); }
        if !item.year.is_empty() { out.push_str(&format!(", {}", item.year)); }
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
        if !item.year.is_empty() { out.push_str(&format!(", {}", item.year)); }
        if !item.volume.is_empty() {
            out.push_str(&format!(", {}", item.volume));
            if !item.issue.is_empty() { out.push_str(&format!("({})", item.issue)); }
        }
        if !item.pages.is_empty() { out.push_str(&format!(": {}", item.pages)); }
        out.push('.');
    } else if !item.publisher.is_empty() {
        out.push_str(&format!(". {}", item.publisher));
        if !item.year.is_empty() { out.push_str(&format!(", {}", item.year)); }
        out.push('.');
    }

    if !item.doi.is_empty() {
        out.push_str(&format!(" DOI: {}", item.doi));
    }
    out
}

fn format_bibtex(item: &CitationData) -> String {
    // Generate a cite key from first-author-last + year
    let first_author = split_authors(&item.authors).into_iter().next().unwrap_or_default();
    let (last, _) = name_to_last_initials(&first_author);
    let key_last = last.to_lowercase().replace(' ', "").chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let key_year = if item.year.is_empty() { "nd".to_string() } else { item.year.clone() };
    let cite_key = if key_last.is_empty() { format!("item{}", key_year) } else { format!("{}{}", key_last, key_year) };

    let entry_type = match item.item_type.as_str() {
        "book" => "book",
        "thesis" => "phdthesis",
        "conference" => "inproceedings",
        _ => "article",
    };

    let journal_field = if entry_type == "article" { "journal" } else { "booktitle" };

    // BibTeX author: join with " and "
    let bibtex_authors = split_authors(&item.authors).join(" and ");

    let mut fields: Vec<String> = Vec::new();
    if !item.title.is_empty()       { fields.push(format!("  title     = {{{}}}", item.title)); }
    if !bibtex_authors.is_empty()   { fields.push(format!("  author    = {{{}}}", bibtex_authors)); }
    if !item.publication.is_empty() { fields.push(format!("  {}   = {{{}}}", journal_field, item.publication)); }
    if !item.year.is_empty()        { fields.push(format!("  year      = {{{}}}", item.year)); }
    if !item.volume.is_empty()      { fields.push(format!("  volume    = {{{}}}", item.volume)); }
    if !item.issue.is_empty()       { fields.push(format!("  number    = {{{}}}", item.issue)); }
    if !item.pages.is_empty()       { fields.push(format!("  pages     = {{{}}}", item.pages)); }
    if !item.publisher.is_empty()   { fields.push(format!("  publisher = {{{}}}", item.publisher)); }
    if !item.doi.is_empty()         { fields.push(format!("  doi       = {{{}}}", item.doi)); }
    if !item.arxiv_id.is_empty()    { fields.push(format!("  eprint    = {{{}}}", item.arxiv_id)); }
    if !item.isbn.is_empty()        { fields.push(format!("  isbn      = {{{}}}", item.isbn)); }
    if !item.url.is_empty()         { fields.push(format!("  url       = {{{}}}", item.url)); }

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
    if !item.title.is_empty()       { lines.push(format!("TI  - {}", item.title)); }
    for author in split_authors(&item.authors) {
        lines.push(format!("AU  - {}", author));
    }
    if !item.year.is_empty()        { lines.push(format!("PY  - {}", item.year)); }
    if !item.publication.is_empty() { lines.push(format!("JO  - {}", item.publication)); }
    if !item.volume.is_empty()      { lines.push(format!("VL  - {}", item.volume)); }
    if !item.issue.is_empty()       { lines.push(format!("IS  - {}", item.issue)); }
    if !item.pages.is_empty() {
        let ps: Vec<&str> = item.pages.splitn(2, '-').collect();
        lines.push(format!("SP  - {}", ps[0].trim()));
        if ps.len() > 1 { lines.push(format!("EP  - {}", ps[1].trim())); }
    }
    if !item.publisher.is_empty()   { lines.push(format!("PB  - {}", item.publisher)); }
    if !item.doi.is_empty()         { lines.push(format!("DO  - {}", item.doi)); }
    if !item.isbn.is_empty()        { lines.push(format!("SN  - {}", item.isbn)); }
    if !item.url.is_empty()         { lines.push(format!("UR  - {}", item.url)); }
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
                first_parts[..first_parts.len()-1].join(" ")
            } else {
                String::new()
            };
            format!("{{\"family\":\"{}\",\"given\":\"{}\"}}", escape(&last), escape(&given))
        })
        .collect::<Vec<_>>()
        .join(",");

    let mut fields: Vec<String> = Vec::new();
    fields.push(format!("\"id\":\"{}\"", escape(&item.id)));
    fields.push(format!("\"type\":\"{}\"", csl_type));
    if !item.title.is_empty()       { fields.push(format!("\"title\":\"{}\"", escape(&item.title))); }
    if !author_json.is_empty()      { fields.push(format!("\"author\":[{}]", author_json)); }
    if !item.year.is_empty()        { fields.push(format!("\"issued\":{{\"date-parts\":[[{}]]}}", item.year)); }
    if !item.publication.is_empty() { fields.push(format!("\"container-title\":\"{}\"", escape(&item.publication))); }
    if !item.volume.is_empty()      { fields.push(format!("\"volume\":\"{}\"", escape(&item.volume))); }
    if !item.issue.is_empty()       { fields.push(format!("\"issue\":\"{}\"", escape(&item.issue))); }
    if !item.pages.is_empty()       { fields.push(format!("\"page\":\"{}\"", escape(&item.pages))); }
    if !item.publisher.is_empty()   { fields.push(format!("\"publisher\":\"{}\"", escape(&item.publisher))); }
    if !item.doi.is_empty()         { fields.push(format!("\"DOI\":\"{}\"", escape(&item.doi))); }
    if !item.isbn.is_empty()        { fields.push(format!("\"ISBN\":\"{}\"", escape(&item.isbn))); }
    if !item.url.is_empty()         { fields.push(format!("\"URL\":\"{}\"", escape(&item.url))); }
    format!("{{{}}}", fields.join(","))
}

fn apply_format(item: &CitationData, format: &str) -> String {
    match format {
        "apa"      => format_apa(item),
        "mla"      => format_mla(item),
        "chicago"  => format_chicago(item),
        "gbt"      => format_gbt(item),
        "bibtex"   => format_bibtex(item),
        "ris"      => format_ris(item),
        "csljson"  => format!("[{}]", format_csljson_one(item)),
        _          => format_apa(item),
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
#[tauri::command]
pub fn export_items(
    item_ids: Vec<String>,
    format: String,
    state: tauri::State<'_, crate::models::AppState>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let mut parts: Vec<String> = Vec::new();
    for id in &item_ids {
        match fetch_citation_data(&conn, id) {
            Ok(item) => parts.push(apply_format(&item, &format)),
            Err(_) => {} // skip missing items silently
        }
    }
    let sep = match format.as_str() {
        "bibtex" | "ris" => "\n\n",
        _ => "\n",
    };
    if format == "csljson" {
        // Unwrap individual JSON objects and wrap in one array
        let objects: Vec<String> = parts.iter()
            .map(|p| p.trim_start_matches('[').trim_end_matches(']').to_string())
            .collect();
        Ok(format!("[{}]", objects.join(",")))
    } else {
        Ok(parts.join(sep))
    }
}
