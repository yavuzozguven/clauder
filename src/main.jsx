import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "highlight.js/styles/atom-one-dark.css";

// Apply saved theme before first render
const savedTheme = localStorage.getItem("theme") || "dark";
document.documentElement.setAttribute("data-theme", savedTheme);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
