import { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import ProjectsPage from "./pages/ProjectsPage";
import SessionPage from "./pages/SessionPage";
import "./index.css";
import "./App.css";

let _uid = 0;
const uid = () => `t${++_uid}`;
const homeTab = () => ({ id: uid(), view: "home", projectId: null, title: "New Tab" });

const THEMES = [
  { id: "dark",     label: "Dark",     color: "#1a1a1a", accent: "#e8a000" },
  { id: "light",    label: "Light",    color: "#f0f0f0", accent: "#c07800" },
  { id: "midnight", label: "Midnight", color: "#0d1117", accent: "#58a6ff" },
  { id: "mocha",    label: "Mocha",    color: "#1e1e2e", accent: "#cba6f7" },
];

function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => localStorage.getItem("theme") || "dark");
  const ref = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", active);
    localStorage.setItem("theme", active);
  }, [active]);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  return (
    <div className="theme-picker" ref={ref}>
      <button className="tabbar-new" title="Theme" onClick={() => setOpen(x => !x)}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 2a6 6 0 0 1 0 12" fill="currentColor" opacity=".35" />
        </svg>
      </button>
      {open && (
        <div className="theme-popover">
          {THEMES.map(t => (
            <button
              key={t.id}
              className={`theme-option${active === t.id ? " theme-option--active" : ""}`}
              onClick={() => { setActive(t.id); setOpen(false); }}
            >
              <span className="theme-swatch" style={{ background: t.color, borderColor: t.accent }} />
              <span className="theme-label">{t.label}</span>
              {active === t.id && (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [tabs, setTabs] = useState(() => {
    const t = homeTab();
    return [t];
  });
  const [activeId, setActiveId] = useState(tabs[0].id);
  const dragState = useRef(null); // { id, startX, currentX, tabEls }
  const [draggingId, setDraggingId] = useState(null);
  const [dragOffsets, setDragOffsets] = useState({}); // id -> translateX
  const [tabbarVisible, setTabbarVisible] = useState(true);

  const onTabPointerDown = useCallback((e, tabId) => {
    if (e.button !== 0) return;
    e.preventDefault(); // prevent Tauri window drag
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = { id: tabId, startX: e.clientX };
    setDraggingId(tabId);
    setDragOffsets({});
  }, []);

  const onTabPointerMove = useCallback((e, tabId) => {
    const ds = dragState.current;
    if (!ds || ds.id !== tabId) return;

    const dx = e.clientX - ds.startX;
    const container = e.currentTarget.parentElement;
    if (!container) return;
    const tabWidth = e.currentTarget.offsetWidth || 160;
    const shift = Math.round(dx / tabWidth);

    if (shift === 0) {
      setDragOffsets({ [tabId]: dx });
      return;
    }

    // Reorder and reset anchor
    setTabs(prev => {
      const from = prev.findIndex(t => t.id === tabId);
      if (from === -1) return prev;
      const to = Math.max(0, Math.min(prev.length - 1, from + shift));
      if (to === from) return prev;
      const arr = [...prev];
      arr.splice(to, 0, arr.splice(from, 1)[0]);
      return arr;
    });
    dragState.current = { ...ds, startX: e.clientX };
    setDragOffsets({});
  }, []);

  const onTabPointerUp = useCallback(() => {
    dragState.current = null;
    setDraggingId(null);
    setDragOffsets({});
  }, []);

  const update = useCallback((id, patch) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }, []);

  const newTab = useCallback((patch = {}) => {
    const tab = { ...homeTab(), ...patch };
    setTabs(prev => [...prev, tab]);
    setActiveId(tab.id);
  }, []);

  const closeTab = useCallback((id) => {
    setTabs(prev => {
      if (prev.length === 1) {
        const t = homeTab();
        setActiveId(t.id);
        return [t];
      }
      const idx = prev.findIndex(t => t.id === id);
      const next = prev.filter(t => t.id !== id);
      setActiveId(cur => cur === id ? next[Math.max(0, idx - 1)].id : cur);
      return next;
    });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (!e.metaKey) return;
      if (e.key === "t") { e.preventDefault(); newTab(); return; }
      if (e.key === "w") { e.preventDefault(); closeTab(activeId); return; }
      if (e.key === "b") { e.preventDefault(); setTabbarVisible(v => !v); return; }
      const n = parseInt(e.key);
      if (n >= 1 && n <= 9) {
        e.preventDefault();
        setTabs(prev => { const tab = prev[n - 1]; if (tab) setActiveId(tab.id); return prev; });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeId, newTab, closeTab]);

  // Persist & restore window size
  useEffect(() => {
    const win = getCurrentWindow();

    // Restore saved size
    const saved = localStorage.getItem("windowSize");
    if (saved) {
      try {
        const { width, height } = JSON.parse(saved);
        if (width > 0 && height > 0) win.setSize(new LogicalSize(width, height));
      } catch { /* ignore */ }
    }

    // Save on resize (debounced)
    let timer;
    const unlisten = win.onResized(async () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const size = await win.innerSize();
        const factor = await win.scaleFactor();
        localStorage.setItem("windowSize", JSON.stringify({
          width: Math.round(size.width / factor),
          height: Math.round(size.height / factor),
        }));
      }, 300);
    });

    return () => {
      clearTimeout(timer);
      unlisten.then(fn => fn());
    };
  }, []);

  return (
    <div className="app-root">
      {/* Global tab bar */}
      <div className={`tabbar${tabbarVisible ? "" : " tabbar--hidden"}`}>
        <div className="tabbar-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`tabbar-tab${tab.id === activeId ? " tabbar-tab--active" : ""}${draggingId === tab.id ? " tabbar-tab--dragging" : ""}`}
              style={dragOffsets[tab.id] ? { transform: `translateX(${dragOffsets[tab.id]}px)`, transition: "none" } : undefined}
              onClick={() => setActiveId(tab.id)}
              onPointerDown={e => onTabPointerDown(e, tab.id)}
              onPointerMove={e => onTabPointerMove(e, tab.id)}
              onPointerUp={onTabPointerUp}
              onPointerCancel={onTabPointerUp}
            >
              <span className="tabbar-tab-body">
                <span className="tabbar-tab-title">{tab.title}</span>
                {tab.projectName && tab.title !== tab.projectName && (
                  <span className="tabbar-tab-project">{tab.projectName}</span>
                )}
              </span>
              <span
                className="tabbar-tab-close"
                onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
              >
                <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </span>
            </button>
          ))}
        </div>
        <button className="tabbar-new" onClick={() => newTab()} title="New Tab (⌘T)">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <ThemePicker />
        <button className="tabbar-toggle" onClick={() => setTabbarVisible(false)} title="Hide tabs (⌘B)">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {!tabbarVisible && (
        <button className="tabbar-show-strip" onClick={() => setTabbarVisible(true)} title="Show tabs (⌘B)">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {/* Tab panels — all mounted, only active visible */}
      <div className="app-content">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`app-panel${tab.id === activeId ? " app-panel--active" : ""}`}
          >
            {tab.view === "home" ? (
              <ProjectsPage
                onSelectProject={p => {
                  const existing = tabs.find(t => t.id !== tab.id && t.view === "session" && t.projectId === p.id);
                  if (existing) {
                    setActiveId(existing.id);
                    closeTab(tab.id);
                  } else {
                    update(tab.id, { view: "session", projectId: p.id, title: p.name, projectName: p.name });
                  }
                }}
              />
            ) : (
              <SessionPage
                projectId={tab.projectId}
                onBack={() => update(tab.id, { view: "home", title: "New Tab" })}
                onTitleChange={title => update(tab.id, { title })}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
