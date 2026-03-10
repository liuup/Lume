/// Module: src-tauri/src/db.rs
/// Purpose: Encapsulates database initialization and shared operations.
/// Capabilities: Creates missing tables upon application startup. Returns a SQLite connection.

use rusqlite::{Connection, Result as SqlResult};
use crate::library_commands::library_root_dir;

pub fn init_db(app: &tauri::AppHandle) -> SqlResult<Connection> {
    let db_path = library_root_dir(app)
        .map_err(|e| rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(1), Some(e)))?
        .join("lume_library.db");
    
    let conn = Connection::open(db_path)?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            item_type TEXT,
            title TEXT,
            authors TEXT,
            year TEXT,
            abstract TEXT,
            doi TEXT,
            arxiv_id TEXT,
            publication TEXT,
            volume TEXT,
            issue TEXT,
            pages TEXT,
            publisher TEXT,
            isbn TEXT,
            url TEXT,
            language TEXT,
            date_added TEXT,
            date_modified TEXT,
            folder_path TEXT
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            name TEXT,
            path TEXT,
            attachment_type TEXT,
            FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS item_tags (
            item_id TEXT NOT NULL,
            tag TEXT NOT NULL,
            PRIMARY KEY (item_id, tag),
            FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS tag_colors (
            tag  TEXT PRIMARY KEY COLLATE NOCASE,
            color TEXT NOT NULL DEFAULT '#6366f1'
        )",
        [],
    )?;

    Ok(conn)
}
