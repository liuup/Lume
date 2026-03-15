/// Module: src-tauri/src/cli.rs
/// Purpose: Native CLI interface for Lume using clap.
/// Capabilities: Provides subcommands for listing, searching, importing, exporting,
///               inspecting, syncing, opening, and getting status of the paper library.

use std::env;
use std::fs;
use std::io;
use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};
use clap_complete::{generate, Shell};

use crate::db::init_db_at_path;
use crate::library_commands::{
    build_library_tree, fetch_all_items_from_db, search_library_db, export_items_db,
    fetch_citation_data, apply_format, SearchLibraryParams,
};
use crate::models::LibraryItem;

const APP_IDENTIFIER: &str = "dev.liuup.lume";

// ─────────────────────────────────────────────────────────────
// CLI argument definitions (clap derive API)
// ─────────────────────────────────────────────────────────────

/// Field scope for search queries.
#[derive(Clone, ValueEnum)]
enum SearchField {
    All,
    Title,
    Authors,
    Year,
    Doi,
    Arxiv,
}

impl SearchField {
    fn as_str(&self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Title => "title",
            Self::Authors => "authors",
            Self::Year => "year",
            Self::Doi => "doi",
            Self::Arxiv => "arxiv",
        }
    }
}

/// Citation export format.
#[derive(Clone, ValueEnum)]
enum ExportFormat {
    Apa,
    Mla,
    Chicago,
    Gbt,
    Bibtex,
    Ris,
    Csljson,
}

impl ExportFormat {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Apa => "apa",
            Self::Mla => "mla",
            Self::Chicago => "chicago",
            Self::Gbt => "gbt",
            Self::Bibtex => "bibtex",
            Self::Ris => "ris",
            Self::Csljson => "csljson",
        }
    }
}

#[derive(Parser)]
#[command(
    name = "lume",
    version,
    about = "Lume — 现代学术文献管理工具 CLI",
    long_about = "\
Lume CLI 允许你在终端中管理学术文献库。

你可以使用子命令来浏览、搜索、导入 PDF、导出引用、查看详细信息等。
所有操作直接读写 Lume 的本地 SQLite 数据库，无需启动图形界面。

常用示例:
  lume list                          列出全部文献
  lume list --json                   以 JSON 格式输出全部文献
  lume search \"attention\"            搜索标题/作者/摘要中包含关键词的文献
  lume search \"2024\" --field year    按年份精确搜索
  lume import paper.pdf              导入一篇 PDF 到文献库
  lume export --format bibtex -o refs.bib   导出全部引用为 BibTeX 文件
  lume info \"transformer\"            查看匹配文献的详细元数据
  lume status                        查看文献库统计摘要
  lume completions zsh               生成 Zsh 自动补全脚本",
    after_help = "更多信息请访问: https://github.com/liuup/Lume"
)]
pub struct LumeCli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// 列出文献库中所有已保存的论文和文献
    ///
    /// 扫描文献库目录并与数据库同步后，输出完整的文献列表。
    /// 默认以人类可读的表格形式输出, 通过 --json 可获得机器可解析的 JSON 格式
    /// (适合与 jq、fzf 等命令行工具管道串联使用)。
    #[command(visible_alias = "ls")]
    List {
        /// 以 JSON 数组格式输出，方便管道处理
        #[arg(long, help = "以 JSON 格式输出 (便于管道处理: lume list --json | jq '.[]')")]
        json: bool,
    },

    /// 按关键词搜索文献
    ///
    /// 在标题、作者、DOI、arXiv ID、出版物、摘要、标签和笔记内容中进行全文搜索。
    /// 可通过 --field 限定搜索范围, 通过 --tag 按标签进一步过滤。
    /// 最多返回 200 条结果。
    #[command(visible_alias = "s")]
    Search {
        /// 搜索关键词 (在指定字段范围内模糊匹配)
        #[arg(help = "搜索关键词")]
        query: String,

        /// 限定搜索字段范围
        #[arg(
            long,
            value_enum,
            default_value = "all",
            help = "搜索范围: all=全部字段, title=标题, authors=作者, year=年份, doi, arxiv"
        )]
        field: SearchField,

        /// 按标签过滤 (可重复使用以叠加多个标签, 取交集)
        #[arg(long = "tag", help = "按标签过滤 (可重复: --tag ml --tag nlp)")]
        tags: Vec<String>,

        /// 以 JSON 格式输出搜索结果
        #[arg(long, help = "以 JSON 格式输出搜索结果")]
        json: bool,
    },

    /// 导入 PDF 文件到文献库
    ///
    /// 将一个或多个 PDF 文件复制到文献库中, 自动提取元数据并记录到数据库。
    /// 支持导入单个文件或整个目录下的所有 PDF。
    #[command(visible_alias = "add")]
    Import {
        /// PDF 文件或包含 PDF 的目录的路径
        #[arg(help = "要导入的 PDF 文件路径, 或包含 PDF 文件的目录路径")]
        path: String,

        /// 目标文件夹 (文献库内的相对路径, 默认为文献库根目录)
        #[arg(long, default_value = "", help = "目标文件夹 (文献库内的相对路径)")]
        folder: String,

        /// 导入时自动添加的标签 (可重复)
        #[arg(long = "tag", help = "导入时添加标签 (可重复: --tag ml --tag 2024)")]
        tags: Vec<String>,
    },

    /// 导出文献引用 (BibTeX / RIS / APA / MLA 等)
    ///
    /// 将文献库中的文献导出为标准引用格式。
    /// 如不指定 --id, 则导出全部文献; 可通过 --id 仅导出指定条目。
    /// 使用 -o 参数可直接写入文件。
    #[command(visible_alias = "cite")]
    Export {
        /// 引用输出格式
        #[arg(
            long,
            value_enum,
            default_value = "bibtex",
            help = "引用格式: bibtex, ris, apa, mla, chicago, gbt, csljson"
        )]
        format: ExportFormat,

        /// 仅导出指定 ID 的条目 (可重复; 省略则导出全部)
        #[arg(long = "id", help = "仅导出指定条目 (可重复: --id <path1> --id <path2>)")]
        ids: Vec<String>,

        /// 输出到文件 (默认输出到 stdout)
        #[arg(long, short, help = "写入文件 (例如: -o references.bib)")]
        output: Option<String>,
    },

    /// 查看单条文献的完整元数据
    ///
    /// 通过 Item ID (通常为 PDF 文件路径) 或标题关键词定位文献,
    /// 并显示其全部元数据字段 (标题、作者、摘要、DOI 等)、标签和附件列表。
    #[command(visible_alias = "show")]
    Info {
        /// Item ID (PDF 路径) 或标题关键词
        #[arg(help = "Item ID (PDF 路径) 或标题关键词 (支持模糊匹配)")]
        id: String,

        /// 以 JSON 格式输出
        #[arg(long, help = "以 JSON 格式输出完整元数据")]
        json: bool,
    },

    /// 查看文献库统计摘要
    ///
    /// 显示文献库的路径、数据库大小，以及文献/附件/标签/笔记的计数。
    Status,

    /// 强制同步文件系统与数据库
    ///
    /// 扫描文献库目录结构, 将文件系统中新增/删除的 PDF 同步到数据库中。
    /// 这与 Lume GUI 启动时执行的同步操作相同。
    Sync,

    /// 在 Lume 图形界面中打开指定的文献
    ///
    /// 通过 open 命令发送信号给已运行的 Lume GUI 实例, 使其聚焦到指定文献。
    /// 注意: 此命令需要 Lume GUI 已在运行中 (IPC 功能尚在开发中)。
    Open {
        /// 要打开的 PDF 文件路径或 Item ID
        #[arg(help = "PDF 文件路径或 Item ID")]
        target: String,
    },

    /// 生成 Shell 自动补全脚本
    ///
    /// 生成指定 Shell 的命令补全脚本, 启用 Tab 键自动补全。
    /// 用法示例 (Zsh):
    ///   lume completions zsh > ~/.zfunc/_lume && compinit
    Completions {
        /// 目标 Shell 类型
        #[arg(help = "Shell 类型: bash, zsh, fish, powershell, elvish")]
        shell: Shell,
    },
}

// ─────────────────────────────────────────────────────────────
// Platform helpers
// ─────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn prepare_console_for_cli() -> Result<(), String> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};

    const ERROR_ACCESS_DENIED: u32 = 5;

    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            let error = GetLastError();
            if error != ERROR_ACCESS_DENIED && AllocConsole() == 0 {
                return Err(format!(
                    "Failed to attach or allocate a console: Win32 error {}",
                    GetLastError()
                ));
            }
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn prepare_console_for_cli() -> Result<(), String> {
    Ok(())
}

fn resolve_app_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME").ok_or("HOME is not set")?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(APP_IDENTIFIER));
    }

    #[cfg(target_os = "windows")]
    {
        let app_data = env::var_os("APPDATA").ok_or("APPDATA is not set")?;
        return Ok(PathBuf::from(app_data).join(APP_IDENTIFIER));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(xdg_data_home) = env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(xdg_data_home).join(APP_IDENTIFIER));
        }

        let home = env::var_os("HOME").ok_or("HOME is not set")?;
        Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join(APP_IDENTIFIER))
    }
}

fn resolve_library_root_dir() -> Result<PathBuf, String> {
    let root = resolve_app_data_dir()?.join("library");
    fs::create_dir_all(&root)
        .map_err(|err| format!("Failed to create library root: {}", err))?;
    Ok(root)
}

fn open_db() -> Result<rusqlite::Connection, String> {
    let library_root = resolve_library_root_dir()?;
    let db_path = library_root.join("lume_library.db");
    init_db_at_path(&db_path)
        .map_err(|err| format!("Failed to open database: {}", err))
}

// ─────────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────────

fn print_item_table(items: &[LibraryItem]) {
    if items.is_empty() {
        println!("No papers found.");
        return;
    }

    println!("{:<4} {:<60} {:<30} {:<6} {}", "#", "Title", "Authors", "Year", "Tags");
    println!("{}", "─".repeat(120));

    for (i, item) in items.iter().enumerate() {
        let title = truncate_str(&item.title, 57);
        let authors = truncate_str(&item.authors, 27);
        let year = if item.year.trim().is_empty() { "—" } else { item.year.trim() };
        let tags = if item.tags.is_empty() { String::new() } else { item.tags.join(", ") };

        println!("{:<4} {:<60} {:<30} {:<6} {}", i + 1, title, authors, year, tags);
    }

    println!("\nTotal: {} items", items.len());
}

fn truncate_str(s: &str, max_len: usize) -> String {
    if s.chars().count() > max_len {
        let truncated: String = s.chars().take(max_len).collect();
        format!("{}...", truncated)
    } else {
        s.to_string()
    }
}

fn print_item_detail(item: &LibraryItem) {
    println!("Title:       {}", item.title);
    println!("Authors:     {}", if item.authors.is_empty() { "—" } else { &item.authors });
    println!("Year:        {}", if item.year.is_empty() { "—" } else { &item.year });
    println!("Type:        {}", if item.item_type.is_empty() { "—" } else { &item.item_type });
    println!("DOI:         {}", if item.doi.is_empty() { "—" } else { &item.doi });
    println!("arXiv ID:    {}", if item.arxiv_id.is_empty() { "—" } else { &item.arxiv_id });
    println!("Publication: {}", if item.publication.is_empty() { "—" } else { &item.publication });
    println!("Volume:      {}", if item.volume.is_empty() { "—" } else { &item.volume });
    println!("Issue:       {}", if item.issue.is_empty() { "—" } else { &item.issue });
    println!("Pages:       {}", if item.pages.is_empty() { "—" } else { &item.pages });
    println!("Publisher:   {}", if item.publisher.is_empty() { "—" } else { &item.publisher });
    println!("ISBN:        {}", if item.isbn.is_empty() { "—" } else { &item.isbn });
    println!("URL:         {}", if item.url.is_empty() { "—" } else { &item.url });
    println!("Language:    {}", if item.language.is_empty() { "—" } else { &item.language });

    if !item.tags.is_empty() {
        println!("Tags:        {}", item.tags.join(", "));
    }

    if !item.r#abstract.is_empty() {
        println!("\n--- Abstract ---\n{}", item.r#abstract);
    }

    if !item.attachments.is_empty() {
        println!("\n--- Attachments ---");
        for att in &item.attachments {
            println!("  [{}] {}", att.attachment_type, att.path);
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Subcommand handlers
// ─────────────────────────────────────────────────────────────

fn cmd_list(json: bool) -> Result<(), String> {
    let conn = open_db()?;
    let library_root = resolve_library_root_dir()?;

    // Sync filesystem → DB
    build_library_tree(&library_root, true, &conn)
        .map_err(|err| format!("Failed to sync library: {}", err))?;

    let items = fetch_all_items_from_db(&conn)
        .map_err(|err| format!("Failed to load papers: {}", err))?;

    if json {
        let output = serde_json::to_string_pretty(&items)
            .map_err(|err| format!("JSON serialization failed: {}", err))?;
        println!("{}", output);
    } else {
        print_item_table(&items);
    }

    Ok(())
}

fn cmd_search(query: String, field: SearchField, tags: Vec<String>, json: bool) -> Result<(), String> {
    let conn = open_db()?;

    let params = SearchLibraryParams {
        query,
        field: field.as_str().to_string(),
        year_filter: None,
        tag_filters: tags,
    };

    let items = search_library_db(&conn, &params)?;

    if json {
        let output = serde_json::to_string_pretty(&items)
            .map_err(|err| format!("JSON serialization failed: {}", err))?;
        println!("{}", output);
    } else {
        if items.is_empty() {
            println!("No results found for query: \"{}\"", params.query);
        } else {
            print_item_table(&items);
        }
    }

    Ok(())
}

fn cmd_import(path: String, folder: String, tags: Vec<String>) -> Result<(), String> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let library_root = resolve_library_root_dir()?;
    let target_folder = if folder.is_empty() {
        library_root.clone()
    } else {
        library_root.join(&folder)
    };

    fs::create_dir_all(&target_folder)
        .map_err(|e| format!("Failed to create target folder: {}", e))?;

    let conn = open_db()?;

    if source.is_dir() {
        // Import all PDFs from directory
        let mut count = 0;
        import_directory_recursive(&source, &target_folder, &conn, &tags, &mut count)?;
        println!("Imported {} PDF files from {}", count, path);
    } else {
        let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("pdf") {
            return Err(format!("Not a PDF file: {}", path));
        }
        import_single_pdf(&source, &target_folder, &conn, &tags)?;
        println!("Imported: {}", source.file_name().unwrap_or_default().to_string_lossy());
    }

    Ok(())
}

fn import_single_pdf(
    source: &PathBuf,
    target_folder: &PathBuf,
    conn: &rusqlite::Connection,
    tags: &[String],
) -> Result<(), String> {
    let file_name = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("Invalid filename")?;

    let target = crate::library_commands::unique_file_path(target_folder, file_name);

    fs::copy(source, &target)
        .map_err(|e| format!("Failed to copy PDF: {}", e))?;

    let new_item = crate::library_commands::build_library_item(&target);
    let _ = crate::library_commands::sync_item_to_db(conn, &new_item);

    // Add tags if specified
    for tag in tags {
        let trimmed = tag.trim();
        if !trimmed.is_empty() {
            let item_id = target.to_string_lossy().to_string();
            let _ = conn.execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?1, ?2)",
                rusqlite::params![&item_id, trimmed],
            );
            let _ = crate::library_commands::ensure_tag_color_for_tag(conn, trimmed);
        }
    }

    Ok(())
}

fn import_directory_recursive(
    dir: &PathBuf,
    target_folder: &PathBuf,
    conn: &rusqlite::Connection,
    tags: &[String],
    count: &mut usize,
) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory {}: {}", dir.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            import_directory_recursive(&path, target_folder, conn, tags, count)?;
        } else if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false) {
            import_single_pdf(&path, target_folder, conn, tags)?;
            *count += 1;
        }
    }

    Ok(())
}

fn cmd_export(format: ExportFormat, ids: Vec<String>, output: Option<String>) -> Result<(), String> {
    let conn = open_db()?;
    let fmt = format.as_str();

    let item_ids: Vec<String> = if ids.is_empty() {
        let items = fetch_all_items_from_db(&conn)
            .map_err(|err| format!("Failed to load papers: {}", err))?;
        items.into_iter().map(|it| it.id).collect()
    } else {
        ids
    };

    if item_ids.is_empty() {
        println!("No items to export.");
        return Ok(());
    }

    let result = export_items_db(&conn, &item_ids, fmt)?;

    match output {
        Some(path) => {
            fs::write(&path, &result)
                .map_err(|e| format!("Failed to write to {}: {}", path, e))?;
            println!("Exported {} items to {} (format: {})", item_ids.len(), path, fmt);
        }
        None => {
            println!("{}", result);
        }
    }

    Ok(())
}

fn cmd_info(id: String, json: bool) -> Result<(), String> {
    let conn = open_db()?;

    // Try exact match by ID
    let mut stmt = conn.prepare(
        "SELECT id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, \
         volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path \
         FROM items WHERE id = ?1"
    ).map_err(|e| format!("Prepare error: {}", e))?;

    let item_result = stmt.query_row(rusqlite::params![&id], |row| {
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
    });

    let mut item = match item_result {
        Ok(it) => it,
        Err(_) => {
            // Fallback: fuzzy match on title
            let pattern = format!("%{}%", id);
            let mut search_stmt = conn.prepare(
                "SELECT id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, \
                 volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path \
                 FROM items WHERE LOWER(title) LIKE LOWER(?1) LIMIT 1"
            ).map_err(|e| format!("Prepare error: {}", e))?;

            search_stmt.query_row(rusqlite::params![&pattern], |row| {
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
            }).map_err(|_| format!("Item not found: {}", id))?
        }
    };

    // Enrich with tags
    item.tags = crate::library_commands::fetch_item_tags(&conn, &item.id);

    // Enrich with attachments
    if let Ok(mut att_stmt) = conn.prepare(
        "SELECT id, item_id, name, path, attachment_type FROM attachments WHERE item_id = ?1"
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

    if json {
        let output = serde_json::to_string_pretty(&item)
            .map_err(|err| format!("JSON serialization failed: {}", err))?;
        println!("{}", output);
    } else {
        print_item_detail(&item);
    }

    Ok(())
}

fn cmd_status() -> Result<(), String> {
    let library_root = resolve_library_root_dir()?;
    let db_path = library_root.join("lume_library.db");

    if !db_path.exists() {
        println!("No Lume library database found at:");
        println!("  {}", db_path.display());
        return Ok(());
    }

    let conn = open_db()?;

    let item_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM items", [], |r| r.get(0)
    ).unwrap_or(0);

    let attachment_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM attachments", [], |r| r.get(0)
    ).unwrap_or(0);

    let tag_count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT tag) FROM item_tags", [], |r| r.get(0)
    ).unwrap_or(0);

    let note_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM notes", [], |r| r.get(0)
    ).unwrap_or(0);

    let folder_count: i64 = count_directories(&library_root);

    let db_size = fs::metadata(&db_path)
        .map(|m| m.len())
        .unwrap_or(0);

    println!("Lume Library Status");
    println!("{}", "─".repeat(40));
    println!("Library path:   {}", library_root.display());
    println!("Database:       {}", db_path.display());
    println!("Database size:  {}", format_bytes(db_size));
    println!("{}", "─".repeat(40));
    println!("Items:          {}", item_count);
    println!("Attachments:    {}", attachment_count);
    println!("Folders:        {}", folder_count);
    println!("Tags:           {}", tag_count);
    println!("Notes:          {}", note_count);

    Ok(())
}

fn count_directories(root: &PathBuf) -> i64 {
    let mut count: i64 = 0;
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                count += 1;
            }
        }
    }
    count
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn cmd_sync() -> Result<(), String> {
    let conn = open_db()?;
    let library_root = resolve_library_root_dir()?;

    println!("Syncing library at {}...", library_root.display());
    build_library_tree(&library_root, true, &conn)
        .map_err(|err| format!("Sync failed: {}", err))?;

    let item_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM items", [], |r| r.get(0)
    ).unwrap_or(0);

    println!("Sync complete. {} items in library.", item_count);
    Ok(())
}

fn cmd_open(target: String) -> Result<(), String> {
    // For now, print a helpful message since IPC is not yet implemented
    eprintln!("⚠ `lume open` requires the Lume GUI to be running.");
    eprintln!("  IPC communication between CLI and GUI is not yet implemented (Phase 2 roadmap).");
    eprintln!();
    eprintln!("  As a workaround, you can open the file directly:");
    eprintln!("  open \"{}\"", target);
    Err("IPC not yet implemented. See `docs/cli-development-plan.md` Phase 2.".to_string())
}

fn cmd_completions(shell: Shell) -> Result<(), String> {
    let mut cmd = <LumeCli as clap::CommandFactory>::command();
    generate(shell, &mut cmd, "lume", &mut io::stdout());
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────

/// Try to intercept CLI args when running as the main Lume binary.
/// Returns Ok(true) if a CLI command was handled, Ok(false) if not.
pub fn try_run_embedded_from_env() -> Result<bool, String> {
    let args: Vec<String> = env::args().skip(1).collect();

    // Only intercept if the first arg looks like a known subcommand or flag
    if args.is_empty() {
        return Ok(false);
    }

    let first = args[0].as_str();
    let known = ["list", "ls", "search", "s", "import", "add", "export", "cite",
                  "info", "show", "status", "sync", "open", "completions",
                  "--help", "-h", "--version", "-V"];

    if !known.contains(&first) {
        return Ok(false);
    }

    prepare_console_for_cli()?;
    let cli = LumeCli::parse();
    dispatch(cli)?;
    Ok(true)
}

/// Standalone lume-cli binary entry point.
pub fn run_standalone_from_env() -> Result<(), String> {
    prepare_console_for_cli()?;
    let cli = LumeCli::parse();
    dispatch(cli)
}

fn dispatch(cli: LumeCli) -> Result<(), String> {
    match cli.command {
        Commands::List { json } => cmd_list(json),
        Commands::Search { query, field, tags, json } => cmd_search(query, field, tags, json),
        Commands::Import { path, folder, tags } => cmd_import(path, folder, tags),
        Commands::Export { format, ids, output } => cmd_export(format, ids, output),
        Commands::Info { id, json } => cmd_info(id, json),
        Commands::Status => cmd_status(),
        Commands::Sync => cmd_sync(),
        Commands::Open { target } => cmd_open(target),
        Commands::Completions { shell } => cmd_completions(shell),
    }
}