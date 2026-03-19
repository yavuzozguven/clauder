import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Map our CSS theme to xterm colors
function getTermTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  return {
    background: v("--bg-primary") || "#1a1a1a",
    foreground: v("--text-primary") || "#e0e0e0",
    cursor: v("--accent") || "#e8a000",
    cursorAccent: v("--bg-primary") || "#1a1a1a",
    selectionBackground: v("--bg-hover") || "#2e2e2e",
  };
}

export default function TerminalPanel({ id, projectPath, sessionId, onExit }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !id) return;

    const term = new XTerm({
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.0,
      cursorBlink: true,
      theme: getTermTheme(),
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;

    // Buffer PTY output until terminal is ready
    const pendingData = [];
    let ptyReady = false;

    // PTY output → terminal (start listening immediately to not miss data)
    let unlistenData;
    listen("pty-data", (event) => {
      if (event.payload.id === id) {
        if (ptyReady) {
          term.write(event.payload.data);
        } else {
          pendingData.push(event.payload.data);
        }
      }
    }).then((fn) => { unlistenData = fn; });

    // PTY exit
    let unlistenExit;
    listen("pty-exit", (event) => {
      if (event.payload.id === id) {
        term.writeln("\r\n\x1b[2m[Process exited]\x1b[0m");
        onExit?.();
      }
    }).then((fn) => { unlistenExit = fn; });

    // Terminal input → PTY
    const inputDispose = term.onData((data) => {
      invoke("write_pty", { id, data }).catch(() => {});
    });

    // Resize handling
    const resizeDispose = term.onResize(({ cols, rows }) => {
      invoke("resize_pty", { id, cols, rows }).catch(() => {});
    });

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
    });
    ro.observe(containerRef.current);

    // Wait for layout to settle, then fit and spawn PTY with correct dimensions
    const initTimer = setTimeout(() => {
      fit.fit();
      const cols = term.cols;
      const rows = term.rows;

      invoke("spawn_pty", {
        id,
        projectPath,
        sessionId: sessionId || null,
        cols,
        rows,
      }).then(() => {
        ptyReady = true;
        // Flush any buffered output
        for (const chunk of pendingData) {
          term.write(chunk);
        }
        pendingData.length = 0;
      }).catch((err) => {
        term.writeln(`\r\n\x1b[31mError: ${err}\x1b[0m`);
      });
    }, 80);

    return () => {
      clearTimeout(initTimer);
      inputDispose.dispose();
      resizeDispose.dispose();
      unlistenData?.();
      unlistenExit?.();
      ro.disconnect();
      term.dispose();
      invoke("kill_pty", { id }).catch(() => {});
    };
  }, [id]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ width: "100%", height: "100%" }}
    />
  );
}
