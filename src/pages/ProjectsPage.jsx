import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relativeTime } from "../utils/time";
import "./ProjectsPage.css";

function ProjectCard({ project, onClick }) {
  const shortPath = project.path.replace(/^\/Users\/[^/]+/, "~");
  const display = shortPath.length > 35 ? shortPath.slice(0, 34) + "…" : shortPath;

  return (
    <button className="project-card" onClick={onClick}>
      <div className="project-card-icon">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="3" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1 6h14" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 3V1.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V3" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
      <div className="project-card-name">{project.name}</div>
      <div className="project-card-path">{display}</div>
      <div className="project-card-meta">
        <span>{project.session_count} sessions</span>
        <span className="dot">·</span>
        <span>{relativeTime(project.last_activity_ts)}</span>
      </div>
    </button>
  );
}

export default function ProjectsPage({ onSelectProject }) {
  const [projects, setProjects] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke("get_projects")
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        document.getElementById("search-input")?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const filtered = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.path.toLowerCase().includes(search.toLowerCase())
  );


  return (
    <div className="projects-layout">
      <div className="projects-sidebar">
        <p className="sidebar-hint">Select a project to view sessions</p>
      </div>

      <div className="projects-main">
        <div className="projects-content">
          <div className="search-wrap">
            <div className="search-bar">
              <svg className="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <input
                id="search-input"
                className="search-input"
                placeholder="Search projects..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoComplete="off"
              />
              <span className="search-kbd">
                <kbd>⌘</kbd><kbd>K</kbd>
              </span>
            </div>
          </div>

          {loading ? (
            <div className="loading">Loading projects…</div>
          ) : (
            <>
              <div className="section-header">
                <span className="section-title">RECENT PROJECTS</span>
                <button className="change-folder-btn">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  Change default folder
                </button>
              </div>

              <div className="projects-grid">
                {filtered.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    onClick={() => onSelectProject(p)}
                  />
                ))}
              </div>

              {filtered.length === 0 && (
                <div className="empty">No projects found</div>
              )}

              <div className="select-folder-btn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                <span>Select Folder</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
