export function relativeTime(ts) {
  if (!ts) return "";
  const date = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `about ${Math.floor(diff / 3600)} hours ago`;
  if (diff < 86400 * 2) return "yesterday";
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} days ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))} weeks ago`;
  return `${Math.floor(diff / 86400 / 30)} months ago`;
}

export function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function tokenColor(n) {
  if (n >= 100000) return "var(--accent-red)";
  if (n >= 50000) return "var(--accent)";
  return "var(--text-secondary)";
}

export function groupSessionsByDate(sessions) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const groups = { today: [], week: [], older: [] };

  for (const s of sessions) {
    const d = s.timestamp ? new Date(s.timestamp) : new Date(0);
    if (d >= todayStart) groups.today.push(s);
    else if (d >= weekStart) groups.week.push(s);
    else groups.older.push(s);
  }

  return groups;
}

export function formatTime(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}
