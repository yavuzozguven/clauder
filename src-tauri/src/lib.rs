use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

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

// ── App entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_projects,
            get_sessions,
            get_session_messages,
            get_project_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
