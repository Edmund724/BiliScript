# UX Audit Backlog

范围：仅收录三份 M1 审查输出中的 P2/P3 新发现，已去重；不包含 P0/P1、已修复问题或旧 IA/UF 项。以下只记录问题、用户影响与代码证据，不包含解决方案。

## P2

### M1-P2-01｜阅读面板｜设置与 AI 对话弹层可能被同一次 Esc 或外点连续关闭

- 用户影响：用户只想退出当前一层时，可能同时关闭另一层，丢失当前操作上下文。
- 代码证据：设置文档监听退出设置后，事件仍可能到达 `window` 的对话弹层监听；外点委托也会连续处理两层。`extension/ui/ui-renderer.ts:407-424`，`extension/reader/chat-popovers.ts:114-147`。

### M1-P2-02｜阅读面板｜纯打开入口缺少等待态，页内按钮没有连点锁

- 用户影响：动态装载和首载锚点等待期间，按钮仍显示为可点击的静态状态；重复点击会排入多个幂等进入事务，用户难以判断操作是否已受理。
- 代码证据：`extension/ui/script-button.ts:493-503`，`extension/reader/shell.ts:112-146`，`extension/reader/script-host.ts:124-148`。

### M1-P2-03｜阅读面板｜持久错误可跨关闭和重开残留

- 用户影响：旧错误可能在新一次打开时继续显示，使用户误以为当前操作也已失败。
- 代码证据：关闭和重新进入均未清空全局状态行；缓存字幕重开时不一定有新状态覆盖旧错误。`extension/reader/lifecycle.ts:542-599`，`extension/core/reading-status-line.ts:123-164`。

### M1-P2-04｜阅读面板｜状态反馈存在双 live region

- 用户影响：辅助技术可能重复播报同一条状态，干扰读屏用户获取反馈。
- 代码证据：面板打开后，可见状态行与 `body` 下的镜像同时为 `role="status" aria-live="polite"`。`extension/reader/lifecycle.ts:521-524`，`extension/ui/ui-renderer.ts:88`，`extension/core/reading-status-line.ts:104-117`。
- 备注：真实读屏是否重复播报待验证；当前证据来自 DOM/ARIA 结构。

### M1-P2-05｜阅读面板｜一级 Tab 缺少标准方向键漫游和面板关联

- 用户影响：键盘及读屏用户无法按常见 Tab 组件习惯使用 ←/→/Home/End 切换，三个 Tab 又全部进入普通 Tab 序，导航效率较低。
- 代码证据：三个 `role="tab"` 仅绑定点击，未提供方向键交互，也无 `aria-controls` 关联。`extension/ui/ui-renderer.ts:115-119`，`extension/ui/ui-renderer.ts:244-269`，`extension/ui/ui-renderer.ts:345-348`。

### M1-P2-06｜阅读面板｜顶栏元信息和全局状态行缺少无空格长文本断词防护

- 用户影响：长 URL、无空格英文错误或异常元数据可能溢出并被裁切，导致反馈无法完整阅读。
- 代码证据：元信息和状态行未设置 `overflow-wrap` 或 `word-break`，外层面板使用 `overflow: hidden`。`extension/entry/styles/reader.css:122-138`，`extension/entry/styles/reader.css:293-321`，`extension/entry/styles/reader.css:342-345`。
- 备注：真实浏览器中的实际裁切范围待验证。

### M1-P2-07｜实时伴看｜面板关闭后，非状态类运行提示没有可见接收方

- 用户影响：画面参数回退、工具状态等提示会被静默丢弃，用户无法得知伴看运行期间发生的变化。
- 代码证据：关闭对话会清空 hooks，`notifyConsumer` 没有播放器 fallback。`extension/reader/chat-tab.ts:907-908`，`extension/live/live-companion-session.ts:208-210`，`extension/live/live-chat-controller.ts:1045-1047`，`extension/live/live-chat-controller.ts:1070-1084`。

### M1-P2-08｜实时伴看｜换片或换 P 时，迷你胶囊会被完整长标题撑宽

- 用户影响：换片后的约 4 秒提示期间，长视频标题可能使迷你胶囊遮挡过多播放画面。
- 代码证据：完整标题被写入迷你状态文本；胶囊没有最大宽度，文本禁止换行且没有省略或截断。`extension/live/fullscreen-live-overlay.ts:892-929`，`extension/entry/styles/player-ai.css:640-677`，`extension/entry/styles/player-ai.css:707-710`。
- 备注：真实播放器中的遮挡面积待验证。

### M1-P2-09｜实时伴看｜麦克风启动错误文案混入摄像头和重复括号

- 用户影响：权限拒绝或设备缺失时，错误文案包含无关设备及重复解释，增加理解和排障成本。
- 代码证据：`extension/live/page-media-capture.ts:110-146`。

### M1-P2-10｜实时伴看｜浮窗未完整遵循减少动态效果偏好

- 用户影响：即使用户启用减少动态效果，浮窗和迷你胶囊仍有透明度、位移动效，连接及重连状态仍无限脉冲，可能造成不适或分散注意力。
- 代码证据：现有 reduced-motion 规则只覆盖开关和滑块；拖拽吸附已正确处理，不在本项范围内。`extension/entry/styles/player-ai.css:606-610`，`extension/entry/styles/player-ai.css:672-676`，`extension/entry/styles/player-ai.css:767-786`，`extension/entry/styles/player-ai.css:1043-1052`。

### M1-P2-11｜实时伴看｜首次连接的浮窗主体缺少麦克风授权预告

- 用户影响：首次连接时，空主体无法解释接下来为何出现浏览器麦克风权限请求，用户缺少授权决策所需的情境。
- 代码证据：连接中仅更新头部状态，主体没有授权说明；顶部关闭按钮仍存在，本项不是无法退出的问题。`extension/live/fullscreen-live-overlay.ts:334-345`，`extension/live/fullscreen-live-overlay.ts:802-819`。

## P3

### M1-P3-01｜阅读面板｜设置齿轮的展开语义不完整

- 用户影响：读屏用户只能获知按下状态，无法通过标准的展开状态和控件关联理解齿轮与设置区域的关系。
- 代码证据：当前只投影 `aria-pressed`，没有 `aria-expanded` 或 `aria-controls`。`extension/ui/ui-renderer.ts:79-81`，`extension/reader/settings-mode.ts:20-32`。

### M1-P3-02｜阅读面板｜全局错误与普通反馈的视觉和语义层级相同

- 用户影响：错误与普通状态均使用 muted 样式及 `role="status"`，用户较难迅速识别需要关注的失败反馈。
- 代码证据：错误词表只决定是否常驻，不产生错误视觉或语义状态。`extension/entry/styles/reader.css:122-138`，`extension/core/reading-status-line.ts:36-51`。

### M1-P3-03｜实时伴看｜拖拽点击阈值仍为 4px

- 用户影响：触摸屏或手抖场景下，小幅移动更容易被误判为拖拽而非点击，与约 8px 的复核目标不一致。
- 代码证据：实现和测试均锁定 4px 阈值。`extension/live/viewport-drag.ts:72-74`，`tests/live/viewport-drag.test.ts:74-87`。

### M1-P3-04｜实时伴看｜语速滑轨在 input 和 change 上重复提交

- 用户影响：一次调整会重复调用 `setSpeed` 和持久化，产生不必要的状态写入；音量已改为 change 单次提交，语速行为不一致。
- 代码证据：`extension/live/fullscreen-live-overlay.ts:465-475`，`extension/live/live-overlay-binding.ts:168-171`。

---

## M2 深度复审

范围：收录 M2 深度复审产出的 P2（8 项）/ P3（4 项）中低优先级问题（P0/P1 已修复）；以下只记录问题、用户影响与代码证据，不包含解决方案。

### P2

#### M2-P2-01｜首配引导｜四入口阻断卡与 0 平台空态引导及按钮层级不统一

- 用户影响：不同入口的配置阻断引导文案（「去设置」与「前往设置」）与按钮主次梯度不一致，且在无平台或缺少 API Key 场景仍保留无效「重试」按钮；字幕无 CC/ASR 阻塞空态视觉层级弱于概览占位卡；解释卡相邻错误按钮缺少间距，概览错误条在窄面板或长报错下无法折行；设置页 AI / 实时伴看 / 语音转写 0 平台时缺少常用预设快捷入口，冷启动路径较长。
- 代码证据：概览与解释卡分别输出「去设置」并紧邻「重试」（`extension/reader/overview-ui.ts:227-235`、`extension/reader/explain-card.ts:122-137`），对话与字幕空态使用「前往设置」（`extension/reader/chat-tab.ts:1367-1378`、`extension/reader/view-render.ts:93`、`extension/reader/chat-model-panel.ts:207`）；字幕空态使用 `.biliscript-reading-empty` 而非 `.biliscript-reading-placeholder`（`extension/reader/view-render.ts:95-97`、`extension/entry/styles/reader.css:733-737`）；解释卡错误按钮直接拼接且无间距容器（`extension/reader/explain-card.ts:136`）；概览 `.biliscript-reading-ov-strip` 未设 `flex-wrap`（`extension/entry/styles/reader.css:1779-1789`）；AI / 实时伴看 / ASR 的 0 平台空态仅展示静态提示文本，添加按钮直接打开默认空白表单（`extension/ui/settings-panel-html.ts:140,153,223`、`extension/ui/settings-panel.ts:2417-2419`）。

#### M2-P2-02｜设置面板｜380–400px 窄面板行内布局拥挤及搜索底栏样式失配

- 用户影响：380–400px 窄面板下平台行单行最多横排 7 个元素，平台名称极易被挤压截断；搜索回退链底部操作栏类名与 CSS 选择器不匹配导致样式未生效；四族列表底边框与搜索虚拟「智能」行边框规则不统一，视觉分隔不一致。
- 代码证据：`extension/ui/provider-row.ts:396-406` 在 `.provider-row-line` 单行内横排状态点、名称、徽章、选用单选、编辑、删除与拖拽把手，`extension/entry/styles/reader-settings-rows.css:231-281`；模板与 JS 使用 `.search-chain-footer-bar`（`extension/ui/settings-panel-html.ts:255`、`extension/ui/settings-panel.ts:1330`），样式表却匹配 `.search-chain-actions-bar`（`extension/entry/styles/reader-settings-shell.css:473-494`）；底边框规则仅局部针对 `.ai-providers-list > :not(:last-child)` 与 `#aiProvidersList`（`extension/entry/styles/reader-settings-rows.css:223-229`），未覆盖四族列表与虚拟智能行（`extension/ui/provider-row.ts:320-337`）。

#### M2-P2-03｜平台编辑器｜弹窗冗余提示与拉取子视图双退出键及过渡缺失

- 用户影响：搜索测试按钮悬停提示与下方说明文本逐字重复，增加视觉与读屏噪音；模型拉取子视图同时存在顶栏「← 返回」与底栏「取消」两个同义退出键，顶部标题受左侧返回按钮挤占而视觉偏右，且子视图切换缺少轻量进出场过渡。
- 代码证据：搜索测试按钮 `title` 与 `#provider-editor-test-hint` 文本完全重复（`extension/ui/provider-editor-modal.ts:802-805`）；拉取子视图同时渲染 `.provider-editor-fetch-back`（「← 返回」）与 `.provider-editor-fetch-cancel`（「取消」）（`extension/ui/provider-editor-fetch-dialog.ts:108,125`）；`.provider-editor-fetch-title` 仅依赖同排 `flex: 1 1 auto; text-align: center` 未做对称居中对齐，且 `.provider-editor-fetch-dialog` 未声明进出场过渡（`extension/entry/styles/reader-settings-providers.css:690-716`）。

#### M2-P2-04｜模型拉取｜模型拉取子视图筛选与批量选择效率不足

- 用户影响：模型数量较多时打开子视图焦点停留在返回按钮而非搜索框，无法直接输入筛选；缺少当前匹配数、搜索框一键清空与「清空已选」动作，无可选项时「全选」复选框仍可点击；长模型名被截断后缺少 `title` 提示，无法悬停查看完整 ID。
- 代码证据：`extension/ui/provider-editor-fetch-dialog.ts:133-137` 将初始焦点固定设为 `backBtn`；`renderFetchSkeleton` 与 `renderFetchItems` 未提供匹配计数、搜索清空按钮与「清空已选」按钮（`extension/ui/provider-editor-fetch-dialog.ts:115-127,256-288`）；`syncFetchSelectionState` 在 `checks.length === 0` 时未禁用 `.provider-editor-fetch-all`（`extension/ui/provider-editor-fetch-dialog.ts:294-300`）；`.provider-editor-fetch-name` 未设置 `title` 属性（`extension/ui/provider-editor-fetch-dialog.ts:277`）。

#### M2-P2-05｜平台编辑器｜表单高频操作与脏检查细节缺失

- 用户影响：用户误贴 `/chat/completions` 等接口尾路径或漏写 `http://` 时缺少行内修正提示；API Key 输入框无法明文切换核对，非强制 Key 平台保存密钥后也缺少「清除已存密钥」入口；表单字段缺少必填/选填轻量标识，列表行缺少「复制/克隆」；目录输入框内增删纯空白行或首尾空格会误触发未保存退出确认。
- 代码证据：`baseUrl` 校验仅做 `https?://.+` 与 `URL` 合法性报错，未针对尾路径或缺少协议头提供行内修正提示（`extension/ui/provider-editor-validation.ts:36-50`、`extension/ui/provider-editor-projection.ts:233-242`）；`apiKey` 控件固定 `type="password"` 且非强制 Key 平台无清除已存密钥控件（`extension/ui/provider-editor-projection.ts:251-293`、`extension/ui/provider-editor-modal.ts:395`）；字段标签未区分必填/选填（`extension/ui/provider-editor-projection.ts:118-124`）；`provider-row.ts:395-408` 未提供克隆操作；`draftsEqual` 直接严格比对原始 `models` 数组而非归一化后的非空模型列表（`extension/ui/provider-editor-state.ts:59-87`）。

#### M2-P2-06｜可读性与溢出｜长文本溢出裁切与行级测试失败原因仅悬停可见

- 用户影响：列表行平台名称被省略号截断后没有完整提示；搜索折叠行右侧摘要未限宽，长摘要会挤压左侧标签；AI 模型目录行测试失败原因仅写在状态图标 `title` 上，键盘与触屏用户无法聚焦或读屏获取；划词解释卡引用长文本时会撑高上方区域并挤压下方错误按钮操作区。
- 代码证据：`.provider-row-name` 设置单行省略但无 `title` 属性（`extension/ui/provider-row.ts:398`、`extension/entry/styles/reader-settings-rows.css:271-281`）；`.biliscript-entry-summary` 未限制最大宽度及溢出截断（`extension/entry/styles/reader-settings-shell.css:448-454`）；`runModelTest` 失败时仅设置 `result.title`（`extension/ui/provider-editor-catalog.ts:88-94,168-170,183`、`extension/entry/styles/reader-settings-providers.css:490-546`）；`.biliscript-reading-explain-card-quote` 为 `flex: 0 0 auto` 且未设置 `max-height` 与局部滚动（`extension/entry/styles/reader.css:1243-1255`）。

#### M2-P2-07｜设置面板｜列表初始加载态、Host 权限异常与禁用态处理不完整

- 用户影响：设置页初始拉取完成前直接显示「暂无已配置平台」，IPC 失败时也混同为空列表且无重试入口，易误导用户以为配置丢失；用户在浏览器扩展管理页撤销可选 Host 权限后，设置页无状态提醒；存量 `enabled: false` 平台在列表与编辑器中无状态标识也无法切换，保存还会隐式重置为启用。
- 代码证据：`extension/ui/settings-panel-html.ts:139-140,152-153,222-223,253-254` 初始静态渲染 `.ai-providers-empty`，且 `loadProviderRows` 在响应失败或异常时直接返回 `[]`（`extension/ui/settings-panel.ts:1385-1393`）；`loadSettings` 未校验并展示已撤销可选 Host 权限提醒（`extension/ui/settings-panel.ts:1121-1186`、`extension/core/host-permissions.ts`）；`provider-row.ts:49-79` 未消费 `enabled` 状态，AI 序列化硬编码 `enabled: true`（`extension/ui/provider-family.ts:155`）。

#### M2-P2-08｜首配联动｜切分 P 或换视频时未同步更新已打开的首配编辑器状态

- 用户影响：用户在首配弹窗打开期间切换视频或分 P 后，弹窗仍保留「保存并继续」文案，保存后却因视频上下文变化导致原续跑意图静默作废，按钮承诺与实际行为不一致。
- 代码证据：`extension/entry/clip-switch-transaction.ts:101-179` 在 URL 变更重置 clip 状态并刷新阅读面板时，未同步更新已打开的首配弹窗状态；`openProviderEditorById` 与 `provider-editor-modal.ts` 在 `firstSetup` 会话期间固定展示「保存并继续」（`extension/ui/settings-panel.ts:1748-1755`、`extension/ui/provider-editor-modal.ts:433-443,818`）。

### P3

#### M2-P3-01｜设置导航｜11 分区横向导航的可达性与视觉细节打磨不足

- 用户影响：11 个设置分区横向导航发生溢出时左右边缘缺少渐隐提示，用户不易察觉可横向滚动；吸顶导航条与下方滚动内容分隔对比偏弱；键盘与读屏用户无法通过 `ArrowLeft`/`ArrowRight` 漫游切换导航项，缺少 `aria-current="location"` 状态反馈，点击跳转后焦点也未移至对应分区标题。
- 代码证据：`extension/ui/settings-panel-html.ts:118-130` 与 `extension/entry/styles/reader-settings-shell.css:191-287` 未配置左右溢出遮罩与吸顶分隔线；`bindSettingsNav`（`extension/ui/settings-panel.ts:2017-2106`）仅维护 `.is-active` 类并执行 `scrollIntoView`，未设置 `aria-current="location"`、未监听左右方向键切换且未聚焦分区标题。

#### M2-P3-02｜播放器浮窗与同传｜直播全屏伴看与 AI 同传未接入 Setup Resume

- 用户影响：用户在播放器伴看浮窗或无 CC 实时同传场景因未配平台或缺少 Key 跳转设置并完成保存后，不会自动退回原浮窗或引导重连，需要手动重新找到并触发原入口。
- 代码证据：`extension/live/fullscreen-live-overlay.ts:340,831-853` 的设置入口仅打开设置界面；`extension/live/interpret-session-controller.ts:121-170` 在 `refreshAvailability` 检测到缺失配置时仅产出错误状态，未在保存配置后衔接自动返回或重连引导。

#### M2-P3-03｜文案与无障碍｜中英文混排缺空格及状态节点缺少 live region 语义

- 用户影响：AI 平台新增/编辑弹窗标题出现 `"添加AI 平台"` 中英文粘连；平台编辑器状态行与设置面板全局状态栏未声明 live region，读屏用户无法及时获知保存、删除或校验结果反馈。
- 代码证据：`extension/ui/provider-family.ts:131` 定义 `title: "AI 平台"` 与 `extension/ui/provider-editor-modal.ts:707-710` 直接拼接为 `"添加AI 平台"`；`extension/ui/provider-editor-modal.ts:815` 的 `.provider-editor-status` 与 `extension/ui/settings-panel-html.ts:513` 的 `#biliscriptSettingsStatus` 均未标注 `role="status"` / `aria-live="polite"`（同文件 `#agentBridgeAddressStatus` 在 504 行已声明 `role="status"`）。

#### M2-P3-04｜样式语义｜模型目录行删除按钮悬浮语义色未对齐危险色令牌

- 用户影响：平台编辑器的 AI 模型目录行删除按钮在悬浮态原本使用常规强调色（`--biliscript-reader-accent` / `--biliscript-reader-accent-soft`），未能向用户传递删除操作的警示语义。
- 代码证据：M2 深度复审记录 `.provider-editor-model-remove:hover` 使用 `--biliscript-reader-accent` 与 `--biliscript-reader-accent-soft` 而未对齐 `--biliscript-reader-danger` / `--biliscript-reader-danger-soft`（`extension/entry/styles/reader-settings-providers.css:586-610`；列表行 `.provider-row-remove:hover` 在 `extension/entry/styles/reader-settings-rows.css:382-385` 仍为强调色）。
