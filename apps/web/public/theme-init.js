// Applies the saved theme before the first paint, so a dark choice never flashes light. A file, not an inline script:
// the site's CSP allows scripts from 'self' only. Same key and values as src/lib/theme.ts.
(function () {
  var preference = null;
  try {
    preference = localStorage.getItem("theme");
  } catch (e) {
    // Storage blocked: follow the system.
  }
  var dark =
    preference === "dark" ||
    (preference !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-bs-theme", dark ? "dark" : "light");
})();
