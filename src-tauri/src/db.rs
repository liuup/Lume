/// Module: src-tauri/src/db.rs
/// Purpose: Encapsulates database initialization and shared operations.
/// Capabilities: Creates missing tables upon application startup. Returns a SQLite connection.
use std::path::Path;

use rusqlite::{Connection, Result as SqlResult};

use crate::library_commands::library_root_dir;

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> SqlResult<()> {
    let pragma = format!("PRAGMA table_info({})", table);
    let mut stmt = conn.prepare(&pragma)?;
    let exists = stmt.query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == column);

    if !exists {
        let alter = format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, definition);
        conn.execute(&alter, [])?;
    }

    Ok(())
}

pub fn ensure_schema(conn: &Connection) -> SqlResult<()> {
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
            folder_path TEXT,
            is_trashed INTEGER NOT NULL DEFAULT 0,
            original_path TEXT,
            original_folder_path TEXT,
            trashed_at TEXT
        )",
        [],
    )?;

    ensure_column(conn, "items", "is_trashed", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "items", "original_path", "TEXT")?;
    ensure_column(conn, "items", "original_folder_path", "TEXT")?;
    ensure_column(conn, "items", "trashed_at", "TEXT")?;

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

    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_paper_summary_cache (
            item_id TEXT NOT NULL,
            language TEXT NOT NULL,
            model TEXT NOT NULL,
            prompt_key TEXT NOT NULL,
            file_size INTEGER NOT NULL DEFAULT 0,
            modified_unix_ms INTEGER NOT NULL DEFAULT 0,
            summary_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (item_id, language, model, prompt_key)
        )",
        [],
    )?;

    Ok(())
}

pub fn init_db_at_path(db_path: &Path) -> SqlResult<Connection> {
    let conn = Connection::open(db_path)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

pub fn init_db(app: &tauri::AppHandle) -> SqlResult<Connection> {
    let db_path = library_root_dir(app)
        .map_err(|e| rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(1), Some(e)))?
        .join("lume_library.db");

    init_db_at_path(&db_path)
}
