# 下拉与弹层控件统一采用 @starting-style 离散过渡做来源展开与平滑淡出

> 状态：有效

阅读面板内现有多类下拉选择器与二级弹出菜单（`custom-select` 组件、模型选择下拉、AI 对话更多菜单、底部模型面板等）。此前所有浮层开合均直接切换 HTML `hidden` 属性（`[hidden] { display: none }`），造成打开时瞬间闪现、关闭时骤然消失，缺乏与触发按钮（trigger/chip）的空间来源关系与视觉舒适度。我们决定：**全站所有下拉选择器与弹出卡片统一采用现代纯 CSS `@starting-style` + 离散过渡（`transition-behavior: allow-discrete`）方案**，实现从触发按钮处弹性展开、关闭时平滑淡出。

## 考虑过的方案

- **A1：JS 类名状态机（`.is-open` / `.is-closing`）加 `transitionend` 监听**：传统 Web 方案，关闭前保留 DOM 节点并延迟设置 `hidden`。但状态机极其脆弱——当用户快速连击、在关闭动画播放中又点击其它控件或触发全局外点关闭时，`transitionend` 容易被中断或并发打架，引发浮层卡死、幽灵展示或 DOM 泄露等竞态 bug。
- **A2：仅做纯淡入淡出（crossfade），不设缩放与锚点**：实现简单，但浮层缺乏实体发射感，视觉上无法感知菜单是从哪个按钮出来的。
- **A3：纯 CSS `@starting-style` + `display: allow-discrete`（本裁决方案）**：Chrome 117+ 原生支持。开合状态仍 100% 仅由原先的 `hidden` 属性单源驱动，JS 逻辑零改动、零状态机、零计时器，由浏览器渲染管线在底层原生处理离散显示与过渡动画。

## 裁定细节与后果

1. **单源驱动与零 JS 状态负担**：
   - 所有浮层开启与关闭仍纯通过 `element.hidden = false/true` 控制。
   - `[hidden]` 规则挂载 `display: none`、`opacity: 0`、`transform: scale(0.98)` 以及 `transition: opacity 120ms ease-out, transform 120ms ease-out, display 120ms allow-discrete;`。
   - 未隐藏态挂载 `opacity: 1`、`transform: scale(1)` 以及 `transition: opacity 160ms var(--biliscript-reader-ease-spring), transform 160ms ..., display 160ms allow-discrete;`。
   - 打开第一帧由 `@starting-style { :not([hidden]) { opacity: 0; transform: scale(0.95); } }` 捕获，产生从 `0.95` 微弹射展开至 `1.0` 的手感。

2. **来源锚定（`transform-origin`）规则**：
   - 向下展开且靠左对齐的下拉（常规 `custom-select-dropdown`、设置页 `ai-provider-model-dropdown`）：锚定在 `top left`。
   - 向下展开且靠右对齐的菜单（双语副轨选择器、AI 对话顶栏更多操作菜单 `biliscript-reading-chat-more-menu`）：锚定在 `top right`。
   - 向上展开且靠右对齐的面板（AI 对话底部模型面板 `chat-model-panel`）：锚定在 `bottom right`（正对着触发它的 chip 按钮）。

3. **关闭质感（轻柔淡退）**：
   - 关闭时间设为更紧凑的 120ms（展开为 160ms），伴随微缩放（`scale(0.98)`）与平滑淡出，视线焦点干净利落交还主面板。

4. **减弱动态（`prefers-reduced-motion: reduce`）降级**：
   - 系统开启减弱动态时，四类浮层一律重置为 `transition: none; transform: none;`，恢复瞬时开闭，杜绝视觉眩晕。

## 重开条件

若 Chrome 上游在离散过渡期间引入重大渲染 bug（如重排断崖或 backdrop-filter 在过渡帧闪黑），且无法通过微调 CSS 解决，退回无动画瞬开瞬关。
