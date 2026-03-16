/// Module: src-tauri/src/cli.rs
/// Purpose: Native CLI interface for Lume using clap.
/// Capabilities: Provides subcommands for listing, searching, importing, exporting,
///               inspecting, syncing, opening, and getting status of the paper library.

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use clap_complete::{generate, Shell};
use tauri::Manager;

use crate::cli_ipc::{CliRequest, CliResponse};
use crate::db::init_db_at_path;
use crate::library_commands::{
    build_library_item, build_library_tree, copy_annotation_sidecar, ensure_tag_color_for_tag,
    export_items_db, fetch_all_items_from_db, fetch_item_tags, search_library_db, sync_item_to_db,
    unique_file_path, SearchLibraryParams,
};
use crate::models::{LibraryAttachment, LibraryItem};

const APP_IDENTIFIER: &str = "dev.liuup.lume";

#[derive(Clone, Copy)]
enum InvocationMode {
    Embedded,
    Standalone,
}

enum DispatchDecision {
    Handled,
    LaunchGui,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommandRoute {
    ReadOnly,
    Write,
    Ui,
}

#[derive(Clone, Debug)]
pub struct ImportCommandResult {
    pub imported: usize,
    pub paths: Vec<String>,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct SyncCommandResult {
    pub item_count: i64,
    pub message: String,
}

// CLI argument definitions

#[derive(Clone, ValueEnum)]
pub enum SearchField {
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

#[derive(Clone, ValueEnum)]
pub enum ExportFormat {
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
读操作可以直接在终端运行；open 等需要界面的操作会自动联动已运行的 Lume GUI。

常用示例:
  lume list                          列出全部文献
  lume list --json                   以 JSON 格式输出全部文献
  lume search \"attention\"            搜索标题/作者/摘要中包含关键词的文献
  lume import paper.pdf              导入一篇 PDF 到文献库
  lume export --format bibtex -o refs.bib   导出全部引用为 BibTeX 文件
  lume open paper.pdf                打开库内条目或任意 PDF 文件
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
    #[command(visible_alias = "ls")]
    List {
        #[arg(long, help = "以 JSON 格式输出 (便于管道处理: lume list --json | jq '.[]')")]
        json: bool,
    },

    #[command(visible_alias = "s")]
    Search {
        #[arg(help = "搜索关键词")]
        query: String,
        #[arg(
            long,
            value_enum,
            default_value = "all",
            help = "搜索范围: all=全部字段, title=标题, authors=作者, year=年份, doi, arxiv"
        )]
        field: SearchField,
        #[arg(long = "tag", help = "按标签过滤 (可重复: --tag ml --tag nlp)")]
        tags: Vec<String>,
        #[arg(long, help = "以 JSON 格式输出搜索结果")]
        json: bool,
    },

    #[command(visible_alias = "add")]
    Import {
        #[arg(help = "要导入的 PDF 文件路径, 或包含 PDF 文件的目录路径")]
        path: String,
        #[arg(long, default_value = "", help = "目标文件夹 (文献库内的相对路径)")]
        folder: String,
        #[arg(long = "tag", help = "导入时添加标签 (可重复: --tag ml --tag 2024)")]
        tags: Vec<String>,
    },

    #[command(visible_alias = "cite")]
    Export {
        #[arg(
            long,
            value_enum,
            default_value = "bibtex",
            help = "引用格式: bibtex, ris, apa, mla, chicago, gbt, csljson"
        )]
        format: ExportFormat,
        #[arg(long = "id", help = "仅导出指定条目 (可重复: --id <path1> --id <path2>)")]
        ids: Vec<String>,
        #[arg(long, short, help = "写入文件 (例如: -o references.bib)")]
        output: Option<String>,
    },

    #[command(visible_alias = "show")]
    Info {
        #[arg(help = "Item ID (PDF 路径) 或标题关键词 (支持模糊匹配)")]
        id: String,
        #[arg(long, help = "以 JSON 格式输出完整元数据")]
        json: bool,
    },

    Status,
    Sync,

    Open {
        #[arg(help = "PDF 文件路径或 Item ID")]
        target: String,
    },

    Completions {
        #[arg(help = "Shell 类型: bash, zsh, fish, powershell, elvish")]
        shell: Shell,
    },
}

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
    init_db_at_path(&db_path).map_err(|err| format!("Failed to open database: {}", err))
}

fn print_item_table(items: &[LibraryItem]) {
    if items.is_empty() {
        println!("No papers found.");
        return;
    }

    println!(
        "{:<4} {:<60} {:<30} {:<6} {}",
        "#", "Title", "Authors", "Year", "Tags"
    );
    println!("{}", "─".repeat(120));

    for (i, item) in items.iter().enumerate() {
        let title = truncate_str(&item.title, 57);
        let authors = truncate_str(&item.authors, 27);
        let year = if item.year.trim().is_empty() {
            "—"
        } else {
            item.year.trim()
        };
        let tags = if item.tags.is_empty() {
            String::new()
        } else {
            item.tags.join(", ")
        };

        println!(
            "{:<4} {:<60} {:<30} {:<6} {}",
            i + 1,
            title,
            authors,
            year,
            tags
        );
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
    println!(
        "Authors:     {}",
        if item.authors.is_empty() { "—" } else { &item.authors }
    );
    println!("Year:        {}", if item.year.is_empty() { "—" } else { &item.year });
    println!(
        "Type:        {}",
        if item.item_type.is_empty() {
            "—"
        } else {
            &item.item_type
        }
    );
    println!("DOI:         {}", if item.doi.is_empty() { "—" } else { &item.doi });
    println!(
        "arXiv ID:    {}",
        if item.arxiv_id.is_empty() {
            "—"
        } else {
            &item.arxiv_id
        }
    );
    println!(
        "Publication: {}",
        if item.publication.is_empty() {
            "—"
        } else {
            &item.publication
        }
    );
    println!(
        "Volume:      {}",
        if item.volume.is_empty() { "—" } else { &item.volume }
    );
    println!(
        "Issue:       {}",
        if item.issue.is_empty() { "—" } else { &item.issue }
    );
    println!(
        "Pages:       {}",
        if item.pages.is_empty() { "—" } else { &item.pages }
    );
    println!(
        "Publisher:   {}",
        if item.publisher.is_empty() {
            "—"
        } else {
            &item.publisher
        }
    );
    println!("ISBN:        {}", if item.isbn.is_empty() { "—" } else { &item.isbn });
    println!("URL:         {}", if item.url.is_empty() { "—" } else { &item.url });
    println!(
        "Language:    {}",
        if item.language.is_empty() {
            "—"
        } else {
            &item.language
        }
    );

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

fn cmd_list(json: bool) -> Result<(), String> {
    let conn = open_db()?;
    let library_root = resolve_library_root_dir()?;

    build_library_tree(&library_root, true, &conn)
        .map_err(|err| format!("Failed to sync library: {}", err))?;

    let items = fetch_all_items_from_db(&conn)
        .map_err(|err| format!("Failed to load papers: {}", err))?;

    if json {
        let output =
            serde_json::to_string_pretty(&items).map_err(|err| format!("JSON serialization failed: {}", err))?;
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
        let output =
            serde_json::to_string_pretty(&items).map_err(|err| format!("JSON serialization failed: {}", err))?;
        println!("{}", output);
    } else if items.is_empty() {
        println!("No results found for query: \"{}\"", params.query);
    } else {
        print_item_table(&items);
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

    let mut stmt = conn
        .prepare(
            "SELECT id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, \
             volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path \
             FROM items WHERE id = ?1",
        )
        .map_err(|e| format!("Prepare error: {}", e))?;

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
            let pattern = format!("%{}%", id);
            let mut search_stmt = conn
                .prepare(
                    "SELECT id, item_type, title, authors, year, abstract, doi, arxiv_id, publication, \
                     volume, issue, pages, publisher, isbn, url, language, date_added, date_modified, folder_path \
                     FROM items WHERE LOWER(title) LIKE LOWER(?1) LIMIT 1",
                )
                .map_err(|e| format!("Prepare error: {}", e))?;

            search_stmt
                .query_row(rusqlite::params![&pattern], |row| {
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
                })
                .map_err(|_| format!("Item not found: {}", id))?
        }
    };

    item.tags = fetch_item_tags(&conn, &item.id);

    if let Ok(mut att_stmt) = conn.prepare(
        "SELECT id, item_id, name, path, attachment_type FROM attachments WHERE item_id = ?1",
    ) {
        if let Ok(att_iter) = att_stmt.query_map(rusqlite::params![&item.id], |row| {
            Ok(LibraryAttachment {
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
        let output =
            serde_json::to_string_pretty(&item).map_err(|err| format!("JSON serialization failed: {}", err))?;
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

    let item_count: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap_or(0);
    let attachment_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
        .unwrap_or(0);
    let tag_count: i64 = conn
        .query_row("SELECT COUNT(DISTINCT tag) FROM item_tags", [], |r| r.get(0))
        .unwrap_or(0);
    let note_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap_or(0);
    let folder_count = count_directories(&library_root);
    let db_size = fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);

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

fn cmd_completions(shell: Shell) -> Result<(), String> {
    let mut cmd = <LumeCli as CommandFactory>::command();
    generate(shell, &mut cmd, "lume", &mut io::stdout());
    Ok(())
}

fn count_directories(root: &Path) -> i64 {
    let mut count = 0;
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

fn parse_cli_from_args(raw_args: Vec<String>) -> Result<LumeCli, String> {
    let normalized = normalize_legacy_args(raw_args);
    LumeCli::try_parse_from(normalized).map_err(|err| err.to_string())
}

fn absolutize_existing_path(path: &str) -> Result<String, String> {
    let candidate = PathBuf::from(path);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        env::current_dir()
            .map_err(|err| format!("Failed to resolve current directory: {}", err))?
            .join(candidate)
    };

    Ok(absolute.to_string_lossy().to_string())
}

fn normalize_import_source_path(path: String) -> Result<String, String> {
    let candidate = PathBuf::from(&path);
    if !candidate.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    absolutize_existing_path(&path)
}

fn normalize_open_target(target: String) -> Result<String, String> {
    let candidate = PathBuf::from(&target);
    if candidate.exists() {
        absolutize_existing_path(&target)
    } else {
        Ok(target)
    }
}

fn normalize_legacy_args(raw_args: Vec<String>) -> Vec<String> {
    if raw_args.iter().any(|arg| arg == "--list-papers") {
        let mut normalized = vec![raw_args.first().cloned().unwrap_or_else(|| "lume".to_string())];
        normalized.push("list".to_string());
        if raw_args.iter().any(|arg| arg == "--json") {
            normalized.push("--json".to_string());
        }
        return normalized;
    }

    raw_args
}

fn is_known_cli_invocation(raw_args: &[String]) -> bool {
    if raw_args.len() <= 1 {
        return false;
    }

    if raw_args.iter().any(|arg| arg == "--list-papers") {
        return true;
    }

    matches!(
        raw_args[1].as_str(),
        "list"
            | "ls"
            | "search"
            | "s"
            | "import"
            | "add"
            | "export"
            | "cite"
            | "info"
            | "show"
            | "status"
            | "sync"
            | "open"
            | "completions"
            | "--help"
            | "-h"
            | "--version"
            | "-V"
    )
}

fn route_for_command(command: &Commands) -> CommandRoute {
    match command {
        Commands::Import { .. } | Commands::Sync => CommandRoute::Write,
        Commands::Open { .. } => CommandRoute::Ui,
        Commands::List { .. }
        | Commands::Search { .. }
        | Commands::Export { .. }
        | Commands::Info { .. }
        | Commands::Status
        | Commands::Completions { .. } => CommandRoute::ReadOnly,
    }
}

fn dispatch(cli: LumeCli, mode: InvocationMode) -> Result<DispatchDecision, String> {
    match cli.command {
        Commands::List { json } => {
            cmd_list(json)?;
            Ok(DispatchDecision::Handled)
        }
        Commands::Search {
            query,
            field,
            tags,
            json,
        } => {
            cmd_search(query, field, tags, json)?;
            Ok(DispatchDecision::Handled)
        }
        Commands::Import { path, folder, tags } => dispatch_import(path, folder, tags),
        Commands::Export { format, ids, output } => {
            cmd_export(format, ids, output)?;
            Ok(DispatchDecision::Handled)
        }
        Commands::Info { id, json } => {
            cmd_info(id, json)?;
            Ok(DispatchDecision::Handled)
        }
        Commands::Status => {
            cmd_status()?;
            Ok(DispatchDecision::Handled)
        }
        Commands::Sync => dispatch_sync(),
        Commands::Open { target } => dispatch_open(mode, target),
        Commands::Completions { shell } => {
            cmd_completions(shell)?;
            Ok(DispatchDecision::Handled)
        }
    }
}

fn dispatch_import(path: String, folder: String, tags: Vec<String>) -> Result<DispatchDecision, String> {
    let normalized_path = normalize_import_source_path(path)?;
    let request = CliRequest::Import {
        path: normalized_path.clone(),
        folder: folder.clone(),
        tags: tags.clone(),
    };

    if let Some(response) = crate::cli_ipc::try_send_request(&request)? {
        print_ipc_response(response)?;
        return Ok(DispatchDecision::Handled);
    }

    let library_root = resolve_library_root_dir()?;
    let conn = open_db()?;
    let result = run_import_with_conn(&conn, &library_root, normalized_path, folder, tags)?;
    print_import_result(&result);
    Ok(DispatchDecision::Handled)
}

fn dispatch_sync() -> Result<DispatchDecision, String> {
    let request = CliRequest::Sync;
    if let Some(response) = crate::cli_ipc::try_send_request(&request)? {
        print_ipc_response(response)?;
        return Ok(DispatchDecision::Handled);
    }

    let conn = open_db()?;
    let library_root = resolve_library_root_dir()?;
    let result = run_sync_with_conn(&conn, &library_root)?;
    print_sync_result(&result);
    Ok(DispatchDecision::Handled)
}

fn dispatch_open(mode: InvocationMode, target: String) -> Result<DispatchDecision, String> {
    let normalized_target = normalize_open_target(target)?;
    let request = CliRequest::Open {
        target: normalized_target.clone(),
    };

    if let Some(response) = crate::cli_ipc::try_send_request(&request)? {
        print_ipc_response(response)?;
        return Ok(DispatchDecision::Handled);
    }

    match mode {
        InvocationMode::Embedded => {
            crate::cli_ipc::store_startup_open_request(&normalized_target)?;
            Ok(DispatchDecision::LaunchGui)
        }
        InvocationMode::Standalone => {
            launch_gui_with_open_request(&normalized_target)?;
            Ok(DispatchDecision::Handled)
        }
    }
}

fn launch_gui_with_open_request(target: &str) -> Result<(), String> {
    let gui_binary = resolve_gui_binary_path()?;
    let encoded = crate::cli_ipc::encoded_startup_open_request(target)?;

    ProcessCommand::new(gui_binary)
        .env(crate::cli_ipc::startup_open_env_var_name(), encoded)
        .spawn()
        .map_err(|err| format!("Failed to launch Lume GUI: {}", err))?;

    Ok(())
}

fn resolve_gui_binary_path() -> Result<PathBuf, String> {
    let current = env::current_exe().map_err(|err| format!("Failed to resolve current executable: {}", err))?;
    let current_name = current
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();

    if current_name == "lume" || current_name == "lume.exe" {
        return Ok(current);
    }

    let parent = current.parent().ok_or("Failed to resolve executable directory")?;
    let gui_name = if cfg!(target_os = "windows") { "Lume.exe" } else { "Lume" };
    let candidate = parent.join(gui_name);

    if candidate.exists() {
        Ok(candidate)
    } else {
        Err(format!(
            "Failed to find sibling GUI binary at {}",
            candidate.display()
        ))
    }
}

fn print_import_result(result: &ImportCommandResult) {
    println!("{}", result.message);
}

fn print_sync_result(result: &SyncCommandResult) {
    println!("{}", result.message);
}

fn print_ipc_response(response: CliResponse) -> Result<(), String> {
    match response {
        CliResponse::Ok { message }
        | CliResponse::OpenScheduled { message }
        | CliResponse::ImportResult { message, .. }
        | CliResponse::SyncResult { message, .. } => {
            println!("{}", message);
            Ok(())
        }
        CliResponse::Error { message } => Err(message),
    }
}

fn add_tags_to_item(conn: &rusqlite::Connection, item_id: &str, tags: &[String]) {
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }

        let _ = conn.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?1, ?2)",
            rusqlite::params![item_id, trimmed],
        );
        let _ = ensure_tag_color_for_tag(conn, trimmed);
    }
}

fn resolve_target_folder(library_root: &Path, folder: &str) -> Result<PathBuf, String> {
    let folder_path = Path::new(folder);
    if folder_path.is_absolute() {
        return Err("Target folder must be relative to the library root.".to_string());
    }

    let target = if folder.trim().is_empty() {
        library_root.to_path_buf()
    } else {
        library_root.join(folder_path)
    };
    fs::create_dir_all(&target)
        .map_err(|err| format!("Failed to create target folder: {}", err))?;
    Ok(target)
}

fn import_single_pdf(
    source: &Path,
    target_folder: &Path,
    conn: &rusqlite::Connection,
    tags: &[String],
) -> Result<PathBuf, String> {
    if !source.exists() {
        return Err(format!("Path does not exist: {}", source.display()));
    }

    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("");
    if !extension.eq_ignore_ascii_case("pdf") {
        return Err(format!("Not a PDF file: {}", source.display()));
    }

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid filename")?;
    let target = unique_file_path(target_folder, file_name);

    fs::copy(source, &target).map_err(|err| format!("Failed to copy PDF: {}", err))?;
    copy_annotation_sidecar(source, &target);

    let item = build_library_item(&target);
    sync_item_to_db(conn, &item).map_err(|err| format!("Failed to sync imported item: {}", err))?;
    add_tags_to_item(conn, &item.id, tags);

    Ok(target)
}

fn import_directory_recursive(
    dir: &Path,
    target_folder: &Path,
    conn: &rusqlite::Connection,
    tags: &[String],
    paths: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|err| format!("Failed to read directory {}: {}", dir.display(), err))?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to read directory entry: {}", err))?;
        let path = entry.path();

        if path.is_dir() {
            import_directory_recursive(&path, target_folder, conn, tags, paths)?;
        } else if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false)
        {
            let imported = import_single_pdf(&path, target_folder, conn, tags)?;
            paths.push(imported.to_string_lossy().to_string());
        }
    }

    Ok(())
}

fn run_import_with_conn(
    conn: &rusqlite::Connection,
    library_root: &Path,
    path: String,
    folder: String,
    tags: Vec<String>,
) -> Result<ImportCommandResult, String> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let target_folder = resolve_target_folder(library_root, &folder)?;
    let mut imported_paths = Vec::new();

    if source.is_dir() {
        import_directory_recursive(&source, &target_folder, conn, &tags, &mut imported_paths)?;
    } else {
        let imported = import_single_pdf(&source, &target_folder, conn, &tags)?;
        imported_paths.push(imported.to_string_lossy().to_string());
    }

    let message = if source.is_dir() {
        format!("Imported {} PDF files from {}", imported_paths.len(), path)
    } else {
        format!(
            "Imported: {}",
            source.file_name().unwrap_or_default().to_string_lossy()
        )
    };

    Ok(ImportCommandResult {
        imported: imported_paths.len(),
        paths: imported_paths,
        message,
    })
}

fn run_sync_with_conn(
    conn: &rusqlite::Connection,
    library_root: &Path,
) -> Result<SyncCommandResult, String> {
    build_library_tree(library_root, true, conn).map_err(|err| format!("Sync failed: {}", err))?;
    let item_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
        .unwrap_or(0);

    Ok(SyncCommandResult {
        item_count,
        message: format!("Sync complete. {} items in library.", item_count),
    })
}

pub fn run_import_with_app(
    app: &tauri::AppHandle,
    path: String,
    folder: String,
    tags: Vec<String>,
) -> Result<ImportCommandResult, String> {
    let library_root = crate::library_commands::library_root_dir(app)?;
    let state = app.state::<crate::models::AppState>();
    let conn = state.db.lock().map_err(|_| "Failed to lock database".to_string())?;
    run_import_with_conn(&conn, &library_root, path, folder, tags)
}

pub fn run_sync_with_app(app: &tauri::AppHandle) -> Result<SyncCommandResult, String> {
    let library_root = crate::library_commands::library_root_dir(app)?;
    let state = app.state::<crate::models::AppState>();
    let conn = state.db.lock().map_err(|_| "Failed to lock database".to_string())?;
    run_sync_with_conn(&conn, &library_root)
}

pub fn try_run_embedded_from_env() -> Result<bool, String> {
    let raw_args: Vec<String> = env::args().collect();

    if !is_known_cli_invocation(&raw_args) {
        return Ok(false);
    }

    prepare_console_for_cli()?;
    let cli = parse_cli_from_args(raw_args)?;
    let route = route_for_command(&cli.command);
    let decision = dispatch(cli, InvocationMode::Embedded)?;

    match (route, decision) {
        (CommandRoute::Ui, DispatchDecision::LaunchGui) => Ok(false),
        (_, _) => Ok(true),
    }
}

pub fn run_standalone_from_env() -> Result<(), String> {
    prepare_console_for_cli()?;
    let raw_args: Vec<String> = env::args().collect();
    let cli = parse_cli_from_args(raw_args)?;
    let _ = dispatch(cli, InvocationMode::Standalone)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_legacy_args, route_for_command, CliRequest, CommandRoute, Commands, LumeCli};

    #[test]
    fn normalizes_legacy_list_command() {
        let args = vec![
            "Lume".to_string(),
            "--list-papers".to_string(),
            "--json".to_string(),
        ];
        let normalized = normalize_legacy_args(args);
        assert_eq!(normalized, vec!["Lume", "list", "--json"]);
    }

    #[test]
    fn classifies_command_routes() {
        let cli = LumeCli {
            command: Commands::Open {
                target: "paper.pdf".to_string(),
            },
        };
        assert_eq!(route_for_command(&cli.command), CommandRoute::Ui);

        let cli = LumeCli {
            command: Commands::Sync,
        };
        assert_eq!(route_for_command(&cli.command), CommandRoute::Write);

        let cli = LumeCli {
            command: Commands::Status,
        };
        assert_eq!(route_for_command(&cli.command), CommandRoute::ReadOnly);
    }

    #[test]
    fn request_type_is_available_for_cli_module_tests() {
        let request = CliRequest::Open {
            target: "paper.pdf".to_string(),
        };
        match request {
            CliRequest::Open { target } => assert_eq!(target, "paper.pdf"),
            _ => panic!("expected open request"),
        }
    }
}
