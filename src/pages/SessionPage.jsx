import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { langFromPath, highlightLine, highlightBlock } from "../utils/highlight";
import {
  relativeTime,
  formatTokens,
  tokenColor,
  groupSessionsByDate,
  formatTime,
} from "../utils/time";
import "./SessionPage.css";

// Configure marked to syntax-highlight code blocks
marked.use({
  renderer: (() => {
    const r = new marked.Renderer();
    r.code = ({ text, lang }) => {
      const highlighted = highlightBlock(text, lang || null);
      return `<pre><code class="hljs language-${lang || "plaintext"}">${highlighted}</code></pre>`;
    };
    return r;
  })(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const SYSTEM_PREFIXES = [
  "This session is being continued from a previous conversation",
  "<system-reminder>",
  "<context>",
];

function isSystemMessage(msg) {
  const c = (msg.content || "").trimStart();
  return SYSTEM_PREFIXES.some((p) => c.startsWith(p));
}

function groupMessages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (isSystemMessage(msg)) continue;
      result.push({ type: "user", data: msg });
    } else {
      const last = result[result.length - 1];
      if (last && last.type === "assistant_group") {
        last.messages.push(msg);
      } else {
        result.push({ type: "assistant_group", messages: [msg] });
      }
    }
  }
  return result;
}

function buildSteps(messages) {
  const steps = [];
  let model = "";
  let totalTokens = 0;
  let lastTimestamp = null;

  for (const msg of messages) {
    if (msg.model) model = msg.model;
    totalTokens += (msg.input_tokens || 0) + (msg.output_tokens || 0);
    if (msg.timestamp) lastTimestamp = msg.timestamp;

    if (msg.thinking) {
      steps.push({ type: "thinking", content: msg.thinking });
    }
    for (const t of msg.tool_uses || []) {
      steps.push({ type: "tool", name: t.name, input: t.input });
    }
    if (msg.content && msg.content.trim()) {
      steps.push({ type: "output", content: msg.content });
    }
  }

  const lastOutputIdx = [...steps].map((s) => s.type).lastIndexOf("output");
  const finalContent = lastOutputIdx >= 0 ? steps[lastOutputIdx].content : "";
  const accordionSteps =
    lastOutputIdx >= 0 ? steps.filter((_, i) => i !== lastOutputIdx) : steps;

  const modelShort = model
    ? model.replace("claude-", "").replace(/-\d{8}$/, "")
    : "";

  return { accordionSteps, finalContent, modelShort, totalTokens, lastTimestamp };
}

function estTokens(text) {
  return Math.round((text || "").length / 4);
}

function preview(text, len = 72) {
  if (!text) return "";
  const flat = text.replace(/\n/g, " ").trim();
  return flat.length > len ? flat.slice(0, len) + "…" : flat;
}

function computeLineDiff(oldStr, newStr, ctx = 2) {
  const oldL = (oldStr || "").split("\n");
  const newL = (newStr || "").split("\n");
  const m = oldL.length, n = newL.length;
  if (m * n > 50000) return null;

  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldL[i-1] === newL[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);

  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldL[i-1] === newL[j-1]) {
      ops.unshift({ t: "c", l: oldL[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      ops.unshift({ t: "+", l: newL[j-1] }); j--;
    } else {
      ops.unshift({ t: "-", l: oldL[i-1] }); i--;
    }
  }

  const shown = new Set();
  ops.forEach((op, idx) => {
    if (op.t !== "c")
      for (let k = Math.max(0, idx - ctx); k <= Math.min(ops.length - 1, idx + ctx); k++)
        shown.add(k);
  });
  if (shown.size === 0) return [];

  const sorted = [...shown].sort((a, b) => a - b);
  const result = [];
  let prev = -2;
  for (const idx of sorted) {
    if (idx > prev + 1) result.push({ t: "…" });
    result.push(ops[idx]);
    prev = idx;
  }
  return result;
}

function HlLine({ line, lang, className, sign }) {
  const html = highlightLine(line, lang);
  return (
    <div className={`diff-line ${className}`}>
      <span className="diff-sign">{sign}</span>
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function ToolInputView({ name, input }) {
  let parsed = null;
  try { parsed = JSON.parse(input); } catch { /* use raw */ }

  const n = (name || "").toLowerCase();

  if ((n === "edit" || n === "multiedit") && parsed) {
    const edits = parsed.edits ?? [parsed];
    const lang = langFromPath(parsed.file_path);
    return (
      <div className="tool-diff">
        {parsed.file_path && (
          <div className="tool-diff-path">{parsed.file_path.replace(/^.*\//, "")}</div>
        )}
        {edits.map((e, ei) => {
          const diff = computeLineDiff(e.old_string ?? "", e.new_string ?? "");
          if (diff === null) {
            return (
              <div key={ei} className="tool-diff-hunk">
                {(e.old_string ?? "").split("\n").map((l, j) => (
                  <HlLine key={`r${j}`} line={l} lang={lang} className="diff-line--removed" sign="−" />
                ))}
                {(e.new_string ?? "").split("\n").map((l, j) => (
                  <HlLine key={`a${j}`} line={l} lang={lang} className="diff-line--added" sign="+" />
                ))}
              </div>
            );
          }
          return (
            <div key={ei} className="tool-diff-hunk">
              {diff.map((op, k) => {
                if (op.t === "…") return <div key={k} className="diff-line diff-line--sep">···</div>;
                if (op.t === "-") return <HlLine key={k} line={op.l} lang={lang} className="diff-line--removed" sign="−" />;
                if (op.t === "+") return <HlLine key={k} line={op.l} lang={lang} className="diff-line--added" sign="+" />;
                return <HlLine key={k} line={op.l} lang={lang} className="diff-line--ctx" sign=" " />;
              })}
            </div>
          );
        })}
      </div>
    );
  }

  if ((n === "write" || n === "write_file") && parsed) {
    const lang = langFromPath(parsed.file_path);
    const code = parsed.content ?? parsed.new_content ?? "";
    const html = highlightBlock(code, lang);
    return (
      <div className="tool-diff">
        {parsed.file_path && (
          <div className="tool-diff-path">{parsed.file_path.replace(/^.*\//, "")}</div>
        )}
        <pre className="step-code hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
      </div>
    );
  }

  if (n === "bash" && parsed?.command) {
    const html = highlightBlock(parsed.command, "bash");
    return <pre className="step-code hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>;
  }

  if (parsed && (n === "read" || n === "read_file" || n === "glob" || n === "grep")) {
    const lines = Object.entries(parsed)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join("\n");
    return <pre className="step-code">{lines}</pre>;
  }

  const json = parsed ? JSON.stringify(parsed, null, 2) : input;
  const html = highlightBlock(json, "json");
  return <pre className="step-code hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

// ── Step row ─────────────────────────────────────────────────────────────────

function StepRow({ step }) {
  const [open, setOpen] = useState(step.type === "thinking");

  if (step.type === "thinking") {
    return (
      <div className="step-row">
        <button className="step-row-header" onClick={() => setOpen((x) => !x)}>
          <span className="step-icon">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8 5v4M8 11v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="step-type">Thinking</span>
          <span className="step-preview">- {preview(step.content)}</span>
          <span className="step-tokens">~{estTokens(step.content)} tokens</span>
          <span className={`step-chevron ${open ? "open" : ""}`}>›</span>
        </button>
        {open && (
          <div className="step-expanded">
            <pre className="step-full-text">{step.content}</pre>
          </div>
        )}
      </div>
    );
  }

  if (step.type === "output") {
    return (
      <div className="step-row">
        <button className="step-row-header" onClick={() => setOpen((x) => !x)}>
          <span className="step-icon">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="step-type">Output</span>
          <span className="step-preview">- {preview(step.content)}</span>
          <span className="step-tokens">~{estTokens(step.content)} tokens</span>
          <span className={`step-chevron ${open ? "open" : ""}`}>›</span>
        </button>
        {open && (
          <div className="step-expanded">
            <div
              className="markdown step-markdown"
              dangerouslySetInnerHTML={{ __html: marked.parse(step.content) }}
            />
          </div>
        )}
      </div>
    );
  }

  if (step.type === "tool") {
    const summaryText = toolDetail(step.name, step.input);
    return (
      <div className="step-row">
        <button className="step-row-header" onClick={() => setOpen((x) => !x)}>
          <span className="tool-badge">{step.name}</span>
          {summaryText && <span className="step-tool-summary">{summaryText}</span>}
          <span className="step-chevron-right" style={{ marginLeft: "auto" }}>›</span>
        </button>
        {open && (
          <div className="step-expanded">
            <ToolInputView name={step.name} input={step.input} />
          </div>
        )}
      </div>
    );
  }
}

// ── Assistant group ───────────────────────────────────────────────────────────

function AssistantGroup({ group }) {
  const { accordionSteps, finalContent, modelShort, totalTokens, lastTimestamp } =
    buildSteps(group.messages);
  const [stepsOpen, setStepsOpen] = useState(false);

  return (
    <div className="assistant-turn">
      <div className="ag-header">
        <div className="ag-header-left">
          <div className="claude-icon">C</div>
          <span className="model-name">Claude</span>
          {modelShort && <span className="model-version">{modelShort}</span>}
          {accordionSteps.length > 0 && (
            <button
              className={`ag-step-count ${stepsOpen ? "ag-step-count--open" : ""}`}
              onClick={() => setStepsOpen((x) => !x)}
            >
              {accordionSteps.length} step{accordionSteps.length !== 1 ? "s" : ""}
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" style={{ transform: stepsOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <div className="ag-header-right">
          {totalTokens > 0 && (
            <span className="token-info" style={{ color: tokenColor(totalTokens) }}>
              {formatTokens(totalTokens)}
            </span>
          )}
          {lastTimestamp && (
            <span className="msg-time">{formatTime(lastTimestamp)}</span>
          )}
        </div>
      </div>

      {stepsOpen && accordionSteps.length > 0 && (
        <div className="steps-list">
          {accordionSteps.map((step, i) => (
            <StepRow key={i} step={step} />
          ))}
        </div>
      )}

      {finalContent && (
        <div className="final-output">
          <div
            className="markdown"
            dangerouslySetInnerHTML={{ __html: marked.parse(finalContent) }}
          />
        </div>
      )}
    </div>
  );
}

// ── User bubble ───────────────────────────────────────────────────────────────

function UserBubble({ msg }) {
  return (
    <div className="user-turn">
      <div className="user-bubble">
        <pre className="msg-text">{msg.content}</pre>
      </div>
      {msg.timestamp && (
        <div className="user-time">{formatTime(msg.timestamp)}</div>
      )}
    </div>
  );
}

// ── Session item ──────────────────────────────────────────────────────────────

function TokenBadge({ count }) {
  if (!count) return null;
  return (
    <span className="token-badge" style={{ color: tokenColor(count) }}>
      {formatTokens(count)}
    </span>
  );
}

function SessionItem({ session, isActive, onClick }) {
  return (
    <button
      className={`session-item ${isActive ? "session-item--active" : ""}`}
      onClick={onClick}
    >
      <div className="session-item-title">
        {/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.title)
          ? "Untitled session"
          : session.title}
      </div>
      <div className="session-item-meta">
        <span className="session-meta-group">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M2 2h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-3 2v-2H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          {session.message_count}
        </span>
        <span className="session-meta-time">{relativeTime(session.timestamp)}</span>
        <TokenBadge count={session.token_count} />
      </div>
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SessionPage({ projectId, onBack, onTitleChange }) {
  const decoded = projectId;

  const [sessions, setSessions] = useState([]);
  const [messages, setMessages] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [projectInfo, setProjectInfo] = useState({ name: "", branch: "" });
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectPath, setProjectPath] = useState("");
  const chatRef = useRef(null);

  useEffect(() => {
    invoke("get_project_path", { projectId: decoded })
      .then(setProjectPath)
      .catch(() => {});

    invoke("get_sessions", { projectId: decoded })
      .then((list) => {
        setSessions(list);
        if (list.length > 0) selectSession(list[0]);
      })
      .catch((err) => {
        console.error("get_sessions error:", err);
        setLoadingMsgs(false);
      })
      .finally(() => setLoadingSessions(false));
  }, [decoded]);

  function selectSession(session) {
    setActiveSession(session);
    setLoadingMsgs(true);
    setMessages([]);

    const name = decoded.split("/").at(-1) || decoded;
    setProjectInfo({ name, branch: session.git_branch || "" });
    onTitleChange?.(session.title || name);

    invoke("get_session_messages", {
      projectId: decoded,
      sessionId: session.id,
    })
      .then(setMessages)
      .catch((err) => console.error("get_session_messages error:", err))
      .finally(() => setLoadingMsgs(false));
  }

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  const sessionGroups = groupSessionsByDate(sessions);
  const messageGroups = groupMessages(messages);

  function renderSessionGroup(label, items) {
    if (!items.length) return null;
    return (
      <div key={label}>
        <div className="session-group-label">{label}</div>
        {items.map((s) => (
          <SessionItem
            key={s.id}
            session={s}
            isActive={activeSession?.id === s.id}
            onClick={() => selectSession(s)}
          />
        ))}
      </div>
    );
  }

  const totalSessions = sessions.length;
  const countLabel = totalSessions > 40 ? "40+" : String(totalSessions);

  return (
    <div className={`session-layout${sidebarOpen ? "" : " session-layout--collapsed"}`}>
      {/* Sidebar */}
      <div className="session-sidebar">
        <div className="session-sidebar-titlebar">
          <button className="back-btn" onClick={onBack}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="project-title-block">
            <div className="project-title-name">
              {projectPath ? projectPath.split("/").at(-1) : projectInfo.name}
            </div>
            {projectInfo.branch && projectInfo.branch !== "HEAD" && (
              <div className="project-title-branch">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                  <circle cx="5" cy="3" r="2" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="5" cy="13" r="2" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="11" cy="6" r="2" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M5 5v6M5 5c0 2 6 1 6 1" stroke="currentColor" strokeWidth="1.3" />
                </svg>
                {projectInfo.branch}
              </div>
            )}
          </div>
        </div>

        <div className="sessions-header">
          <span className="sessions-label">SESSIONS ({countLabel})</span>
          <div className="sessions-actions">
            <button className="icon-btn" title="Refresh" onClick={() => {
              invoke("get_sessions", { projectId: decoded }).then(setSessions).catch(console.error);
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M13 8A5 5 0 1 1 8 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <path d="M13 3v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button className="icon-btn" title="Sort">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M2 5h12M4 8h8M6 11h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="session-list">
          {loadingSessions ? (
            <div className="session-skeletons">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="session-skeleton">
                  <div className="sk-title" style={{ width: `${55 + (i * 17) % 35}%` }} />
                  <div className="sk-meta">
                    <div className="sk-chip" style={{ width: "28px" }} />
                    <div className="sk-chip" style={{ width: `${40 + (i * 11) % 30}px` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {renderSessionGroup("TODAY", sessionGroups.today)}
              {renderSessionGroup("PREVIOUS 7 DAYS", sessionGroups.week)}
              {renderSessionGroup("OLDER", sessionGroups.older)}
              {sessions.length === 0 && (
                <div className="no-sessions">No sessions found</div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Main chat */}
      <div className="session-main">
        <div className="chat-titlebar">
          <button
            className="icon-btn sidebar-toggle-btn"
            title="Toggle sidebar"
            onClick={() => setSidebarOpen(x => !x)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 2v12" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
          {activeSession && (
            <>
              <div className="chat-tab">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M2 2h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-3 2v-2H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.3" />
                </svg>
                <span className="chat-tab-title">{activeSession.title}</span>
              </div>
              <div className="chat-titlebar-right">
                <button className="icon-btn" title="Refresh" onClick={() => activeSession && selectSession(activeSession)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M13 8A5 5 0 1 1 8 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    <path d="M13 3v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>

        <div className="chat-messages" ref={chatRef}>
          {loadingMsgs && <div className="chat-loading">Loading messages…</div>}
          {!loadingMsgs && messages.length === 0 && activeSession && (
            <div className="chat-empty">No messages in this session</div>
          )}
          {!loadingMsgs && !activeSession && (
            <div className="chat-empty">
              <p>Select a session or start a new one.</p>
            </div>
          )}
          {messageGroups.map((group, i) =>
            group.type === "user" ? (
              <UserBubble key={i} msg={group.data} />
            ) : (
              <AssistantGroup key={i} group={group} />
            )
          )}
        </div>
      </div>
    </div>
  );
}
