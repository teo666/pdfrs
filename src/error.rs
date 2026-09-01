use wasm_bindgen::JsValue;

#[derive(Debug, thiserror::Error)]
pub enum PdfrsError {
    #[error("failed to read PDF: {0}")]
    Load(#[from] lopdf::Error),
    #[error("failed to write PDF: {0}")]
    Save(std::io::Error),
    #[error("invalid arguments: {0}")]
    InvalidArgument(String),
    #[error("page {0} does not exist")]
    PageNotFound(u32),
    #[error("no input documents provided")]
    NoInput,
    #[error("failed to decode options: {0}")]
    Options(String),
}

impl From<PdfrsError> for JsValue {
    fn from(err: PdfrsError) -> Self {
        js_sys::Error::new(&err.to_string()).into()
    }
}

pub type Result<T> = std::result::Result<T, PdfrsError>;
