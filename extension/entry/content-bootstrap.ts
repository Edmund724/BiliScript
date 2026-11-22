import { BILISCRIPT_VERSION } from "../core/version.js";

export const CONTENT_MAIN_MODULE_PATH = "entry/content-main.mjs";

export const PRELOAD_MODULE_PATHS = [
  "entry/chunks/script-button.mjs",
  "entry/chunks/player-ai.mjs"
];

interface BootstrapOptions {
  getExtensionUrl?: (modulePath: string) => string;
  importModule?: (url: string) => Promise<unknown>;
}

interface BootstrapResult {
  loadContentMain(): Promise<unknown>;
}

export function startContentBootstrap(options: BootstrapOptions = {}): BootstrapResult | null {
  if (globalThis.__BILISCRIPT_CONTENT_BOOTSTRAP_STARTED__) {
    return null;
  }
  globalThis.__BILISCRIPT_CONTENT_BOOTSTRAP_STARTED__ = true;

  globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__ = BILISCRIPT_VERSION;

  const resolveModuleUrl =
    options.getExtensionUrl ?? ((modulePath) => chrome.runtime.getURL(modulePath));
  const importMainModule = options.importModule ?? ((url) => import(url));

  function preloadButtonChunks(): void {
    for (const modulePath of PRELOAD_MODULE_PATHS) {
      const url = resolveModuleUrl(modulePath);
      if (document.querySelector(`link[rel="modulepreload"][href="${url}"]`)) {
        continue;
      }
      const link = document.createElement("link");
      link.rel = "modulepreload";
      link.href = url;
      link.onerror = () => {
        link.remove();
        console.error(
          `[BILISCRIPT] 首按钮 chunk 预取失败：${modulePath} ` +
            `(extension v${BILISCRIPT_VERSION})。主包加载不受影响，下次加载触发时将重试。`
        );
      };
      document.head.appendChild(link);
    }
  }

  let mainPromise: Promise<unknown> | null = null;

  function loadContentMain(): Promise<unknown> {
    if (!mainPromise) {
      preloadButtonChunks();
      mainPromise = (async () => {
        try {
          return await importMainModule(resolveModuleUrl(CONTENT_MAIN_MODULE_PATH));
        } catch (error) {
          mainPromise = null;
          console.error(
            `[BILISCRIPT] 内容脚本主包加载失败：${CONTENT_MAIN_MODULE_PATH} ` +
              `(extension v${BILISCRIPT_VERSION})。请确认扩展包内存在该文件，且 ` +
              `manifest.json 的 web_accessible_resources 覆盖 ` +
              `"entry/content-main.mjs" 与 "entry/chunks/*"。`,
            error
          );
          throw error;
        }
      })();
    }
    return mainPromise;
  }

  return { loadContentMain };
}
