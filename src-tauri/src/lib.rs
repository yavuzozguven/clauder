use serde::Serialize;
use tauri::Emitter;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read as IoRead, Write as IoWrite};
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

/// Extract `/command-name` from strings like:
/// `<command-name>/doctor</command-name>\n...`
fn extract_command_name(s: &str) -> Option<String> {
    let start = s.find("<command-name>")? + "<command-name>".len();
    let end = s[start..].find("</command-name>")?;
    let cmd = s[start..start + end].trim();
    if cmd.is_empty() { None } else { Some(cmd.to_string()) }
}

// ── Data types ───────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub session_count: usize,
    pub last_activity_ts: u64,
}

#[derive(Serialize, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub message_count: usize,
    pub token_count: u64,
    pub timestamp: Option<String>,
    pub git_branch: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ToolUse {
    pub name: String,
    pub input: String,
}

#[derive(Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
    pub thinking: Option<String>,
    pub model: Option<String>,
    pub tool_uses: Vec<ToolUse>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Serialize, Clone)]
pub struct StreamEvent {
    pub kind: String,
    pub content: String,
    pub tool_name: Option<String>,
}

#[derive(Serialize)]
pub struct SendResult {
    pub session_id: String,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct InitEvent {
    pub session_id: String,
    pub slash_commands: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ResultEvent {
    pub session_id: String,
    pub cost_usd: f64,
    pub is_error: bool,
}

struct HeadlessProcess {
    stdin: std::process::ChildStdin,
    child: Child,
}

struct HeadlessState {
    process: Mutex<Option<HeadlessProcess>>,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn claude_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "~".to_string());
    PathBuf::from(home).join(".claude").join("projects")
}

fn get_cwd_from_project(project_dir: &PathBuf) -> Option<String> {
    let entries = fs::read_dir(project_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            if let Ok(content) = fs::read_to_string(&path) {
                for line in content.lines() {
                    if let Ok(val) = serde_json::from_str::<Value>(line) {
                        if let Some(cwd) = val.get("cwd").and_then(|v| v.as_str()) {
                            return Some(cwd.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn list_jsonl_ids(project_path: &str) -> HashSet<String> {
    let claude_project_dir = claude_dir();
    let entries = fs::read_dir(&claude_project_dir).unwrap_or_else(|_| {
        fs::read_dir("/tmp").unwrap()
    });
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        if let Some(cwd) = get_cwd_from_project(&path) {
            if cwd == project_path {
                return fs::read_dir(&path)
                    .map(|entries| {
                        entries.flatten()
                            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
                            .filter_map(|e| {
                                e.path().file_stem()
                                    .and_then(|s| s.to_str())
                                    .map(|s| s.to_string())
                            })
                            .collect()
                    })
                    .unwrap_or_default();
            }
        }
    }
    HashSet::new()
}

// ── Read-only commands ───────────────────────────────────────────────────────

#[tauri::command]
async fn get_projects() -> Vec<Project> {
    tauri::async_runtime::spawn_blocking(get_projects_inner)
        .await
        .unwrap_or_default()
}

fn get_projects_inner() -> Vec<Project> {
    let projects_dir = claude_dir();
    let mut projects = Vec::new();

    let Ok(entries) = fs::read_dir(&projects_dir) else {
        return projects;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let id = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let session_count = fs::read_dir(&path)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| {
                        e.path().extension().and_then(|x| x.to_str()) == Some("jsonl")
                    })
                    .count()
            })
            .unwrap_or(0);

        if session_count == 0 {
            continue;
        }

        let cwd = get_cwd_from_project(&path);
        let proj_path = cwd.clone().unwrap_or_else(|| {
            format!("/{}", id.trim_start_matches('-').replace('-', "/"))
        });

        let name = proj_path
            .split('/')
            .last()
            .unwrap_or(&proj_path)
            .to_string();

        let last_activity_ts = fs::read_dir(&path)
            .ok()
            .and_then(|entries| {
                entries
                    .flatten()
                    .filter(|e| {
                        e.path().extension().and_then(|x| x.to_str()) == Some("jsonl")
                    })
                    .filter_map(|e| {
                        e.metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| {
                                t.duration_since(std::time::UNIX_EPOCH).ok()
                            })
                            .map(|d| d.as_secs())
                    })
                    .max()
            })
            .unwrap_or(0);

        projects.push(Project {
            id,
            name,
            path: proj_path,
            session_count,
            last_activity_ts,
        });
    }

    projects.sort_by(|a, b| b.last_activity_ts.cmp(&a.last_activity_ts));
    projects
}

#[tauri::command]
async fn get_sessions(project_id: String) -> Vec<Session> {
    tauri::async_runtime::spawn_blocking(move || get_sessions_inner(project_id))
        .await
        .unwrap_or_default()
}

fn get_sessions_inner(project_id: String) -> Vec<Session> {
    let projects_dir = claude_dir();
    let project_path = projects_dir.join(&project_id);
    let mut sessions = Vec::new();

    let Ok(entries) = fs::read_dir(&project_path) else {
        return sessions;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };

        let mut title = String::new();
        let mut command_title = String::new();
        let mut message_count = 0usize;
        let mut token_count = 0u64;
        let mut timestamp: Option<String> = None;
        let mut git_branch: Option<String> = None;

        for line in content.lines() {
            let Ok(val) = serde_json::from_str::<Value>(line) else {
                continue;
            };

            let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");

            if timestamp.is_none() {
                timestamp = val
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string());
            }

            if git_branch.is_none() {
                git_branch = val
                    .get("gitBranch")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string());
            }

            match msg_type {
                "user" => {
                    let content_val =
                        val.get("message").and_then(|m| m.get("content"));
                    let text = match content_val {
                        Some(Value::String(s)) => {
                            if command_title.is_empty() {
                                if let Some(cmd) = extract_command_name(s) {
                                    command_title = cmd;
                                }
                            }
                            if s.trim_start().starts_with('<') {
                                continue;
                            }
                            s.clone()
                        }
                        Some(Value::Array(arr)) => arr
                            .iter()
                            .filter(|item| {
                                item.get("type").and_then(|t| t.as_str()) == Some("text")
                            })
                            .filter_map(|item| {
                                item.get("text").and_then(|t| t.as_str())
                            })
                            .filter(|t| !t.trim_start().starts_with('<'))
                            .collect::<Vec<_>>()
                            .join(" "),
                        _ => continue,
                    };

                    message_count += 1;
                    if title.is_empty() && !text.trim().is_empty() {
                        title = text.chars().take(80).collect();
                    }
                }
                "system" => {
                    if command_title.is_empty() {
                        if let Some(content) = val.get("content").and_then(|c| c.as_str()) {
                            if let Some(cmd) = extract_command_name(content) {
                                command_title = cmd;
                            }
                        }
                    }
                }
                "assistant" => {
                    message_count += 1;
                    if let Some(usage) =
                        val.get("message").and_then(|m| m.get("usage"))
                    {
                        token_count += usage
                            .get("input_tokens")
                            .and_then(|t| t.as_u64())
                            .unwrap_or(0);
                        token_count += usage
                            .get("output_tokens")
                            .and_then(|t| t.as_u64())
                            .unwrap_or(0);
                        token_count += usage
                            .get("cache_creation_input_tokens")
                            .and_then(|t| t.as_u64())
                            .unwrap_or(0);
                        token_count += usage
                            .get("cache_read_input_tokens")
                            .and_then(|t| t.as_u64())
                            .unwrap_or(0);
                    }
                }
                _ => {}
            }
        }

        if title.is_empty() {
            title = if !command_title.is_empty() {
                command_title
            } else {
                session_id.clone()
            };
        }

        sessions.push(Session {
            id: session_id,
            title,
            message_count,
            token_count,
            timestamp,
            git_branch,
        });
    }

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    sessions
}

#[tauri::command]
async fn get_session_messages(project_id: String, session_id: String) -> Vec<ChatMessage> {
    tauri::async_runtime::spawn_blocking(move || get_session_messages_inner(project_id, session_id))
        .await
        .unwrap_or_default()
}

fn get_session_messages_inner(project_id: String, session_id: String) -> Vec<ChatMessage> {
    let projects_dir = claude_dir();
    let session_path = projects_dir
        .join(&project_id)
        .join(format!("{}.jsonl", session_id));

    let Ok(content) = fs::read_to_string(&session_path) else {
        return Vec::new();
    };

    let mut messages = Vec::new();

    for line in content.lines() {
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let timestamp = val
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string());

        match msg_type {
            "user" => {
                let content_val = val.get("message").and_then(|m| m.get("content"));
                let content_str = match content_val {
                    Some(Value::String(s)) => {
                        if s.trim_start().starts_with('<') {
                            continue;
                        }
                        s.clone()
                    }
                    Some(Value::Array(arr)) => {
                        let text: String = arr
                            .iter()
                            .filter(|item| {
                                item.get("type").and_then(|t| t.as_str()) == Some("text")
                            })
                            .filter_map(|item| {
                                item.get("text").and_then(|t| t.as_str())
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        if text.trim_start().starts_with('<') {
                            continue;
                        }
                        text
                    }
                    _ => continue,
                };

                if content_str.trim().is_empty() {
                    continue;
                }

                messages.push(ChatMessage {
                    role: "user".to_string(),
                    content: content_str,
                    timestamp,
                    thinking: None,
                    model: None,
                    tool_uses: Vec::new(),
                    input_tokens: 0,
                    output_tokens: 0,
                });
            }
            "assistant" => {
                let msg = val.get("message");
                let model = msg
                    .and_then(|m| m.get("model"))
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string());

                let mut content_text = String::new();
                let mut thinking_text: Option<String> = None;
                let mut tool_uses = Vec::new();

                if let Some(content_arr) = msg
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for item in content_arr {
                        match item.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(text) =
                                    item.get("text").and_then(|t| t.as_str())
                                {
                                    content_text.push_str(text);
                                }
                            }
                            Some("thinking") => {
                                if let Some(text) =
                                    item.get("thinking").and_then(|t| t.as_str())
                                {
                                    thinking_text = Some(text.to_string());
                                }
                            }
                            Some("tool_use") => {
                                let name = item
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let input = item
                                    .get("input")
                                    .map(|i| {
                                        serde_json::to_string_pretty(i)
                                            .unwrap_or_default()
                                    })
                                    .unwrap_or_default();
                                tool_uses.push(ToolUse { name, input });
                            }
                            _ => {}
                        }
                    }
                }

                if content_text.trim().is_empty()
                    && thinking_text.is_none()
                    && tool_uses.is_empty()
                {
                    continue;
                }

                let usage = msg.and_then(|m| m.get("usage"));
                let input_tokens = usage
                    .and_then(|u| u.get("input_tokens"))
                    .and_then(|t| t.as_u64())
                    .unwrap_or(0);
                let output_tokens = usage
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(|t| t.as_u64())
                    .unwrap_or(0);

                messages.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: content_text,
                    timestamp,
                    thinking: thinking_text,
                    model,
                    tool_uses,
                    input_tokens,
                    output_tokens,
                });
            }
            _ => {}
        }
    }

    messages
}

#[tauri::command]
async fn get_project_path(project_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project_dir = claude_dir().join(&project_id);
        get_cwd_from_project(&project_dir)
            .ok_or_else(|| "Project path not found".to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

// ── Embedded PTY terminal ────────────────────────────────────────────────────

struct PtyProcess {
    master_write: std::fs::File,
    child: Child,
}

struct PtyState {
    sessions: Mutex<HashMap<String, PtyProcess>>,
}

#[derive(Serialize, Clone)]
struct PtyData {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
}

#[tauri::command]
async fn spawn_pty(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    project_path: String,
    session_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Build claude command
    let mut claude_cmd = "claude".to_string();
    if let Some(ref sid) = session_id {
        claude_cmd.push_str(&format!(" -r {}", sid));
    }

    // Set PTY window size
    let win = nix::pty::Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let pty = nix::pty::openpty(Some(&win), None)
        .map_err(|e| format!("openpty: {}", e))?;

    // Dup slave fd for each stdio
    let slave_raw = pty.slave.as_raw_fd();
    let fd_in = nix::unistd::dup(slave_raw).map_err(|e| format!("dup: {}", e))?;
    let fd_out = nix::unistd::dup(slave_raw).map_err(|e| format!("dup: {}", e))?;
    let fd_err = nix::unistd::dup(slave_raw).map_err(|e| format!("dup: {}", e))?;
    drop(pty.slave);

    let child = unsafe {
        std::process::Command::new("/bin/zsh")
            .args(["--login", "-c", &claude_cmd])
            .current_dir(&project_path)
            .env_remove("CLAUDECODE")
            .env("TERM", "xterm-256color")
            .stdin(Stdio::from_raw_fd(fd_in))
            .stdout(Stdio::from_raw_fd(fd_out))
            .stderr(Stdio::from_raw_fd(fd_err))
            .spawn()
            .map_err(|e| format!("spawn: {}", e))?
    };

    let master_raw = pty.master.as_raw_fd();
    let master_read = unsafe { std::fs::File::from_raw_fd(master_raw) };
    let write_fd = nix::unistd::dup(master_raw).map_err(|e| format!("dup master: {}", e))?;
    let master_write = unsafe { std::fs::File::from_raw_fd(write_fd) };
    std::mem::forget(pty.master);

    // Store process
    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(id.clone(), PtyProcess { master_write, child });
    }

    // Reader thread: PTY master → frontend
    let app2 = app.clone();
    let pty_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut reader = master_read;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    app2.emit("pty-data", PtyData { id: pty_id.clone(), data: text }).ok();
                }
                Err(_) => break,
            }
        }
        app2.emit("pty-exit", PtyExit { id: pty_id }).ok();
    });

    Ok(())
}

#[tauri::command]
async fn write_pty(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let proc = sessions.get_mut(&id)
        .ok_or_else(|| format!("No PTY: {}", id))?;
    proc.master_write.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    proc.master_write.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn resize_pty(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let proc = sessions.get(&id)
        .ok_or_else(|| format!("No PTY: {}", id))?;
    let fd = proc.master_write.as_raw_fd();
    let win = nix::pty::Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    unsafe { libc_ioctl_winsize(fd, &win); }
    Ok(())
}

unsafe fn libc_ioctl_winsize(fd: i32, ws: &nix::pty::Winsize) {
    libc::ioctl(fd, libc::TIOCSWINSZ, ws as *const _);
}

#[tauri::command]
async fn kill_pty(
    state: tauri::State<'_, PtyState>,
    id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut proc) = sessions.remove(&id) {
        drop(proc.master_write);
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
    Ok(())
}

// ── Send message (one-shot, for inline chat) ─────────────────────────────────

#[tauri::command]
async fn send_claude_message(
    app: tauri::AppHandle,
    project_path: String,
    message: String,
    session_id: Option<String>,
) -> SendResult {
    tauri::async_runtime::spawn_blocking(move || {
        let before: HashSet<String> = list_jsonl_ids(&project_path);

        let escaped = message.replace('\'', "'\\''");
        let mut cmd_parts = vec![
            "claude".to_string(),
            "-p".to_string(),
        ];
        if let Some(ref sid) = session_id {
            cmd_parts.push("-r".to_string());
            cmd_parts.push(sid.clone());
        }
        cmd_parts.push("--output-format".to_string());
        cmd_parts.push("stream-json".to_string());
        cmd_parts.push("--verbose".to_string());
        cmd_parts.push("--include-partial-messages".to_string());
        cmd_parts.push(format!("'{}'", escaped));

        let shell_cmd = cmd_parts.join(" ");

        let mut child = match std::process::Command::new("script")
            .args(["-q", "/dev/null", "/bin/zsh", "--login", "-c", &shell_cmd])
            .current_dir(&project_path)
            .env_remove("CLAUDECODE")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                return SendResult {
                    session_id: session_id.unwrap_or_default(),
                    error: Some(format!("Failed to start claude: {}", e)),
                };
            }
        };

        let result_session_id = Arc::new(Mutex::new(String::new()));
        let stdout_thread = if let Some(stdout) = child.stdout.take() {
            let app2 = app.clone();
            let sid_clone = result_session_id.clone();
            Some(std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if trimmed.is_empty() { continue; }
                    let Ok(val) = serde_json::from_str::<Value>(trimmed) else { continue };

                    let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");

                    match msg_type {
                        "system" => {
                            // Extract slash commands from init event
                            if let Some(cmds) = val.get("slash_commands").and_then(|c| c.as_array()) {
                                let commands: Vec<String> = cmds.iter()
                                    .filter_map(|c| c.as_str().map(|s| s.to_string()))
                                    .collect();
                                app2.emit("claude-init", commands).ok();
                            }
                        }
                        "stream_event" => {
                            if let Some(event) = val.get("event") {
                                let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                match event_type {
                                    "content_block_start" => {
                                        if let Some(cb) = event.get("content_block") {
                                            if cb.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                                let name = cb.get("name")
                                                    .and_then(|n| n.as_str()).unwrap_or("tool");
                                                app2.emit("claude-stream", StreamEvent {
                                                    kind: "tool".into(),
                                                    content: String::new(),
                                                    tool_name: Some(name.to_string()),
                                                }).ok();
                                            }
                                        }
                                    }
                                    "content_block_delta" => {
                                        if let Some(delta) = event.get("delta") {
                                            match delta.get("type").and_then(|t| t.as_str()) {
                                                Some("thinking_delta") => {
                                                    let text = delta.get("thinking")
                                                        .and_then(|t| t.as_str()).unwrap_or("");
                                                    if !text.is_empty() {
                                                        app2.emit("claude-stream", StreamEvent {
                                                            kind: "thinking".into(),
                                                            content: text.to_string(),
                                                            tool_name: None,
                                                        }).ok();
                                                    }
                                                }
                                                Some("text_delta") => {
                                                    let text = delta.get("text")
                                                        .and_then(|t| t.as_str()).unwrap_or("");
                                                    if !text.is_empty() {
                                                        app2.emit("claude-stream", StreamEvent {
                                                            kind: "text".into(),
                                                            content: text.to_string(),
                                                            tool_name: None,
                                                        }).ok();
                                                    }
                                                }
                                                _ => {}
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        "result" => {
                            if let Some(sid) = val.get("session_id").and_then(|s| s.as_str()) {
                                if let Ok(mut lock) = sid_clone.lock() {
                                    *lock = sid.to_string();
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }))
        } else {
            None
        };

        let stderr_content = String::new();

        let status = match child.wait() {
            Ok(s) => s,
            Err(e) => {
                return SendResult {
                    session_id: session_id.unwrap_or_default(),
                    error: Some(format!("Process error: {}", e)),
                };
            }
        };

        if let Some(t) = stdout_thread {
            t.join().ok();
        }

        if !status.success() && !stderr_content.trim().is_empty() {
            return SendResult {
                session_id: session_id.unwrap_or_default(),
                error: Some(stderr_content.trim().to_string()),
            };
        }

        let stream_sid = result_session_id.lock().map(|s| s.clone()).unwrap_or_default();

        if let Some(sid) = session_id {
            return SendResult { session_id: sid, error: None };
        }
        if !stream_sid.is_empty() {
            return SendResult { session_id: stream_sid, error: None };
        }
        let after: HashSet<String> = list_jsonl_ids(&project_path);
        let new_id = after.difference(&before).next().cloned().unwrap_or_default();
        SendResult { session_id: new_id, error: None }
    })
    .await
    .unwrap_or_else(|e| SendResult {
        session_id: String::new(),
        error: Some(e.to_string()),
    })
}

// ── Headless Claude session ──────────────────────────────────────────────────

#[tauri::command]
async fn start_headless(
    app: tauri::AppHandle,
    state: tauri::State<'_, HeadlessState>,
    project_path: String,
    session_id: Option<String>,
) -> Result<(), String> {
    // Stop existing session if any
    {
        let mut lock = state.process.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = lock.take() {
            drop(old.stdin);
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
    }

    let mut cmd_parts = vec![
        "claude".to_string(),
        "-p".to_string(),
        "--input-format".to_string(), "stream-json".to_string(),
        "--output-format".to_string(), "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    if let Some(ref sid) = session_id {
        cmd_parts.push("-r".to_string());
        cmd_parts.push(sid.clone());
    }

    let shell_cmd = cmd_parts.join(" ");

    let mut child = std::process::Command::new("/bin/zsh")
        .args(["--login", "-c", &shell_cmd])
        .current_dir(&project_path)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start claude: {}", e))?;

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stdin = child.stdin.take().ok_or("No stdin")?;

    {
        let mut lock = state.process.lock().map_err(|e| e.to_string())?;
        *lock = Some(HeadlessProcess { stdin, child });
    }

    // Stdout reader thread
    let app2 = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            let Ok(val) = serde_json::from_str::<Value>(trimmed) else { continue };

            let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match msg_type {
                "system" => {
                    let sid = val.get("session_id")
                        .and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let cmds: Vec<String> = val.get("slash_commands")
                        .and_then(|c| c.as_array())
                        .map(|arr| arr.iter()
                            .filter_map(|c| c.as_str().map(|s| s.to_string()))
                            .collect())
                        .unwrap_or_default();
                    app2.emit("claude-init", InitEvent {
                        session_id: sid,
                        slash_commands: cmds,
                    }).ok();
                }
                "stream_event" => {
                    if let Some(event) = val.get("event") {
                        let et = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        match et {
                            "content_block_start" => {
                                if let Some(cb) = event.get("content_block") {
                                    if cb.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                        let name = cb.get("name")
                                            .and_then(|n| n.as_str()).unwrap_or("tool");
                                        app2.emit("claude-stream", StreamEvent {
                                            kind: "tool".into(),
                                            content: String::new(),
                                            tool_name: Some(name.to_string()),
                                        }).ok();
                                    }
                                }
                            }
                            "content_block_delta" => {
                                if let Some(delta) = event.get("delta") {
                                    match delta.get("type").and_then(|t| t.as_str()) {
                                        Some("thinking_delta") => {
                                            let text = delta.get("thinking")
                                                .and_then(|t| t.as_str()).unwrap_or("");
                                            if !text.is_empty() {
                                                app2.emit("claude-stream", StreamEvent {
                                                    kind: "thinking".into(),
                                                    content: text.to_string(),
                                                    tool_name: None,
                                                }).ok();
                                            }
                                        }
                                        Some("text_delta") => {
                                            let text = delta.get("text")
                                                .and_then(|t| t.as_str()).unwrap_or("");
                                            if !text.is_empty() {
                                                app2.emit("claude-stream", StreamEvent {
                                                    kind: "text".into(),
                                                    content: text.to_string(),
                                                    tool_name: None,
                                                }).ok();
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "result" => {
                    let sid = val.get("session_id")
                        .and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let cost = val.get("cost_usd")
                        .and_then(|c| c.as_f64()).unwrap_or(0.0);
                    let is_error = val.get("subtype")
                        .and_then(|s| s.as_str())
                        .map(|s| s.starts_with("error"))
                        .unwrap_or(false);
                    app2.emit("claude-result", ResultEvent {
                        session_id: sid, cost_usd: cost, is_error,
                    }).ok();
                }
                _ => {}
            }
        }
        app2.emit("claude-session-end", ()).ok();
    });

    Ok(())
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, HeadlessState>,
    message: String,
) -> Result<(), String> {
    let mut lock = state.process.lock().map_err(|e| e.to_string())?;
    let proc = lock.as_mut().ok_or("No active session")?;

    let json = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": message
        }
    });

    let line = format!("{}\n", json.to_string());
    proc.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    proc.stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn interrupt_claude(
    state: tauri::State<'_, HeadlessState>,
) -> Result<(), String> {
    let lock = state.process.lock().map_err(|e| e.to_string())?;
    if let Some(proc) = lock.as_ref() {
        let pid = proc.child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGINT); }
    }
    Ok(())
}

#[tauri::command]
async fn stop_headless(
    state: tauri::State<'_, HeadlessState>,
) -> Result<(), String> {
    let mut lock = state.process.lock().map_err(|e| e.to_string())?;
    if let Some(mut proc) = lock.take() {
        drop(proc.stdin);
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
    Ok(())
}

// ── App entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState {
            sessions: Mutex::new(HashMap::new()),
        })
        .manage(HeadlessState {
            process: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_projects,
            get_sessions,
            get_session_messages,
            get_project_path,
            send_claude_message,
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            start_headless,
            send_message,
            interrupt_claude,
            stop_headless,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
