use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;

#[cfg(not(unix))]
use std::net::{TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

pub const CLI_OPEN_EVENT: &str = "cli-open-request";
pub const CLI_LIBRARY_CHANGED_EVENT: &str = "cli-library-changed";

const STARTUP_OPEN_ENV_VAR: &str = "LUME_STARTUP_OPEN_REQUEST";
#[cfg(not(unix))]
const IPC_PORT_BASE: u16 = 43800;
#[cfg(not(unix))]
const IPC_PORT_SPAN: u16 = 1000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CliRequest {
    Open { target: String },
    Import {
        path: String,
        folder: String,
        tags: Vec<String>,
    },
    Sync,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CliResponse {
    Ok { message: String },
    OpenScheduled { message: String },
    ImportResult {
        imported: usize,
        paths: Vec<String>,
        message: String,
    },
    SyncResult {
        item_count: i64,
        message: String,
    },
    Error { message: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliOpenRequest {
    pub target: String,
    pub source: String,
    pub focus: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLibraryChangedPayload {
    pub reason: String,
}

#[derive(Default)]
pub struct CliRuntimeState {
    pending_open: Mutex<Option<CliOpenRequest>>,
}

impl CliRuntimeState {
    pub fn set_pending_open(&self, request: CliOpenRequest) {
        if let Ok(mut pending) = self.pending_open.lock() {
            *pending = Some(request);
        }
    }

    pub fn take_pending_open(&self) -> Option<CliOpenRequest> {
        self.pending_open.lock().ok().and_then(|mut pending| pending.take())
    }
}

#[tauri::command]
pub fn take_pending_cli_open_request(
    state: tauri::State<'_, CliRuntimeState>,
) -> Result<Option<CliOpenRequest>, String> {
    Ok(state.take_pending_open())
}

pub fn startup_open_request_from_env() -> Result<Option<CliOpenRequest>, String> {
    match env::var(STARTUP_OPEN_ENV_VAR) {
        Ok(value) => {
            env::remove_var(STARTUP_OPEN_ENV_VAR);
            serde_json::from_str(&value)
                .map(Some)
                .map_err(|err| format!("Failed to parse startup open request: {}", err))
        }
        Err(env::VarError::NotPresent) => Ok(None),
        Err(err) => Err(format!("Failed to read startup open request: {}", err)),
    }
}

pub fn store_startup_open_request(target: &str) -> Result<(), String> {
    let encoded = encoded_startup_open_request(target)?;
    env::set_var(STARTUP_OPEN_ENV_VAR, encoded);
    Ok(())
}

pub fn startup_open_env_var_name() -> &'static str {
    STARTUP_OPEN_ENV_VAR
}

pub fn encoded_startup_open_request(target: &str) -> Result<String, String> {
    let payload = CliOpenRequest {
        target: target.to_string(),
        source: "startup".to_string(),
        focus: true,
    };
    serde_json::to_string(&payload)
        .map_err(|err| format!("Failed to encode startup open request: {}", err))
}

pub fn dispatch_request(app: &tauri::AppHandle, request: CliRequest) -> CliResponse {
    match request {
        CliRequest::Open { target } => {
            focus_main_window(app);
            let payload = CliOpenRequest {
                target,
                source: "ipc".to_string(),
                focus: true,
            };
            match emit_open_request(app, payload) {
                Ok(()) => CliResponse::OpenScheduled {
                    message: "Open request sent to running Lume instance.".to_string(),
                },
                Err(err) => CliResponse::Error { message: err },
            }
        }
        CliRequest::Import { path, folder, tags } => {
            match crate::cli::run_import_with_app(app, path, folder, tags) {
                Ok(result) => {
                    let _ = emit_library_changed(app, "import");
                    CliResponse::ImportResult {
                        imported: result.imported,
                        paths: result.paths,
                        message: result.message,
                    }
                }
                Err(err) => CliResponse::Error { message: err },
            }
        }
        CliRequest::Sync => match crate::cli::run_sync_with_app(app) {
            Ok(result) => {
                let _ = emit_library_changed(app, "sync");
                CliResponse::SyncResult {
                    item_count: result.item_count,
                    message: result.message,
                }
            }
            Err(err) => CliResponse::Error { message: err },
        },
    }
}

pub fn emit_open_request(app: &tauri::AppHandle, request: CliOpenRequest) -> Result<(), String> {
    app.emit(CLI_OPEN_EVENT, request)
        .map_err(|err| format!("Failed to emit open request: {}", err))
}

pub fn emit_library_changed(app: &tauri::AppHandle, reason: &str) -> Result<(), String> {
    app.emit(
        CLI_LIBRARY_CHANGED_EVENT,
        CliLibraryChangedPayload {
            reason: reason.to_string(),
        },
    )
    .map_err(|err| format!("Failed to emit library change event: {}", err))
}

pub fn focus_main_window(app: &tauri::AppHandle) {
    let maybe_window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().values().next().cloned());

    if let Some(window) = maybe_window {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn try_send_request(request: &CliRequest) -> Result<Option<CliResponse>, String> {
    #[cfg(unix)]
    {
        match UnixStream::connect(ipc_socket_path()) {
            Ok(mut stream) => send_request_over_stream(&mut stream, request).map(Some),
            Err(err) if is_server_unavailable(&err) => Ok(None),
            Err(err) => Err(format!("Failed to connect to running Lume instance: {}", err)),
        }
    }

    #[cfg(not(unix))]
    {
        match TcpStream::connect(("127.0.0.1", ipc_tcp_port())) {
            Ok(mut stream) => send_request_over_stream(&mut stream, request).map(Some),
            Err(err) if is_server_unavailable(&err) => Ok(None),
            Err(err) => Err(format!("Failed to connect to running Lume instance: {}", err)),
        }
    }
}

pub fn start_ipc_server(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(unix)]
    {
        start_unix_server(app)
    }

    #[cfg(not(unix))]
    {
        start_tcp_server(app)
    }
}

fn send_request_over_stream<T>(stream: &mut T, request: &CliRequest) -> Result<CliResponse, String>
where
    T: Read + Write,
{
    let mut payload = serde_json::to_vec(request)
        .map_err(|err| format!("Failed to encode request: {}", err))?;
    payload.push(b'\n');
    stream
        .write_all(&payload)
        .map_err(|err| format!("Failed to write request: {}", err))?;
    stream
        .flush()
        .map_err(|err| format!("Failed to flush request: {}", err))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|err| format!("Failed to read response: {}", err))?;
    serde_json::from_slice(&response)
        .map_err(|err| format!("Failed to decode response: {}", err))
}

fn handle_stream<T>(stream: &mut T, app: &tauri::AppHandle) -> Result<(), String>
where
    T: Read + Write,
{
    let mut request_bytes = Vec::new();
    {
        let mut reader = BufReader::new(&mut *stream);
        reader
            .read_until(b'\n', &mut request_bytes)
            .map_err(|err| format!("Failed to read CLI IPC request: {}", err))?;
    }
    if request_bytes.last() == Some(&b'\n') {
        request_bytes.pop();
    }
    if request_bytes.is_empty() {
        return Err("CLI IPC request was empty".to_string());
    }
    let request: CliRequest = serde_json::from_slice(&request_bytes)
        .map_err(|err| format!("Failed to parse CLI IPC request: {}", err))?;
    let response = dispatch_request(app, request);
    let encoded = serde_json::to_vec(&response)
        .map_err(|err| format!("Failed to encode CLI IPC response: {}", err))?;
    stream
        .write_all(&encoded)
        .map_err(|err| format!("Failed to write CLI IPC response: {}", err))?;
    stream
        .flush()
        .map_err(|err| format!("Failed to flush CLI IPC response: {}", err))
}

#[cfg(unix)]
fn start_unix_server(app: tauri::AppHandle) -> Result<(), String> {
    let socket_path = ipc_socket_path();
    if socket_path.exists() {
        let _ = std::fs::remove_file(&socket_path);
    }

    let listener = UnixListener::bind(&socket_path)
        .map_err(|err| format!("Failed to bind CLI IPC socket {}: {}", socket_path.display(), err))?;

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    let app = app.clone();
                    thread::spawn(move || {
                        if let Err(err) = handle_stream(&mut stream, &app) {
                            let _ = write_error_response(&mut stream, err);
                        }
                    });
                }
                Err(err) => {
                    eprintln!("CLI IPC accept error: {}", err);
                }
            }
        }
    });

    Ok(())
}

#[cfg(not(unix))]
fn start_tcp_server(app: tauri::AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", ipc_tcp_port()))
        .map_err(|err| format!("Failed to bind CLI IPC port {}: {}", ipc_tcp_port(), err))?;

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    let app = app.clone();
                    thread::spawn(move || {
                        if let Err(err) = handle_stream(&mut stream, &app) {
                            let _ = write_error_response(&mut stream, err);
                        }
                    });
                }
                Err(err) => {
                    eprintln!("CLI IPC accept error: {}", err);
                }
            }
        }
    });

    Ok(())
}

fn write_error_response<T>(stream: &mut T, message: String) -> Result<(), String>
where
    T: Write,
{
    let encoded = serde_json::to_vec(&CliResponse::Error { message })
        .map_err(|err| format!("Failed to encode CLI IPC error response: {}", err))?;
    stream
        .write_all(&encoded)
        .map_err(|err| format!("Failed to write CLI IPC error response: {}", err))?;
    stream
        .flush()
        .map_err(|err| format!("Failed to flush CLI IPC error response: {}", err))
}

#[cfg(unix)]
fn ipc_socket_path() -> PathBuf {
    env::temp_dir().join("dev.liuup.lume.cli.sock")
}

#[cfg(not(unix))]
fn ipc_tcp_port() -> u16 {
    let checksum: u16 = "dev.liuup.lume"
        .bytes()
        .fold(0u16, |acc, byte| acc.wrapping_add(byte as u16));
    IPC_PORT_BASE + (checksum % IPC_PORT_SPAN)
}

fn is_server_unavailable(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::AddrNotAvailable
            | std::io::ErrorKind::TimedOut
    )
}

#[cfg(test)]
mod tests {
    use super::{CliRequest, CliResponse};

    #[test]
    fn request_round_trip_serializes() {
        let request = CliRequest::Import {
            path: "paper.pdf".to_string(),
            folder: "ml".to_string(),
            tags: vec!["tag-a".to_string(), "tag-b".to_string()],
        };
        let encoded = serde_json::to_string(&request).expect("request encodes");
        let decoded: CliRequest = serde_json::from_str(&encoded).expect("request decodes");
        match decoded {
            CliRequest::Import { path, folder, tags } => {
                assert_eq!(path, "paper.pdf");
                assert_eq!(folder, "ml");
                assert_eq!(tags.len(), 2);
            }
            _ => panic!("expected import request"),
        }
    }

    #[test]
    fn response_round_trip_serializes() {
        let response = CliResponse::SyncResult {
            item_count: 42,
            message: "done".to_string(),
        };
        let encoded = serde_json::to_string(&response).expect("response encodes");
        let decoded: CliResponse = serde_json::from_str(&encoded).expect("response decodes");
        match decoded {
            CliResponse::SyncResult { item_count, message } => {
                assert_eq!(item_count, 42);
                assert_eq!(message, "done");
            }
            _ => panic!("expected sync response"),
        }
    }
}
