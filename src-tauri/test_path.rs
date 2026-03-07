use pdfium_render::prelude::*;
fn main() {
    println!("{}", Pdfium::pdfium_platform_library_name_at_path("/path/to/resource"));
}
