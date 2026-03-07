use pdfium_render::prelude::*;
fn test() {
    let mut config = PdfRenderConfig::new();
    config = config.set_target_size(1000i32, 1000i32);
}
