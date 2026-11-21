# ADR-0038：Light DOM 宿主样式隔离不变量、Live 音频预分离与流式滚动豁免

> 状态：有效

由于阅读面板、播放器入口与字幕控件直接挂载于 B 站 Light DOM 页面（ADR-0004），且实时伴看与长文摘对话涉及高频 Web Audio 帧流转与流式 DOM 更新，现将跨端验证沉淀出的 CSS 特指度/盒模型不变量与流式管线收缩边界归档如下。

## 背景与动机

1. **宿主全局重置与 CSS 属性语义冲突**：B 站 `video.*.css` 声明了 `[hidden] { display: none !important }`、`li { list-style-type: none }` 以及全局 `h1`-`h6`/`a` 颜色重置，且 `bpx-player` 通过 `createOverflowCheck` 监测控制栏相邻元素几何越界；同时阅读面板内 `contain: layout`、`backdrop-filter`、`mask-image` 与 `content-visibility: auto` 会建立层叠上下文、Backdrop Root 或高度估算边界。
2. **实时伴看语音回声与中断竞争**：同时采集麦克风与页面共享视频音频时，若在进 AudioWorklet 前混音或用朴素阈值打断，AI 语音会反馈触发误打断，且 MOSS 协议分离的 `audio.context` 元数据与二进制 PCM 帧在打断竞态下易跨回合错配。
3. **流式 Markdown 渲染与自动跟滚竞争**：AI 回合结束（`done`）瞬间若立即撤销 `content-visibility` 豁免或使用平滑滚动，离屏节点坍缩到估算高度会令滚动位置回跳并误判为用户手动上滚。

## 已定决策

### 1. Light DOM 样式隔离、特指度与盒模型不变量（补充 ADR-0004、ADR-0007、ADR-0021、ADR-0028、ADR-0036）

- **宿主重置与隐藏属性覆写**：`bilingual-subtitles.css` 中 `.biliscript-bilingual-col[data-col="sub"]` 内嵌 `.custom-select-dropdown` 使用 `display: flex !important` 覆盖宿主 `[hidden] !important`，而外层浮层 `.custom-select-dropdown[hidden]` 以特指度 `(1,3,0)` 声明 `display: none` 压过 `:has(> .biliscript-bilingual-popover)` 的 `(1,2,0)`；`reader.css` 以 `#biliscript-reading-view :where(h1..h6, a)`（`(1,0,0)`）恢复标题与链接令牌色，`github-markdown-theme.css` 以 `(1,2,2)` 的 `li:not(.task-list-item)` 直接覆盖宿主 `li` 规则。
- **播放器工具栏与 SVG 动画约束**：`player-ai.css` 仅在紧邻前序可见兄弟带有大右外边距（Hi-Res 20px/24px、Dolby 14px）时施加负左外边距补偿，防止紧邻零外边距兄弟时 `rect.left < prev.right - 1` 触发 `bpx-player` `createOverflowCheck` 塌陷控制栏；思考轨道悬停动画仅驱动 SVG 几何属性（`ry`/`r`）而不覆写椭圆 `rotate(±45)` `transform`；`script-tabs` 地球搜索胶囊 SVG 保留 3 条同模板经线半弧以维持 CSS `d` 关键帧形变路径数量一致。
- **非 `corner-shape` 圆角校准与双源字体镜像**：`reader-gate.css` 在 `@supports not (corner-shape: superellipse(1.25))` 下对非胶囊/非正圆 `--biliscript-radius-*` 令牌乘以 `0.86` 以对齐超椭圆 45° 对角视觉体积（同时保持阴影与同心圆公式）；`--biliscript-reader-font-sans` 与 `extension/ui/mermaid-render.ts` 中的 `PANEL_FONT_FAMILY` 维持显式双源镜像（Mermaid 配置不能消费 CSS 变量）。
- **盒模型、网格夹逼与层叠上下文不变量**：
  - `.biliscript-reading-subtitle` 与 `.chat-input` 均锁定 `box-sizing: border-box`；`.biliscript-reading-script-panel` 使用 `grid-template-columns: minmax(0, 1fr)` 而非隐含 `min-content` 下限的 `1fr`；`.chat-input` 自适应高度写入 `min-height`（`flex-basis: 0%` 下内联 `height` 无效）、读取 `scrollHeight` 前先清内联 `min-height` 防每键递增 `+4px`，并在低于 `320px` 时保持 `overflow-y: hidden` 防 Chromium 亚像素行高闪烁 1px 滚动条。
  - `.chat-model-panel` 打开时清除 `.chat-input-card` 的 `backdrop-filter`，解除 Backdrop Root 对半透明背景虚化的裁剪；`.chat-messages` 顶部 10px `mask-image` 会创建层叠上下文，`.chat-search-preview` 与 `.chat-model-panel` 依赖 DOM 序置于其后；设置抽屉分组使用 `contain: layout` 时，展开中的 `custom-select` 所在分组必须抬升 `z-index` 防止被后续兄弟分组遮挡；空元数据时仅隐藏 `.biliscript-reading-meta`，禁止隐藏承载 `::after` 手动浏览徽标的 `.biliscript-reading-header-copy`。
  - `renderMarkdown` 产出的 11 个顶层块标签（`p`、`h3`-`h6`、`ul`、`ol`、`pre`、`table`、`blockquote`、`hr`）必须与 `reader.css` / `reader-chat.css` 中 `content-visibility: auto` 选择器列表保持同步。
- **面板内交互控件契约**：`confirm-dialog` 挂载于 `#biliscript-reading-view` 并在捕获阶段拦截外部点击，避免冒泡阶段折叠设置抽屉；`custom-select` 通过内联 `select.style.display = "none"` 隐藏原生 `<select>`（免于特指度竞争并同步退出无障碍树与 Tab 序），`aria-busy` 仅调暗子元素 `.custom-select-value` 与箭头而非整个触发器以免与呼吸点透明度叠加，与 `.ai-provider-model-option` 共享孪生盒模型（`border-box`、`min-height: 38px`、`line-height: 30px`、`padding: 4px 10px`、`overflow-x: hidden`），在捕获阶段处理外部点击关闭；且 `custom-select` 浮层选项点击不代查触发器 `disabled`，由调用方在 `change` 回调中守卫在途请求；`provider-editor` 以 `EditorDraft` 为唯一事实源并通过 `captureSession`/`runIfCurrent` 丢弃失效弹窗会话的过期异步回写。

### 2. Live 实时伴看音频预分离、60ms 打断与流式滚动豁免（补充 ADR-0023、ADR-0026、ADR-0034）

- **AudioWorklet 节点前双路分离与 3 帧打断**：`micSource -> workletNode(0,0)` 纯净直通麦克风供纯麦 VAD 单独评估，`videoSource -> videoSendGain -> workletNode(0,1)` 在 AI 发言期经 `setTargetAtTime` 衰减至 `0.06` 压制回声而不触发误打断；打断须连续命中 3 帧（`60ms` = `960` samples @ `16kHz`）人声后执行 0ms 乐观停播、清播放队列与恢复增益。
- **MOSS 分离帧丢弃配对与连续静音上行**：MOSS 协议使用丢弃上下文将 `audio.context` 元数据与分离抵达的二进制 PCM 帧绑定消费，使被中断回合的在途二进制帧被安全吸收而非错配进下一回合；未静音期间（含 VAD 静音与低带宽节流）持续上行发送 16kHz 静音帧，仅显式静音停止上行并单次发送 `audioStreamEnd: true` / `mic_state` 而不关闭 WebSocket。
- **对话流式 `content-visibility` 保留与思考框跟滚豁免**：`chat-msg-streaming` 类在回合 `done` 时继续保留，直至下一条用户消息挂载并配合 `scrollTo({ behavior: 'instant' })` 才移除，防止平滑滚动或高度重算坍缩导致自动跟滚误关；思考框在编程滚底至浏览器下一帧 `scroll` 事件派发窗口内豁免因新增推理文本导致的 `scrollHeight` 增长，避免大段流式输出误判为用户手动上滚。

## 考虑过的备选

- **在 `done` 时立即移除 `chat-msg-streaming` 或使用 CSS `smooth` 滚动**：实测会触发离屏块估算高度跳变与 `scroll-sync` 误停自动跟滚，予以否决。
- **在 AudioWorklet 内做单通道混合后再行回声抵消或仅靠 CSS 类隐藏原生 `<select>`**：前者在软件混音下易因共享视频声道触发误打断，后者易被宿主或设置页原生 select 样式规则覆盖，予以否决。

## 后果

- 修改 `renderMarkdown` 顶层块元素类型、`PANEL_FONT_FAMILY` 字体栈或播放器工具栏邻接样式时，必须同步校验对应 CSS 选择器、令牌与特指度层级。
- 涉及 `custom-select` 触发器禁用态的业务场景必须由调用方在 `change` 处理链中执行并发守卫。
