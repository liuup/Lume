use pdfium_render::prelude::*;
use std::sync::Mutex;

lazy_static::lazy_static! {
    static ref GLOBAL_PDFIUM: &'static Pdfium = {
        let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./src-tauri/")).unwrap();
        Box::leak(Box::new(Pdfium::new(bindings)))
    };
}

struct AppState {
    document: Mutex<Option<PdfDocument<'static>>>,
}

fn main() {
    let state = AppState {
        document: Mutex::new(None),
    };
    let bytes = std::fs::read("test.pdf").unwrap();
    let doc = GLOBAL_PDFIUM.load_pdf_from_byte_slice(&bytes, None).unwrap();
    *state.document.lock().unwrap() = Some(doc);
    println!("Pages: {}", state.document.lock().unwrap().as_ref().unwrap().pages().len());
}
