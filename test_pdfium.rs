use pdfium_render::prelude::*;

fn main() {
    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./src-tauri/")).unwrap()
    );
    let bytes = std::fs::read("test.pdf").unwrap();
    let document = pdfium.load_pdf_from_byte_slice(&bytes, None).unwrap();
    println!("Pages: {}", document.pages().len());
}
