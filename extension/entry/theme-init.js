(function () {
  try {
    var root = document.documentElement;
    var raw = window.localStorage && window.localStorage.getItem("biliscript_theme_snapshot_v1");
    var mode = "bilibili";
    var palette = "flyme";
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (
          parsed.mode === "bilibili" ||
          parsed.mode === "system" ||
          parsed.mode === "light" ||
          parsed.mode === "dark"
        ) {
          mode = parsed.mode;
        }
        if (parsed.palette === "editorial") {
          palette = "editorial";
        }
      }
    }
    var prefersDark =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme =
      mode === "dark" ? "dark" : mode === "light" ? "light" : prefersDark ? "dark" : "light";
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-palette", palette);
  } catch (_) {
  }
})();
