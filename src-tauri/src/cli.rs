use std::env;
use std::fs;
use std::path::PathBuf;

use crate::db::init_db_at_path;
use crate::library_commands::{build_library_tree, fetch_all_items_from_db};
use crate::models::LibraryItem;

const APP_IDENTIFIER: &str = "dev.liuup.lume";

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

fn usage() -> &'static str {
    "Lume CLI\n\nUSAGE:\n  Lume --list-papers [--json]\n  lume-cli list-papers [--json]\n\nOPTIONS:\n  --list-papers    Print the saved paper list\n  --json           Print the saved paper list as JSON\n"
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

fn print_human_readable(items: &[LibraryItem]) {
    if items.is_empty() {
        println!("No saved papers found.");
        return;
    }

    for (index, item) in items.iter().enumerate() {
        println!("{}. {}", index + 1, item.title);

        let authors = if item.authors.trim().is_empty() {
            "—"
        } else {
            item.authors.trim()
        };
        let year = if item.year.trim().is_empty() {
            "—"
        } else {
            item.year.trim()
        };

        println!("   Authors: {}", authors);
        println!("   Year: {}", year);

        if !item.tags.is_empty() {
            println!("   Tags: {}", item.tags.join(", "));
        }

        if let Some(attachment) = item.attachments.first() {
            println!("   File: {}", attachment.path);
        }
    }
}

fn list_papers(print_json: bool) -> Result<(), String> {
    let library_root = resolve_library_root_dir()?;
    let db_path = library_root.join("lume_library.db");
    let conn = init_db_at_path(&db_path)
        .map_err(|err| format!("Failed to open database: {}", err))?;

    build_library_tree(&library_root, true, &conn)
        .map_err(|err| format!("Failed to sync library folders: {}", err))?;

    let items = fetch_all_items_from_db(&conn)
        .map_err(|err| format!("Failed to load saved papers: {}", err))?;

    if print_json {
        let json = serde_json::to_string_pretty(&items)
            .map_err(|err| format!("Failed to serialize paper list: {}", err))?;
        println!("{}", json);
    } else {
        print_human_readable(&items);
    }

    Ok(())
}

pub fn try_run_embedded_from_env() -> Result<bool, String> {
    let args: Vec<String> = env::args().skip(1).collect();
    try_run_embedded(&args)
}

pub fn try_run_embedded(args: &[String]) -> Result<bool, String> {
    if !args.iter().any(|arg| arg == "--list-papers") {
        return Ok(false);
    }

    prepare_console_for_cli()?;

    let print_json = args.iter().any(|arg| arg == "--json");
    list_papers(print_json)?;
    Ok(true)
}

pub fn run_standalone_from_env() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    run_standalone(&args)
}

pub fn run_standalone(args: &[String]) -> Result<(), String> {
    match args.first().map(|value| value.as_str()) {
        None | Some("help") | Some("--help") | Some("-h") => {
            print!("{}", usage());
            Ok(())
        }
        Some("list-papers") | Some("--list-papers") => {
            let print_json = args.iter().skip(1).any(|arg| arg == "--json");
            list_papers(print_json)
        }
        Some(other) => Err(format!("Unknown command: {}\n\n{}", other, usage())),
    }
}