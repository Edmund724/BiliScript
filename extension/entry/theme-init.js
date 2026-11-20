// extension/entry/theme-init.js
// 独立扩展页（onboarding.html / permission-grant.html）首屏防闪烁同步初始化脚本。
// 以普通同步 <script src="..."> 置于 <head> 中（遵守 MV3 CSP，禁止 inline script），
// 在首次绘制前同步落位 data-theme 与 data-palette，彻底消除深色模式首帧白闪。
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
    // 存储或 matchMedia 不可用时交由 CSS @media (prefers-color-scheme: dark) 兜底
  }
})();
