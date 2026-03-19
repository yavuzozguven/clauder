import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import css from "highlight.js/lib/languages/css";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("css", css);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);

const EXT_MAP = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  css: "css", scss: "css", sass: "css",
  rs: "rust",
  json: "json", jsonc: "json",
  sh: "bash", zsh: "bash", bash: "bash",
  py: "python",
  html: "xml", htm: "xml", svg: "xml",
  md: "markdown", mdx: "markdown",
  toml: "bash", yaml: "bash", yml: "bash",
};

export function langFromPath(filePath) {
  const ext = (filePath || "").split(".").pop().toLowerCase();
  return EXT_MAP[ext] || null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function highlightLine(line, lang) {
  if (!lang) return escapeHtml(line);
  try {
    return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(line);
  }
}

export function highlightBlock(code, lang) {
  if (!lang) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
