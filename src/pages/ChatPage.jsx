import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import { highlightBlock, langFromPath } from "../utils/highlight";
import { formatTokens, tokenColor } from "../utils/time";
import "./ChatPage.css";

// Configure marked with syntax highlighting
const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const highlighted = highlightBlock(text, lang || null);
  return `<pre><code class="hljs language-${lang || "plaintext"}">${highlighted}</code></pre>`;
};
marked.use({ renderer });

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseAssistantEvent(msg) {
  const content = msg.content || [];
  let text = "";
  let thinking = "";
  const toolUses = [];

  for (const block of content) {
    if (block.type === "text") text += block.text || "";
    if (block.type === "thinking") thinking += (block.thinking || "") + "\n";
    if (block.type === "tool_use") {
      toolUses.push({
        name: block.name || "",
        input: JSON.stringify(block.input, null, 2),
      });
    }
  }

  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: text,
    thinking: thinking.trim() || null,
    toolUses,
    model: msg.model || "",
    inputTokens: msg.usage?.input_tokens || 0,
    outputTokens: msg.usage?.output_tokens || 0,
  };
}

function groupMessages(msgs) {
  const result = [];
  for (const msg of msgs) {
    if (msg.role === "user" || msg.role === "error") {
      result.push({ type: msg.role, data: msg });
    } else if (msg.role === "assistant") {
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

  for (const msg of messages) {
    if (msg.model) model = msg.model;
    totalTokens += (msg.inputTokens || 0) + (msg.outputTokens || 0);

    if (msg.thinking) {
      steps.push({ type: "thinking", content: msg.thinking });
    }
    for (const t of msg.toolUses || []) {
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

  return { accordionSteps, finalContent, modelShort, totalTokens };
}

function preview(text, len = 72) {
  if (!text) return "";
  const flat = text.replace(/\n/g, " ").trim();
  return flat.length > len ? flat.slice(0, len) + "…" : flat;
}

function estTokens(text) {
  return Math.round((text || "").length / 4);
}

// ── Tool rendering ───────────────────────────────────────────────────────────

function ToolInputView({ name, input }) {
  let parsed = null;
  try { parsed = JSON.parse(input); } catch { /* raw */ }

  const n = (name || "").toLowerCase();

  if (n === "bash" && parsed?.command) {
    const html = highlightBlock(parsed.command, "bash");
    return <pre className="step-code hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>;
  }

  if ((n === "read" || n === "glob" || n === "grep") && parsed) {
    const lines = Object.entries(parsed)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join("\n");
    return <pre className="step-code">{lines}</pre>;
  }

  if ((n === "edit" || n === "write") && parsed?.file_path) {
    const lang = langFromPath(parsed.file_path);
    const code = parsed.content || parsed.new_string || "";
    if (code) {
      const html = highlightBlock(code, lang);
      return (
        <div className="tool-diff">
          <div className="tool-diff-path">{parsed.file_path.replace(/^.*\//, "")}</div>
          <pre className="step-code hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
        </div>
      );
    }
  }

  const json = parsed ? JSON.stringify(parsed, null, 2) : input;
  const html = highlightBlock(json, "json");
  return <pre className="step-code hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

// ── Step row ─────────────────────────────────────────────────────────────────

function StepRow({ step }) {
  const [open, setOpen] = useState(false);

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

  if (step.type === "tool") {
    const summaryText = (() => {
      try {
        const input = typeof step.input === "string" ? JSON.parse(step.input) : step.input;
        const n = (step.name || "").toLowerCase();
        const short = (p) => p ? p.split("/").slice(-2).join("/") : "";
        if (n === "read") return short(input?.file_path || "");
        if (n === "write" || n === "edit") return short(input?.file_path || "");
        if (n === "bash") return (input?.command || "").slice(0, 72);
        if (n === "glob") return input?.pattern || "";
        if (n === "grep") return input?.pattern ? `"${input.pattern}"` : "";
        return "";
      } catch { return ""; }
    })();

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
          <span className={`step-chevron ${open ? "open" : ""}`}>›</span>
        </button>
        {open && (
          <div className="step-expanded">
            <div className="markdown step-markdown" dangerouslySetInnerHTML={{ __html: marked.parse(step.content) }} />
          </div>
        )}
      </div>
    );
  }

  return null;
}

// ── Assistant group ──────────────────────────────────────────────────────────

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <button className={`copy-output-btn${copied ? " copied" : ""}`} onClick={handleCopy} title="Copy output">
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3 11V3a1 1 0 0 1 1-1h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function AssistantGroup({ group }) {
  const { accordionSteps, finalContent, modelShort, totalTokens } = buildSteps(group.messages);
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
          <CopyButton text={finalContent} />
          <div className="markdown" dangerouslySetInnerHTML={{ __html: marked.parse(finalContent) }} />
        </div>
      )}
    </div>
  );
}

// ── Main ChatPage ────────────────────────────────────────────────────────────

export default function ChatPage({ initialCwd, onTitleChange }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [cwd, setCwd] = useState(initialCwd || "");
  const [cwdEditing, setCwdEditing] = useState(!initialCwd);
  const [chatId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(null);
  const chatRef = useRef(null);
  const inputRef = useRef(null);

  // Listen for stream events
  useEffect(() => {
    const unEvent = listen("chat-event", (e) => {
      const { chat_id, event } = e.payload;
      if (chat_id !== chatId) return;

      if (event.type === "assistant" && event.message) {
        const parsed = parseAssistantEvent(event.message);
        setMessages((prev) => [...prev, parsed]);
      }

      if (event.type === "result") {
        if (event.session_id) setSessionId(event.session_id);
        setSending(false);
      }
    });

    const unDone = listen("chat-done", (e) => {
      if (e.payload.chat_id !== chatId) return;
      setSending(false);
    });

    const unErr = listen("chat-error", (e) => {
      if (e.payload.chat_id !== chatId) return;
      setError(e.payload.error);
    });

    return () => {
      unEvent.then((fn) => fn());
      unDone.then((fn) => fn());
      unErr.then((fn) => fn());
    };
  }, [chatId]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages, sending]);

  // Focus input on mount
  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    setError(null);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: text },
    ]);
    setSending(true);

    // Update tab title from first message
    if (messages.length === 0) {
      onTitleChange?.(text.length > 40 ? text.slice(0, 40) + "…" : text);
    }

    try {
      await invoke("send_chat_message", {
        prompt: text,
        sessionId: sessionId || null,
        cwd: cwd || null,
        chatId,
      });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "error", content: String(err) },
      ]);
      setSending(false);
    }
  }, [input, sending, sessionId, cwd, chatId, messages.length, onTitleChange]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleCancel = async () => {
    try {
      await invoke("cancel_chat");
    } catch { /* ignore */ }
    setSending(false);
  };

  const groups = groupMessages(messages);

  return (
    <div className="chat-layout">
      {/* Top bar */}
      <div className="chat-topbar">
        <div className="chat-topbar-left">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h3a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          {cwdEditing ? (
            <input
              className="cwd-input"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setCwdEditing(false); }}
              onBlur={() => setCwdEditing(false)}
              placeholder="/path/to/project"
              autoFocus
            />
          ) : (
            <button className="cwd-display" onClick={() => setCwdEditing(true)}>
              {cwd || "Set working directory…"}
            </button>
          )}
        </div>
        {sessionId && (
          <span className="chat-session-badge" title={sessionId}>
            Session active
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="chat-messages" ref={chatRef}>
        {messages.length === 0 && !sending && (
          <div className="chat-welcome">
            <div className="chat-welcome-icon">C</div>
            <h2>Chat with Claude Code</h2>
            <p>Ask Claude to read, write, and edit files in your project.</p>
            {!cwd && <p className="chat-welcome-hint">Set a working directory above to get started.</p>}
          </div>
        )}

        {groups.map((group, i) => {
          if (group.type === "user") {
            return (
              <div key={group.data.id} className="user-turn">
                <div className="user-bubble">
                  <pre className="msg-text">{group.data.content}</pre>
                </div>
              </div>
            );
          }
          if (group.type === "error") {
            return (
              <div key={group.data.id} className="chat-error-msg">
                {group.data.content}
              </div>
            );
          }
          if (group.type === "assistant_group") {
            return <AssistantGroup key={i} group={group} />;
          }
          return null;
        })}

        {sending && (
          <div className="chat-thinking">
            <div className="chat-thinking-dots">
              <span /><span /><span />
            </div>
            <span>Claude is working…</span>
            <button className="chat-cancel-btn" onClick={handleCancel}>Cancel</button>
          </div>
        )}

        {error && (
          <div className="chat-error-bar">
            {error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        <div className="chat-input-wrap">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Claude…"
            rows={1}
            disabled={sending}
          />
          <button
            className="chat-send-btn"
            onClick={sendMessage}
            disabled={sending || !input.trim()}
            title="Send (Enter)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 8h12M9 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
