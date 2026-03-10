/// Module: src-tauri/src/lib.rs
/// Purpose: Entry point for the Tauri backend.
/// Capabilities: Defines AppState, declares the `tauri::mobile_entry_point`, and registers all commands.

pub mod models;
pub mod db;
pub mod metadata_fetch;
pub mod pdf_handlers;
pub mod library_commands;

use pdfium_render::prelude::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager;

use crate::db::init_db;
use crate::pdf_handlers::GlobalPdfium;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Warm up PDFium lazily
            if pdf_handlers::GLOBAL_PDFIUM.get().is_none() {
                let resource_dir = app.path().resource_dir().unwrap_or_else(|_| std::path::PathBuf::from("./"));
                let resource_dir_str = resource_dir.to_str().unwrap_or("./");
                
                let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(resource_dir_str))
                    .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./")))
                    .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./src-tauri/")))
                    .or_else(|_| Pdfium::bind_to_system_library())
                    .expect("Failed to bind to libpdfium");

                let pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
                let _ = pdf_handlers::GLOBAL_PDFIUM.set(GlobalPdfium(pdfium));
            }
            
            let app_handle = app.handle();
            let db_conn = init_db(&app_handle).expect("Failed to initialize database");
            
            app.manage(crate::models::AppState {
                documents: Arc::new(Mutex::new(HashMap::new())),
                db: Arc::new(Mutex::new(db_conn)),
            });
            
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
            library_commands::delete_library_pdf,
            library_commands::rename_library_pdf,
            library_commands::rename_library_folder,
            library_commands::search_library,
            library_commands::get_all_tags,
            library_commands::add_item_tag,
            library_commands::remove_item_tag,
            library_commands::update_item_tags,
            library_commands::set_tag_color,
            library_commands::generate_citation,
            library_commands::export_items,
            library_commands::append_annotations_to_note,
            library_commands::get_settings,
            library_commands::save_setting,
            metadata_fetch::update_item_metadata,
            pdf_handlers::load_pdf,
            pdf_handlers::get_pdf_dimensions,
            pdf_handlers::get_text_rects,
            pdf_handlers::get_page_text,
            pdf_handlers::render_page
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lume");
}
