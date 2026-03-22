pub mod cli;
pub mod cli_ipc;
pub mod db;
pub mod library_commands;
pub mod metadata_fetch;
/// Module: src-tauri/src/lib.rs
/// Purpose: Entry point for the Tauri backend.
/// Capabilities: Defines AppState, declares the `tauri::mobile_entry_point`, and registers all commands.
pub mod models;
pub mod pdf_handlers;

use pdfium_render::prelude::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager;

use crate::db::init_db;
use crate::pdf_handlers::GlobalPdfium;

fn candidate_pdfium_dirs(app: &tauri::App) -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir);
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            dirs.push(parent.to_path_buf());
        }
    }

    dirs.push(std::path::PathBuf::from("./"));
    dirs.push(std::path::PathBuf::from("./src-tauri/"));

    dirs
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            crate::cli_ipc::focus_main_window(app);
        }))
        .setup(|app| {
            // Warm up PDFium lazily
            if pdf_handlers::GLOBAL_PDFIUM.get().is_none() {
                let mut bindings = None;

                for dir in candidate_pdfium_dirs(app) {
                    if let Some(dir_str) = dir.to_str() {
                        if let Ok(found) = Pdfium::bind_to_library(
                            Pdfium::pdfium_platform_library_name_at_path(dir_str),
                        ) {
                            bindings = Some(found);
                            break;
                        }
                    }
                }

                let bindings = bindings
                    .or_else(|| Pdfium::bind_to_system_library().ok())
                    .expect("Failed to bind to libpdfium");

                let pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
                let _ = pdf_handlers::GLOBAL_PDFIUM.set(GlobalPdfium(pdfium));
            }

            let app_handle = app.handle();
            let db_conn = init_db(&app_handle).expect("Failed to initialize database");
            let cli_runtime = crate::cli_ipc::CliRuntimeState::default();

            if let Some(request) = crate::cli_ipc::startup_open_request_from_env()? {
                cli_runtime.set_pending_open(request);
            }

            app.manage(crate::models::AppState {
                documents: Arc::new(Mutex::new(HashMap::new())),
                db: Arc::new(Mutex::new(db_conn)),
            });
            app.manage(cli_runtime);
            crate::cli_ipc::start_ipc_server(app_handle.clone())?;

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            library_commands::load_library_tree,
            library_commands::get_item_note,
            library_commands::upsert_item_note,
            library_commands::load_pdf_annotations,
            library_commands::save_pdf_annotations,
            library_commands::get_all_annotations,
            library_commands::create_library_folder,
            library_commands::import_pdf_to_folder,
            library_commands::import_identifier_to_folder,
            library_commands::import_reference_file_to_folder,
            library_commands::merge_duplicate_items,
            library_commands::load_trash_items,
            library_commands::delete_library_pdf,
            library_commands::restore_library_pdf,
            library_commands::empty_trash,
            library_commands::rename_library_pdf,
            library_commands::move_library_pdf,
            library_commands::rename_library_folder,
            library_commands::delete_library_folder,
            library_commands::search_library,
            library_commands::get_all_tags,
            library_commands::add_item_tag,
            library_commands::remove_item_tag,
            library_commands::update_item_tags,
            library_commands::set_tag_color,
            library_commands::generate_citation,
            library_commands::export_items,
            library_commands::append_annotations_to_note,
            library_commands::generate_item_annotations_markdown,
            library_commands::generate_annotation_digest,
            library_commands::summarize_document,
            library_commands::translate_selection,
            library_commands::get_item_metadata_fetch_report,
            library_commands::get_settings,
            library_commands::save_setting,
            metadata_fetch::update_item_metadata,
            metadata_fetch::retrieve_item_metadata,
            pdf_handlers::load_pdf,
            pdf_handlers::get_pdf_dimensions,
            pdf_handlers::get_text_rects,
            pdf_handlers::get_page_text,
            pdf_handlers::search_pdf_text,
            pdf_handlers::render_page,
            cli_ipc::take_pending_cli_open_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lume");
}
