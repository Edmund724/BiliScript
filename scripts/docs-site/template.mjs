export const REPO_URL = "https://github.com/Edmund724/BiliScript";
export const REPO_BLOB_BASE = `${REPO_URL}/blob/main/`;
export const EDGE_STORE_URL =
  "https://microsoftedge.microsoft.com/addons/detail/nhjeecahklhcjknimgapihnjbeiolpmn";
export const RELEASES_URL = `${REPO_URL}/releases`;
export const DEMO_VIDEO_URL = "https://www.bilibili.com/video/BV1zwWh61E8D";

export const HOME_REFERENCED_ASSETS = [
  "docs/images/biliscript-logo.svg",
  "docs/images/demo-overview.png",
  "docs/images/demo-subtitle.png",
  "docs/images/demo-ai-chat.png",
  "docs/images/demo-quote-share.png",
  "docs/images/demo-model-thinking.png"
];

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(text) {
  return escapeHtml(text);
}

const ICONS = {
  sun: `<svg class="theme-icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`,
  moon: `<svg class="theme-icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  menu: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  close: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  github: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>`,
  copy: `<svg class="icon-copy" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  check: `<svg class="icon-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`,
  play: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>`,
  arrowRight: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  info: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`,
  shield: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
};

export function renderCopyControl(targetId, label) {
  return `<span class="copy-wrap"><button type="button" class="copy-btn" command="--copy" commandfor="${escapeAttr(targetId)}" aria-label="${escapeAttr(label)}">${ICONS.copy}${ICONS.check}</button><span class="copy-tip" role="status"></span></span>`;
}

export function renderCalloutIcon() {
  return ICONS.info;
}

function renderPaletteSwitch() {
  return `<div class="palette-switch" role="group" aria-label="界面色板">
    <button type="button" class="palette-btn" data-palette-option="flyme" aria-pressed="true">蓝雾</button>
    <button type="button" class="palette-btn" data-palette-option="editorial" aria-pressed="false">刊物</button>
  </div>`;
}

function renderTopHeader({ pages, currentOut, version, siteUrl, basePath }) {
  const logoUrl = `${basePath}docs/images/biliscript-logo.svg`;
  const homeUrl = siteUrl("index.html");
  const navLinks = pages
    .map((p) => {
      const currentAttr = p.out === currentOut ? ' aria-current="page"' : "";
      return `<a href="${escapeAttr(siteUrl(p.out))}"${currentAttr}>${escapeHtml(p.topLabel)}</a>`;
    })
    .join("");

  return `<header class="site-header">
    <div class="site-header-inner">
      <a class="brand" href="${escapeAttr(homeUrl)}">
        <img src="${escapeAttr(logoUrl)}" width="28" height="28" alt="" />
        <span class="brand-name">BiliScript</span>
        <span class="brand-version">v${escapeHtml(version)}</span>
      </a>

      <nav class="top-nav" aria-label="站点导航">${navLinks}</nav>

      <div class="header-controls">
        ${renderPaletteSwitch()}
        <button type="button" class="icon-btn" data-theme-toggle aria-label="切换明暗模式" title="切换明暗模式">
          ${ICONS.sun}${ICONS.moon}
        </button>
        <a class="icon-btn" href="${escapeAttr(REPO_URL)}" target="_blank" rel="noopener noreferrer" aria-label="GitHub 仓库" title="GitHub 仓库">
          ${ICONS.github}
        </a>
        <button type="button" class="icon-btn nav-menu-btn" data-drawer-open aria-label="打开导航菜单" aria-expanded="false" aria-controls="mobile-drawer">
          ${ICONS.menu}
        </button>
      </div>
    </div>
  </header>`;
}

function renderMobileDrawer({ pages, currentOut, siteUrl }) {
  const navLinks = pages
    .map((p) => {
      const currentAttr = p.out === currentOut ? ' aria-current="page"' : "";
      return `<a href="${escapeAttr(siteUrl(p.out))}"${currentAttr}>${escapeHtml(p.navTitle)}</a>`;
    })
    .join("");

  return `<dialog id="mobile-drawer" class="mobile-drawer" aria-label="导航菜单">
    <div class="drawer-head">
      <span class="drawer-title">BiliScript 文档</span>
      <button type="button" class="icon-btn" data-drawer-close aria-label="关闭菜单" autofocus>${ICONS.close}</button>
    </div>
    <nav class="drawer-nav" aria-label="移动端导航">${navLinks}</nav>
    <div>
      <div class="drawer-section-label">主题色板</div>
      ${renderPaletteSwitch()}
    </div>
    <div class="drawer-links">
      <a href="${escapeAttr(EDGE_STORE_URL)}" target="_blank" rel="noopener noreferrer">Edge 应用市场</a>
      <a href="${escapeAttr(RELEASES_URL)}" target="_blank" rel="noopener noreferrer">GitHub Releases</a>
      <a href="${escapeAttr(REPO_URL)}" target="_blank" rel="noopener noreferrer">GitHub 源码</a>
    </div>
  </dialog>`;
}

function renderFooter({ page, siteUrl }) {
  const sourceLink = page.out === "index.html"
    ? `<a href="${escapeAttr(REPO_URL)}" target="_blank" rel="noopener noreferrer">GitHub 仓库</a>`
    : `<a href="${escapeAttr(`${REPO_BLOB_BASE}${page.src}`)}" target="_blank" rel="noopener noreferrer">查看本页源码</a>`;

  return `<footer class="site-footer">
    <div class="site-footer-inner">
      <span>BiliScript · 开源浏览器扩展 · MIT License</span>
      <div class="site-footer-links">
        <a href="${escapeAttr(siteUrl("docs/guide.html"))}">配置与排障</a>
        <a href="${escapeAttr(siteUrl("docs/agent-bridge.html"))}">Agent 桥接</a>
        <a href="${escapeAttr(siteUrl("privacy.html"))}">隐私政策</a>
        ${sourceLink}
      </div>
    </div>
  </footer>`;
}

export function renderLandingBody({ siteUrl, basePath }) {
  const img = (name) => `${basePath}docs/images/${name}`;
  const unixCmd = "curl -fsSL https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.sh | sh";
  const winCmd = "irm https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.ps1 | iex";
  const agentPrompt = "请把这个项目下载或克隆到我选择的长期保留文件夹，告诉我准确的完整路径，并让 Chrome「加载已解压的扩展程序」使用同一个文件夹。如果我在第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 ~/Documents/biliscript，或 Windows 上的 %USERPROFILE%\\Documents\\biliscript，但不要假设我一定使用这些路径。请用简单易懂的语言一步一步指导我完成安装和配置。https://github.com/Edmund724/BiliScript";

  const showcaseItems = [
    {
      id: "overview",
      label: "概览",
      src: img("demo-overview.png"),
      alt: "BiliScript 概览标签页：AI 生成的章节分段与重点金句",
      caption: "AI 自动拆解视频章节与重点金句，点击时间戳即刻跳播"
    },
    {
      id: "subtitle",
      label: "字幕",
      src: img("demo-subtitle.png"),
      alt: "BiliScript 字幕标签页：逐句时间轴、搜索与译文",
      caption: "逐句时间轴跳播、关键词检索与多格式字幕导出"
    },
    {
      id: "chat",
      label: "对话",
      src: img("demo-ai-chat.png"),
      alt: "BiliScript AI 对话标签页：围绕当前视频内容多轮问答",
      caption: "支持混合召回、划词解释、关键帧采样与免 Key 联网搜索"
    },
    {
      id: "thinking",
      label: "思考",
      src: img("demo-model-thinking.png"),
      alt: "BiliScript 模型与思考强度调节弹层",
      caption: "随时切换模型并调节思考强度，按任务控制响应深度"
    },
    {
      id: "quote",
      label: "金句",
      src: img("demo-quote-share.png"),
      alt: "BiliScript 金句分享卡片生成弹窗",
      caption: "多套渐变与纹理卡片，一键复制图片或导出高清 PNG"
    }
  ];

  const tabsHtml = showcaseItems
    .map((item, idx) => {
      const selected = idx === 0 ? "true" : "false";
      return `<button type="button" class="showcase-tab" role="tab" aria-selected="${selected}" data-showcase-tab data-src="${escapeAttr(item.src)}" data-alt="${escapeAttr(item.alt)}" data-caption="${escapeAttr(item.caption)}">${escapeHtml(item.label)}</button>`;
    })
    .join("");

  const first = showcaseItems[0];

  return `<main id="main-content" class="landing-main">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <span class="hero-kicker">B 站视频文摘与多模态伴读扩展</span>
        <h1 id="hero-title" class="hero-title">把长视频变成可精读、可追问的知识手稿</h1>
        <p class="hero-lead">在任意 B 站视频页右侧展开文摘面板：字幕精读与免 Key 翻译、AI 章节概览、金句分享卡、多模态问答、实时音画伴看与本地编程 Agent 桥接。</p>
        <div class="hero-actions">
          <a class="btn-primary" href="${escapeAttr(EDGE_STORE_URL)}" target="_blank" rel="noopener noreferrer">Edge 商店安装</a>
          <a class="btn-secondary" href="${escapeAttr(RELEASES_URL)}" target="_blank" rel="noopener noreferrer">下载 Chromium 离线包</a>
          <a class="btn-ghost" href="${escapeAttr(DEMO_VIDEO_URL)}" target="_blank" rel="noopener noreferrer">${ICONS.play}<span>观看演示</span></a>
        </div>
        <div class="hero-notes">
          <span class="hero-note-item">${ICONS.shield}<span>无后端服务器 · 密钥与历史仅存本机</span></span>
          <span class="hero-note-item">Chrome / Edge 120+ · 开箱即用免 Key 字幕翻译</span>
        </div>
      </div>

      <div class="hero-showcase">
        <div class="showcase-tabs" role="tablist" aria-label="扩展面板视图预览">${tabsHtml}</div>
        <div class="showcase-frame">
          <button type="button" id="hero-showcase-zoom" class="showcase-shot-btn" data-lightbox-src="${escapeAttr(first.src)}" data-lightbox-alt="${escapeAttr(first.alt)}" data-lightbox-caption="${escapeAttr(first.caption)}" aria-label="放大查看扩展面板截图">
            <img id="hero-showcase-img" class="showcase-shot" src="${escapeAttr(first.src)}" alt="${escapeAttr(first.alt)}" width="1076" height="2196" />
          </button>
        </div>
        <p id="hero-showcase-caption" class="showcase-caption">${escapeHtml(first.caption)}</p>
      </div>
    </section>

    <section aria-labelledby="features-heading">
      <div class="section-header">
        <h2 id="features-heading" class="section-title">围绕视频理解的完整工作流</h2>
        <p class="section-desc">从字幕获取、结构化精读到多模态追问和编码 Agent 联动，所有能力都原生融入 B 站播放页。</p>
      </div>

      <div class="features-grid">
        <article class="bs-card feature-card">
          <div class="feature-copy">
            <span class="feature-pill">免 Key 开箱即用</span>
            <h3 class="feature-title">字幕精读与双语翻译</h3>
            <p class="feature-text">逐句时间戳跳播、关键词搜索与多格式导出（Markdown / SRT / WebVTT / TXT）。内置免 Key <code>Index-Translate</code>，支持播放器双语叠层与无字幕 ASR 语音转写。</p>
            <a class="feature-link" href="${escapeAttr(siteUrl("docs/guide.html"))}#语音识别无字幕视频转写">查看翻译与 ASR 配置 ${ICONS.arrowRight}</a>
          </div>
          <button type="button" class="feature-thumb-btn" data-lightbox-src="${escapeAttr(img("demo-subtitle.png"))}" data-lightbox-alt="BiliScript 字幕精读与检索" data-lightbox-caption="逐句时间轴、搜索过滤与双语切换" aria-label="查看大图：字幕精读与检索">
            <img class="feature-thumb" src="${escapeAttr(img("demo-subtitle.png"))}" alt="BiliScript 字幕标签页" loading="lazy" />
          </button>
        </article>

        <article class="bs-card feature-card">
          <div class="feature-copy">
            <span class="feature-pill">结构化梳理</span>
            <h3 class="feature-title">章节概览与金句卡片</h3>
            <p class="feature-text">自动提取视频时间轴或生成 AI 章节摘要（长视频状态卡接力与章节索引固化）；精选金句一键复制或生成多种纹样渐变分享 PNG。</p>
            <a class="feature-link" href="${escapeAttr(siteUrl("docs/guide.html"))}#ai-模型平台总结对话与可选翻译">了解模型平台选择 ${ICONS.arrowRight}</a>
          </div>
          <button type="button" class="feature-thumb-btn" style="--thumb-pos: center 44%" data-lightbox-src="${escapeAttr(img("demo-quote-share.png"))}" data-lightbox-alt="BiliScript 金句分享卡片弹窗" data-lightbox-caption="多种渐变配色与纹样一键导出高清金句卡片" aria-label="查看大图：金句分享卡片">
            <img class="feature-thumb" src="${escapeAttr(img("demo-quote-share.png"))}" alt="BiliScript 金句分享卡片弹窗" loading="lazy" />
          </button>
        </article>

        <article class="bs-card feature-card">
          <div class="feature-copy">
            <span class="feature-pill">多模态深度追问</span>
            <h3 class="feature-title">长视频问答与思考调节</h3>
            <p class="feature-text">章节路由 + BM25 混合召回、多视频页并发总结、划词解释、粘贴图片与关键帧采样；支持调节思考强度，并内置免 Key 联网搜索与语音朗读。</p>
            <a class="feature-link" href="${escapeAttr(siteUrl("docs/guide.html"))}#联网搜索免-key-开箱即用">了解联网搜索策略 ${ICONS.arrowRight}</a>
          </div>
          <button type="button" class="feature-thumb-btn" style="--thumb-pos: bottom center" data-lightbox-src="${escapeAttr(img("demo-model-thinking.png"))}" data-lightbox-alt="BiliScript 模型与思考强度选择弹层" data-lightbox-caption="随时切换模型并调节思考深度" aria-label="查看大图：模型与思考强度调节">
            <img class="feature-thumb" src="${escapeAttr(img("demo-model-thinking.png"))}" alt="BiliScript 模型与思考强度选择弹层" loading="lazy" />
          </button>
        </article>

        <article class="bs-card feature-card">
          <div class="feature-copy">
            <span class="feature-pill">语音与交互扩展</span>
            <h3 class="feature-title">实时音画伴看 &amp; Agent 桥接</h3>
            <p class="feature-text">接入 MOSS Live 与 Gemini Live 语音互动，支持语音控播与直播间伴看；也可通过本机 WebSocket 桥接，让 Claude Code、Cursor、Codex 直接读取视频字幕、热评与关键帧。</p>
            <a class="feature-link" href="${escapeAttr(siteUrl("docs/agent-bridge.html"))}">配置本地 Agent 桥接 ${ICONS.arrowRight}</a>
          </div>
          <button type="button" class="feature-thumb-btn" style="--thumb-pos: bottom center" data-lightbox-src="${escapeAttr(img("demo-ai-chat.png"))}" data-lightbox-alt="BiliScript 多轮 AI 对话" data-lightbox-caption="连贯问答与本地能力联动" aria-label="查看大图：AI 对话界面">
            <img class="feature-thumb" src="${escapeAttr(img("demo-ai-chat.png"))}" alt="BiliScript AI 对话标签页" loading="lazy" />
          </button>
        </article>
      </div>
    </section>

    <section aria-labelledby="quickstart-heading">
      <div class="section-header">
        <h2 id="quickstart-heading" class="section-title">三步上手</h2>
        <p class="section-desc">所有请求由浏览器直连目标服务商，无需中转服务器，详细排障见 <a href="${escapeAttr(siteUrl("docs/guide.html"))}">配置与排障指南</a>。</p>
      </div>

      <div class="steps-grid">
        <div class="bs-card step-card">
          <span class="step-num">1 · 安装扩展</span>
          <h3 class="step-title">商店安装或加载离线包</h3>
          <p class="step-body">Edge 用户建议从 <a href="${escapeAttr(EDGE_STORE_URL)}" target="_blank" rel="noopener noreferrer">Edge 加载项商店</a> 安装；Chrome 用户从 <a href="${escapeAttr(RELEASES_URL)}" target="_blank" rel="noopener noreferrer">Releases</a> 下载 <code>Chromium.zip</code> 解压到长期目录后，在 <code>chrome://extensions/</code> 加载已解压扩展。</p>
          <details class="agent-prompt-details">
            <summary>让编程 Agent 引导安装</summary>
            <p id="agent-install-prompt">${escapeHtml(agentPrompt)}</p>
            <div style="margin-top:8px;display:flex;align-items:center;gap:8px">
              ${renderCopyControl("agent-install-prompt", "复制引导提示词")}
              <span style="font-size:12px;color:var(--bs-faint)">请勿把 API Key 发给 Agent</span>
            </div>
          </details>
        </div>

        <div class="bs-card step-card">
          <span class="step-num">2 · 模型与转写</span>
          <h3 class="step-title">开箱可用，按需添 Key</h3>
          <p class="step-body">内置 <strong>Index-Translate</strong> 字幕翻译与 <strong>免 Key 联网搜索</strong> 无需配置。如需 AI 章节总结、多轮问答或无字幕转写，打开右侧文摘面板设置页填入 <a href="https://modelscope.cn/" target="_blank" rel="noopener noreferrer">ModelScope</a> / <a href="https://siliconflow.cn/" target="_blank" rel="noopener noreferrer">硅基流动</a> 或自有 OpenAI / Anthropic / Gemini 平台密钥。</p>
        </div>

        <div class="bs-card step-card">
          <span class="step-num">3 · Agent 桥接（可选）</span>
          <h3 class="step-title">一键接入宿主机编码 Agent</h3>
          <div class="cmd-switcher">
            <div class="cmd-tabs" role="tablist" aria-label="选择操作系统安装命令">
              <button type="button" class="cmd-tab" role="tab" aria-selected="true" data-cmd-tab data-cmd="${escapeAttr(unixCmd)}">macOS / Linux</button>
              <button type="button" class="cmd-tab" role="tab" aria-selected="false" data-cmd-tab data-cmd="${escapeAttr(winCmd)}">Windows</button>
            </div>
            <div class="code-block" data-lang="text">
              <pre tabindex="0"><code id="install-cmd-code">${escapeHtml(unixCmd)}</code></pre>
              ${renderCopyControl("install-cmd-code", "复制安装命令")}
            </div>
          </div>
          <p class="step-body">需 Node.js 22.20+，详见 <a href="${escapeAttr(siteUrl("docs/agent-bridge.html"))}">本地 Agent 桥接指南</a>。</p>
        </div>
      </div>
    </section>

    <dialog id="shot-lightbox" class="lightbox-dialog" aria-label="扩展截图预览">
      <div class="lightbox-head">
        <span id="lightbox-caption" class="lightbox-caption"></span>
        <button type="button" id="lightbox-close" class="icon-btn" aria-label="关闭预览" autofocus>${ICONS.close}</button>
      </div>
      <img id="lightbox-img" class="lightbox-img" src="" alt="" />
    </dialog>
  </main>`;
}

function renderToc(headings) {
  if (!headings || headings.length === 0) return "";
  const items = headings
    .map(
      (h) =>
        `<li class="toc-level-${h.level}"><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`
    )
    .join("\n");
  return `<aside class="toc-rail" aria-label="本页目录">
    <div class="toc-title">本页目录</div>
    <nav class="toc-nav">
      <ul>${items}</ul>
    </nav>
  </aside>`;
}

function renderPager(pages, currentIndex, siteUrl) {
  const prev = currentIndex > 0 ? pages[currentIndex - 1] : null;
  const next = currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null;
  if (!prev && !next) return "";
  const prevHtml = prev
    ? `<a href="${escapeAttr(siteUrl(prev.out))}">← 上一篇：${escapeHtml(prev.navTitle)}</a>`
    : `<span></span>`;
  const nextHtml = next
    ? `<a href="${escapeAttr(siteUrl(next.out))}">下一篇：${escapeHtml(next.navTitle)} →</a>`
    : `<span></span>`;
  return `<nav class="doc-pager" aria-label="上下篇导航">${prevHtml}${nextHtml}</nav>`;
}

export function renderPageHtml({
  pages,
  page,
  pageIndex,
  version,
  title,
  bodyHtml,
  headings,
  siteUrl,
  basePath
}) {
  const isHome = page.out === "index.html";
  const fullTitle = isHome ? "BiliScript · B 站视频文摘" : `${title} · BiliScript 文档`;
  const logoUrl = `${basePath}docs/images/biliscript-logo.svg`;
  const cssUrl = `${basePath}assets/docs.css`;
  const jsUrl = `${basePath}assets/docs.js`;

  const mainHtml = isHome
    ? renderLandingBody({ siteUrl, basePath })
    : `<div class="doc-shell${headings.length === 0 ? " no-toc" : ""}">
        <main id="main-content" class="doc-main">
          <article class="markdown-body">${bodyHtml}</article>
          ${renderPager(pages, pageIndex, siteUrl)}
        </main>
        ${renderToc(headings)}
      </div>`;

  return `<!doctype html>
<html lang="zh-CN" data-palette="flyme">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <script>
    try {
      var savedTheme = localStorage.getItem("biliscript-docs-theme");
      if (savedTheme === "light" || savedTheme === "dark") {
        document.querySelector('meta[name="color-scheme"]').setAttribute("content", savedTheme);
      }
      var savedPalette = localStorage.getItem("biliscript-docs-palette");
      if (savedPalette === "flyme" || savedPalette === "editorial") {
        document.documentElement.setAttribute("data-palette", savedPalette);
      }
    } catch (_) {}
  </script>
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="description" content="${escapeAttr(page.description)}" />
  <link rel="icon" type="image/svg+xml" href="${escapeAttr(logoUrl)}" />
  <link rel="stylesheet" href="${escapeAttr(cssUrl)}" />
</head>
<body>
  <div class="site-backdrop" aria-hidden="true"></div>
  <a class="skip-link" href="#main-content">跳至正文</a>

  ${renderTopHeader({ pages, currentOut: page.out, version, siteUrl, basePath })}
  ${renderMobileDrawer({ pages, currentOut: page.out, siteUrl })}

  ${mainHtml}

  ${renderFooter({ page, siteUrl })}

  <script src="${escapeAttr(jsUrl)}" defer></script>
</body>
</html>
`;
}
