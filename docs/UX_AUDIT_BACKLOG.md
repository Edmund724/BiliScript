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

---

## M3 深度复审

范围：收录 M3 深度复审产出的 P2（7 项）/ P3（1 项）中低优先级问题（P0/P1 已修复）；以下只记录问题、用户影响与代码证据，不包含解决方案。

### P2

#### M3-P2-01｜字幕列表｜未做视口虚拟化且双语加载与失败占位逐行重复渲染

- 用户影响：长视频字幕列表渲染全量条目节点，仅靠分批追加与 `content-visibility` 缓解；副轨处于加载中或失败状态时，每一条字幕下方均重复出现同一句「译文加载中…」或「译文加载失败」文本，造成长列表视觉噪音与多余 DOM 开销。
- 代码证据：`extension/reader/view-render.ts:108-124` 采用首批渲染与 rAF 分批追加全量条目；`extension/reader/batched-render.ts:67-113` 在 `slot.state === "loading"` 或 `"error"` 时逐行输出 `SECONDARY_LOADING_TEXT` / `SECONDARY_FAIL_TEXT`。

#### M3-P2-02｜选轨控件｜工具条触发器定宽 120px 与双语空态限宽在窄词长语种下易截断

- 用户影响：工具条上的选轨控件固定宽度 120px，较长语言名或带区分标签文本容易在触发器内被省略号截断；双语卡片空态说明行限宽 140px 且整体卡片限高 320px，长提示文本与多语种列表的可读空间受限。
- 代码证据：`extension/entry/styles/reader.css:284-287` 将 `.biliscript-reading-track-picker` 设为 `width: 120px`；`extension/entry/styles/bilingual-subtitles.css:55-68,220-231` 设定卡片 `max-height: 320px` 及 `.biliscript-bilingual-empty` `max-width: 140px` 单行省略。

#### M3-P2-03｜字幕导出｜工具条导出按钮仅按全局设置导出单一格式，缺乏当场格式切换

- 用户影响：点击字幕工具条「导出字幕」只能按设置抽屉里预设的 `downloadFormat`（SRT 或 TXT）直接下载单一格式，无法在精读现场按需切换导出纯文本、带时间轴文本或双语字幕格式。
- 代码证据：`extension/reader/subtitle-tab-ui.ts:172,1129-1168` 绑定单一导出按钮调用 `chain.downloadSubtitle()`；`extension/subtitle/ui.ts:53-82` 直接读取 `state.settings?.downloadFormat` 生成单个文件并触发下载。

#### M3-P2-04｜ASR 转写｜自动语音转写进行中缺少手动取消或跳过控制

- 用户影响：无 CC 视频自动触发 ASR 转写期间，字幕页签显示转写进度横幅并淡出列表，但用户无法在页签内主动取消或跳过本次在飞转写任务，只能等待完成或离开当前页面。
- 代码证据：`extension/reader/transcribe-banner.ts:62-93` 与 `extension/reader/subtitle-tab-ui.ts:180-185` 仅渲染纯状态展示横幅，未提供取消按钮；`extension/asr/fallback.ts:164-208` 的 `AsrFallback` 与 `ActiveAsrTranscribe` 未暴露按视频取消转写任务的控制入口。

#### M3-P2-05｜无字幕空态与 ASR 失败｜失败提示动作粒度单一，且空态操作按钮缺少主次层级

- 用户影响：部分 ASR 失败原因（如额度不足）与未知失败同样仅提供「重新抓取」重试按钮，缺乏更明确的平台排查上下文引导；无字幕空态渲染的「前往设置」与「重新抓取」按钮均使用普通样式，缺少主次视觉区分。
- 代码证据：`extension/core/asr-failure-notice.ts:81-142` 的 `COPY_TABLE` 将 `asr-quota` 等多项归入 `"retry-later"`；`extension/reader/view-render.ts:97-107` 直接拼接 `.biliscript-reading-mini-btn` 输出 `setupAction` 与 `retryAction`，未做 `.is-primary` 等级区分。

#### M3-P2-06｜实时字幕翻译｜浮层淡出过渡未生效且字幕字号固定写死，无法随偏好缩放

- 用户影响：无 CC 视频开启播放器「字幕」实时翻译后，隐藏浮层直接置 `hidden = true` 匹配 `display: none !important`，导致 CSS 中声明的 300ms `.is-fading` 透明度淡出动画从未触发；同时浮层译文与原文字号写死为 `20px` / `18px`，无法随播放器尺寸或阅读字号偏好自适应缩放。
- 代码证据：`extension/live/interpret-subtitle-overlay.ts:67-79` 的 `clearCurrent` 直接设置 `rootEl.hidden = true`；`extension/entry/styles/interpret-subtitles.css:13-45` 定义了 `.is-fading { opacity: 0 }` 与 `transition: opacity 300ms ease-out`，但 `[hidden]` 强制 `display: none !important`，且原文/译文分别固定 `font-size: 18px` 与 `20px`。

#### M3-P2-07｜字幕交互与工具条｜窄面板工具条折行与列表指针按下无条件暂停自动跟随

- 用户影响：在 380–460px 窄面板宽度下，字幕工具条搜索框与右侧控件易发生换行，增加顶部固定占位高度；同时在字幕列表内任意 `pointerdown`（包含普通点句或轻微触碰，未实际滚动）都会立即记为手动交互并弹出「跟随播放」悬浮按钮。
- 代码证据：`extension/entry/styles/reader.css:898-909` 的 `.biliscript-reading-sub-toolbar` 在搜索框 `flex: 1 1 150px` 放不下时折行；`extension/reader/subtitle-tab-ui.ts:1199-1205` 在 `subtitleList` 的 `pointerdown` 回调内无条件调用 `reader.noteManualReaderInteraction()`。

### P3

#### M3-P3-01｜样式与微交互｜跟随按钮重复字族声明、实时提示定位写死及滚动条定制口径不统一

- 用户影响：`#biliscript-reading-view .biliscript-reading-follow-btn` 连续声明两次 `font-family`，并在静态规则中未显式对齐圆角焦点环；实时翻译通知条固定 `bottom: 120px` 与 `13px` 字号，在较矮播放器视口下位置不够灵活；双语弹层列使用自定义 `::-webkit-scrollbar` 而解释卡长引文容器使用原生 `scrollbar-width: thin`，跨区域滚动条外观存在细微差异。
- 代码证据：`extension/entry/styles/reader.css:1176-1178` 重复声明 `font-family`；`extension/entry/styles/interpret-subtitles.css:52-68` 为 `.biliscript-interpret-notice` 固定 `bottom: 120px` 与 `font-size: 13px`；`extension/entry/styles/bilingual-subtitles.css:126-151` 采用 `::-webkit-scrollbar` 定制，与 `reader.css` 解释卡引文区的 `scrollbar-width: thin` 口径不同。

---

## M4 深度复审

范围：收录 M4 深度复审产出的 P2（4 项）/ P3（2 项）中低优先级问题（P0/P1 已修复）；以下只记录问题、用户影响与代码证据，不包含解决方案。

### P2

#### M4-P2-01｜概览加载态｜生成态下方占位卡为纯文字说明，缺少结构化骨架屏预览

- 用户影响：首次生成概览且尚无旧产物可展示时，生成状态条下方仅显示纯文字居中提示卡片，用户无法预见「摘要 / 章节要点 / 金句卡片」三段式版面结构，生成完成切换瞬间整块内容跳变较大。
- 代码证据：`extension/reader/overview-ui.ts:137-168` 在 `phase === "generating"` 且 `analysis === null` 时只渲染 `buildGeneratingStrip` 与 `.biliscript-reading-ov-empty-card` 纯文本占位提示，未提供结构化骨架屏 DOM。

#### M4-P2-02｜概览刷新与缓存｜完成态缺少手动重新生成入口，且切换默认模型后仍命中旧模型缓存

- 用户影响：概览处于完成态（`ready`）时面板内不提供手动「重新生成」按钮；同时在设置抽屉切换当前使用的 AI 平台或模型后，重新进入同一视频概览仍会直接读取旧模型写入的本地缓存，无法自动或一键刷新为新模型结果。
- 代码证据：`extension/reader/overview-ui.ts:145-147,267-330` 的完成态渲染未提供重生成动作按钮（仅 `cancelled` 与部分失败条带含重试/重新生成按钮）；`extension/ai/analysis-orchestrate.ts:118-139` 的 `buildAnalysisFinalCacheKey` 与 `buildAnalysisSegmentCacheKey` 仅拼接 `bvid`、`cid`、字幕轨 `source key` 与字幕签名 `signature`，未把平台或模型标识写入缓存键。

#### M4-P2-03｜金句分享卡片｜超长金句超过 4 行被截断时缺少界面提示，且海报缺少可选视频标题或时间点署名

- 用户影响：金句正文在 14px 下限字号下仍超过 4 行时，预览与导出成图会自动截取前 4 行并在末尾补省略号，但弹窗未提示正文已被截断；同时卡片底栏仅固定署名 `BiliScript`，缺少可选的视频标题或时间戳来源信息，脱离视频页面传播时上下文信息不足。
- 代码证据：`extension/reader/quote-share-export.ts:435-436,565-573,824-880` 在 `MAX_LINES = 4` 超限后通过 `truncateQuoteLines` 截断并标记 `truncated = true`，Canvas 导出仅绘制正文、`BiliScript` 角标与双段标记；`extension/reader/quote-share-modal.ts:29-33,416,709-730` 的 `OpenQuoteShareModalOptions` 未接收视频标题或时间点，`buildModalHtml()` 也未根据 `layout.truncated` 展示截断提示。

#### M4-P2-04｜章节随播同步｜多章节长视频随播高亮滚出视口后缺少自动跟随或快速定位入口

- 用户影响：长视频章节数量较多时，随播放进度推进仅有当前章节卡片切换高亮状态，高亮项滚出概览容器可视区域后不会自动跟随滚动，且面板内没有类似字幕页「跟随播放」的快速定位当前章节按钮。
- 代码证据：`extension/reader/sync.ts:157-208` 的 `syncReadingOverviewActiveChapter` 仅更新 `.biliscript-reading-ov-chapter` 的 `is-active` 类名与 `aria-current="true"`，未执行任何滚动定位；`extension/reader/overview-ui.ts:267-330` 亦未提供定位当前章节入口。

### P3

#### M4-P3-01｜章节来源标识｜三源分章仅标识 AI 生成，简介/热评时间轴与官方看点缺少来源标签

- 用户影响：章节区标题旁仅在 AI 自由分章时展示「AI 生成」标签；当章节源自视频简介/热评时间轴或 B 站官方看点时无任何来源角标，用户难以分辨当前章节时间轴的出处。
- 代码证据：`extension/reader/overview-ui.ts:294` 仅基于布尔条件渲染 `snapshot.aiChapters ? '<span class="biliscript-reading-ov-badge">AI 生成</span>' : ""`，`ReaderOverviewSnapshot`（`extension/reader/overview-coordinator.ts:36-44`）未向 UI 传递三源分章的具体来源标识。

#### M4-P3-02｜金句卡 DOM 结构｜金句卡外层 button 嵌套 span[role=button] 子操作控件，读屏朗读与语义耦合

- 用户影响：金句卡整卡为原生 `<button type="button">`，内部嵌套两个 `<span role="button" tabindex="0">` 子操作按钮（分享与复制），属于交互元素嵌套交互元素；读屏聚焦整卡时会合并朗读正文与子操作语义，结构耦合。
- 代码证据：`extension/reader/overview-ui.ts:356-375` 的 `quoteCardHtml` 使用外层 `<button type="button" class="biliscript-reading-ov-quote" ...>` 直接包裹 `.biliscript-reading-ov-quote-share` 与 `.biliscript-reading-ov-quote-copy` 两个 `role="button"` 节点。

---

## M5 深度复审

范围：收录 M5 深度复审产出的 P2（10 项）/ P3（5 项）中低优先级问题（P0/P1 已修复）；以下只记录问题、用户影响与代码证据，不包含解决方案。

### P2

#### M5-P2-01｜工具时间线卡｜单回合混用多类工具共用单卡互相覆写标题与折叠态，且热评/当前帧工具无状态投影

- 用户影响：同一助手回合先后调用联网搜索与历史视频帧工具时，所有步骤被挤进同一张时间线卡，后到事件直接覆写卡片标题与头部副文案，并互相沿用或冲突折叠态；同时模型调用当前帧截图或拉取热门评论工具时界面没有任何进行中或终态卡片投影，用户感知不到工具调用过程。
- 代码证据：`extension/chat/chat-stream-render.ts:767,865,912-935,1076-1130` 的 `searchCardStates` 按 `assistantNode` 仅保存单个 `SearchCardState`，`createSearchCard` 仅按首条事件 `isVideoFrameStatus(msg)` 决定默认展开/折叠，`applySearchStatusToNode`（`1085-1092,1125-1126`）按最新事件覆写同一张卡的 `.chat-search-card-label`、`queryEl.textContent` 与状态；`extension/ai/tool-loop.ts:28-64,319-424` 仅在 `isHistoricalFrame` 分支（`334,361,391`）和搜索分支（`427,441,458`）上报 `onToolStatus`，`CAPTURE_CURRENT_VIDEO_FRAME_TOOL_NAME` 与 `FETCH_HOT_COMMENTS_TOOL_NAME`（`407-424`）均未触发 `onToolStatus`。

#### M5-P2-02｜消息持久化｜max_tokens 截断状态未落库，重开面板或切回历史会话后丢失截断徽标与「继续生成」入口

- 用户影响：助手回答因 `max_tokens` 截断时，当轮虽会展示截断提示徽标和「继续生成」按钮，但该状态仅存在于当轮内存中；重开文摘面板或切走再切回该历史会话后，截断徽标与「继续生成」入口均会消失，无法从断开处继续生成。
- 代码证据：`extension/chat/chat-runtime.ts:321,536-537,1059-1077,1143-1144,1162-1167` 仅将 `notice(code: "truncated")` 文案保存在闭包变量 `turnTruncatedNotice`，在 `finalizeAssistant` 调用 `appendTruncatedBadge(turn)` / `turn.markTruncated(...)` 渲染实时 DOM，而 `commitAssistantTurn` 只向 `ChatSessionMessage` 写入 `thinking` 与 `stopped`；`extension/chat/chat-state.ts:77-88` 的 `ChatSessionMessage` 与 `extension/chat/conversation-store.ts:94-116` 的 `normalizeHistoryMessage` 未定义或保留截断字段；`extension/chat/replay.ts:137-148` 与 `extension/chat/chat-stream-render.ts:1677-1683` 在回放阶段未调用 `markTruncated`。

#### M5-P2-03｜对话通知流｜消息区内流通知条通过 messages.prepend 插入弹性流，短对话或顶部阅读时引发布局跳动

- 用户影响：系统在消息区顶部注入或撤除 `chat-context-notice`（如切换上下文、模型图片支持提示、正在加载上下文等）时，会直接插拔弹性列首子节点并挤压或拉回下方内容，导致空态居中欢迎区或阅读顶部消息时出现明显布局跳动。
- 代码证据：`extension/reader/chat-notices.ts:162` 对非输入区通知直接执行 `(isInputSlot && inputCard ? inputCard : messages).prepend(notice)`；`extension/entry/styles/reader-chat.css:407-421,1415-1430` 中 `.chat-messages` 为纵向 `flex` 滚动容器（`gap: 10px`），而 `.chat-context-notice` 采用 `position: sticky; top: 10px;` 在文档流内占位。

#### M5-P2-04｜对话视觉层级｜轮次间距小于段距、工具卡片白玻璃海拔过高喧宾夺主，且操作栏常驻占高与图标视感尺寸参差

- 用户影响：消息轮次之间的垂直间距（`10px`）小于助手正文默认段距（`12px`），削弱了问答轮次边界感；工具时间线卡与输入卡共用白玻璃凸起阴影，在对话流中视觉层级过重；每条消息底部的操作栏常驻显露占用垂直空间，且各按钮 SVG 尺寸（`14px`–`20px`）与描边/填充风格不统一。
- 代码证据：`extension/entry/styles/reader-chat.css:407-415` 设定 `.chat-messages { gap: 10px }`，而 `920-923` 设定 `.chat-msg-assistant p` 默认 `margin-bottom: var(--biliscript-chat-paragraph-spacing, 12px)`；`798-808` 的 `.chat-msg-actions` 常驻展示；`848-883` 中 `.chat-msg-action-btn svg` 基础为 `18px`，但复制 `20px`、朗读/导出 `19px`、重生成 `15px`、继续 `14px`（实心填充）；`2777-2785` 与 `extension/entry/styles/reader-gate.css:986-992` 为 `.chat-search-card` 赋予 `background: var(--biliscript-reader-card)` 与 `box-shadow: var(--biliscript-reader-card-highlight)`。

#### M5-P2-05｜建议词与等待闸｜建议词预热完成原地硬切易致误触与失焦，ASR 等待期上下双提示重复且可编辑快照语义隐晦

- 用户影响：视频刚打开时用户正准备点击或刚聚焦在默认 3 条建议词上，后台预热完成触发重渲后会原地无过渡整块替换成视频专属问题，容易导致误点或焦点丢失；无字幕语音转写等待发送期间，消息区顶部转写条与输入卡上方等待卡同时出现重复提示；等待期虽允许继续编辑输入框，但直到放行瞬间才以 4 秒通知条事后告知「已发送原文，保留了后来修改的草稿与图片」，等待前缺少明确预期。
- 代码证据：`extension/reader/quick-prompts.ts:126-129` 写缓存后，经 `extension/reader/chat-lists.ts:90-108` 的 `renderSuggestions` 与 `extension/reader/chat-suggestions-slot.ts:70-92` 通过 `target.innerHTML = ...` 整体替换 `.chat-chip` DOM；`extension/chat/send-gate.ts:46-47,116-135` 与 `extension/reader/chat-template.ts:51,78-82` 在 ASR 等待期同时渲染 `#biliscript-reading-chat-asr-notice`（`ASR_WAITING_NOTICE`）与 `.chat-subtitle-wait`；`extension/chat/chat-runtime.ts:785-786,845-850,879-881` 在闸前快照 `inputSnapshot`/`imageSnapshot`，放行后仅当草稿变化时弹出 4 秒 `preserveSnapshotNotice`。

#### M5-P2-06｜弹层键盘漫游｜模型面板与 ⋮ 菜单缺少焦点圈禁及 Roving Tabindex，历史列表缺少方向键漫游

- 用户影响：纯键盘用户打开模型选择面板后，`Tab` 键会直接穿过面板落回宿主页面；`⋮` 更多操作菜单打开后仅聚焦首项，缺少焦点圈禁与 `ArrowUp`/`ArrowDown` 漫游；历史列表条目内包含「打开」和「删除」两个独立 Tab 停靠点且不支持方向键快速切换条目，长列表键盘操作成本较高。
- 代码证据：`extension/reader/chat-model-panel.ts:253-283,366-378` 仅对 `.chat-model-option` 绑定方向键，未在整个 `#biliscript-reading-chat-model-panel` 建立 `createFocusScope` 或跨选项/滑轨/重置键的 Roving Tabindex；`extension/reader/chat-lists.ts:308-344,416-430` 渲染 `.chat-history-open` 与 `.chat-history-remove` 且未监听 `ArrowUp`/`ArrowDown`/`Home`/`End`；`extension/reader/chat-popovers.ts:92-96` 与 `extension/ui/ui-renderer.ts:129-189` 的 `.biliscript-reading-chat-more-menu` 仅在打开时聚焦首个控件，未绑定焦点圈禁与方向键导航。

#### M5-P2-07｜模型与多模态线索｜思考强度滑块默认 Default 态隐藏圆钮且缺刻度标签，输入区缺少贴图/拖图提示且截断模型名缺 title

- 用户影响：模型芯片上的较长模型名被省略号截断后，鼠标悬停没有 `title` 提示可查看完整名称；思考强度处于 `Default` 态时滑轨上的白色圆钮被强制隐藏且下方无档位文字刻度，用户不容易察觉滑轨可点击或当前所在档位区间；输入区及占位提示未告知支持粘贴或拖放图片，多模态能力发现成本较高。
- 代码证据：`extension/reader/chat-model-panel.ts:164-172` 与 `extension/entry/styles/reader-chat.css:2148-2156` 对 `.chat-model-chip-model` 设 `text-overflow: ellipsis` 但未同步写入 `chipModel.title`；`extension/reader/chat-model-panel.ts:352-378,403-426` 与 `extension/entry/styles/reader-chat.css:314-331` 在 `Default` 态（`activeIndex < 0`）置 `thumb.hidden = true`（`display: none !important`），且 `.chat-thinking-tick` 内的 `.chat-thinking-btn-label` 带 `hidden` 属性；`extension/reader/chat-template.ts:85-94` 的 `#biliscript-reading-chat-input` `placeholder` 仅提示「回车发送，Shift+Enter 换行」。

#### M5-P2-08｜历史记录视图｜历史弹层左右内缩不对称、标题与时间字号无梯度，且删除/清空悬停未对齐危险语义色

- 用户影响：历史记录整页弹层在面板内部左右负外边距不对称，条目标题与时间戳/摘要信息采用同一字号缺乏主次层级，且「清空全部」与单条「删除」按钮悬停时使用强调蓝而非危险红语义色，削弱了破坏性操作的警示反馈。
- 代码证据：`extension/entry/styles/reader-chat.css:2328-2337` 将 `.chat-history-popover` 设为 `inset: -10px -28px -14px -14px`（相对 `2354-2361` 头部 `padding: 0 12px 8px`、 `2533-2538` 条目 `padding-right: 12px` 与 `2566-2568` `padding: 8px 0 8px 12px` 左右不对称）；`2584-2615` 中 `.chat-history-title` 与 `.chat-history-meta` 同为 `font-size: var(--biliscript-font-size-base)`；`2518-2521` 的 `.chat-history-clear-btn:hover` 与 `2642-2645` 的 `.chat-history-remove:hover` 均使用 `color: var(--biliscript-reader-accent)` 与 `background: var(--biliscript-reader-accent-soft)`。

#### M5-P2-09｜实时伴看浮窗｜浮窗缺少「AI 说话中 / 后台文本分析中」反馈与语音打断入口，顶栏 24×24px 最小化与挂断钮紧邻 4px 易误触

- 用户影响：伴看连接后，浮窗仅能体现用户麦克风 VAD 说话态，不显示「AI 正在播报」或「后台文本模型正在分析」状态，也没有手动打断 AI 语音播报的按钮（即便控制器已提供 `interrupt()`）；顶栏最小化与关闭伴看按钮均只有 `24×24px` 且间距仅 `4px`，全屏或播放器边缘操作时极易误点挂断伴看。
- 代码证据：`extension/live/live-chat-controller.ts:133,149,435-436,1263-1272` 已提供 `isSpeaking()`、`interrupt()` 与 `subscribeTextToolRecords()`，但 `extension/live/live-overlay-binding.ts:92-104,283-329` 的 `BoundLiveControllerCallbacks` 未透传 `onSpeakingChange` 亦未订阅文本分析记录；`extension/live/fullscreen-live-overlay.ts:308-369,875-892,936-953` 与 `extension/live/live-transcript-merger.ts:342-362` 无 AI 播报/文本分析指示与打断控件；`extension/live/fullscreen-live-overlay.ts:358-368` 与 `extension/entry/styles/player-ai.css:819-840,1289-1292` 中 `.live-overlay-min-btn` 与 `.live-overlay-close-btn` 在 `.live-overlay-header-actions`（`gap: 4px`）内最小尺寸为 `24px × 24px`。

#### M5-P2-10｜伴看宿主与直播间弹窗｜浮窗与直播间 dialog 键盘事件向播放器冒泡误触快进/调音，且直播间设置缺全屏迁移、跨页 Gemini Key 监听与 overlayBinding.dispose()

- 用户影响：焦点位于播放器伴看浮窗或直播间按需伴看设置弹窗内时，按空格、方向键等按键事件会继续向 B 站播放器冒泡，误触视频暂停、快进或调音；在直播间切换网页全屏/浏览器全屏时设置弹窗不会自动迁移至新全屏宿主，跨标签页修改官方 AI 平台 Gemini Key 时直播间伴看与弹窗不会即时刷新凭据状态，且停用直播间伴看模块时未释放浮窗绑定。
- 代码证据：`extension/live/fullscreen-live-overlay.ts:458-605` 未对浮窗根节点或迷你胶囊拦截 `keydown` 冒泡；`extension/live/live-room-settings.ts:102,152-161,187-194` 仅在创建时挂载 `<dialog>` 未监听 `fullscreenchange`，`watchStorageKeys`（`152-161`）只监听 `liveProviders`/`activeLiveProviderId`/`liveProviderKeys` 而漏掉 `providers`/`aiProviderKeys`，且未阻断 `keydown` 冒泡；`extension/live/live-room-entry.ts:198-206,224-243` 的 `watchStorageKeys` 同缺 `providers`/`aiProviderKeys`，且 `stopLiveRoomCompanion` 未调用 `overlayBinding.dispose()`。

### P3

#### M5-P3-01｜流式与工具微交互｜思考流期间底部悬空残留三点光标，进行中图标与状态文字缺少呼吸脉冲及 sr-only 播报

- 用户影响：模型尚在思考阶段、正文尚未输出时，三点脉冲光标已悬空显示在思考盒下方底部；思考图标与联网搜索/截帧进行中状态缺少温和的呼吸脉冲反馈，且工具进入进行中态时屏幕阅读器无法收到即时提示。
- 代码证据：`extension/chat/chat-stream-render.ts:238-245,283-286,364-376,1495-1499` 在建消息壳时即追加 `.chat-msg-cursor`，而 `createThinkingNode` 将 `.chat-thinking` `prepend` 到节点顶部；`extension/entry/styles/reader-chat.css:654-664,1332-1356,2859-2865,2894-2899` 未给 `.chat-thinking-icon`、`.chat-search-card-status` 与 `.chat-search-step.is-running .chat-search-step-bullet` 定义脉冲动画；`extension/chat/chat-stream-render.ts:886-890,1100` 在 `status === "searching"` 时将 `announcerEl.textContent` 置空，且 `.chat-thinking` 无 `sr-only` 状态播报。

#### M5-P3-02｜搜索来源与引用｜来源行与上标引用受测试契约锁定未用原生 a 链接（不支持中键后台打开/复制链接），悬停预览卡超长无空格标题缺断词且 pointer-events: none 移入即消失

- 用户影响：用户无法对联网搜索来源行或正文 `[n]` 上标引用使用鼠标中键后台打开、右键复制链接地址或悬停查看浏览器原生链接预览；当来源标题包含超长无空格 URL/标识符时预览卡可能横向溢出，且因预览卡禁用指针事件，鼠标无法移入卡内选中文本或保持常亮阅读。
- 代码证据：`extension/chat/chat-stream-render.ts:1020-1039,1257-1275` 使用 `<button type="button" class="chat-search-source-row">` 与 `<sup class="chat-cite" role="button" tabindex="0">`，由 `tests/chat/chat-search-ui.test.ts:461-485` 断言 `tagName === "BUTTON"` 与 `role === "button"` 锁定契约；`extension/entry/styles/reader-chat.css:3056-3078` 为 `.chat-search-preview` 设置 `pointer-events: none`，且 `.chat-search-preview-title` 未设置 `overflow-wrap: anywhere` / `word-break: break-word`。

#### M5-P3-03｜语音朗读细节｜朗读中途调音量对当前分片不实时生效，且已渲染 Mermaid 图表被播报为「代码块，已跳过」

- 用户影响：在朗读较长回答过程中拖动 `⋮` 菜单内的「对话朗读音量」滑块时，当前正在播报的片段音量不会立即变化，要到下一分段才会生效；回答中包含已水合渲染的 Mermaid 图表时，朗读会将其隐匿源码 `<pre>` 播报为「代码块，已跳过。」。
- 代码证据：`extension/chat/chat-speech.ts:361-370` 仅在每次调用 `speakChunk` 启动 `engine.speak` 时读取一次 `deps.getVolume?.()`，控制器未提供在播期间实时更新音量的方法，且 `extension/reader/chat-tab.ts:582,1115-1129` 的 `speechVolumeSlider` 仅更新设置状态；`extension/chat/chat-speech.ts:188-194` 将所有 `<pre>` 节点替换为「代码块，已跳过。」并移除 `svg`，而 `extension/ui/markdown.ts:256-263` 将 Mermaid 源码留在 `.biliscript-md-mermaid > pre.biliscript-md-mermaid-src` 中。

#### M5-P3-04｜菜单与意图卡排版｜⋮ 菜单保留重复次级标签、缺分区线与矮视口内滚兜底，待解释引用卡超长引文未限高，联网授权框默认聚焦拒绝键且非视频页空输入仍显伴看图标

- 用户影响：`⋮` 更多菜单内同时展示三项排朗滑块与「更多显示设置」且各区之间缺少分隔线，在极矮浏览器窗口下菜单无内滚兜底；引用字幕句子追问时若选区文本很长，待解释引用卡会撑占大片可视区；首次开启联网搜索弹出的确认框默认焦点落在「关闭联网搜索」拒绝按钮上；在非视频页上下文空输入框下仍展示「开启实时伴看」麦克风图标。
- 代码证据：`extension/ui/ui-renderer.ts:129-189` 与 `extension/entry/styles/reader-chat.css:3217-3313` 中 `.biliscript-reading-chat-more-menu` 未设置区隔线及 `max-height`/`overflow-y: auto`；`extension/entry/styles/reader.css:1609-1615` 的 `.biliscript-reading-chat-intent-quote` 未限制 `max-height` 与滚动；`extension/search/opt-in-notice.ts:91-99` 复用 `extension/ui/confirm-dialog.ts:178-186` 将 `initialFocus` 设为 `cancel ?? dialog`；`extension/reader/chat-tab-composer.ts:113-119` 与 `extension/reader/chat-tab.ts:430-432` 未排除非视频页上下文即向空输入主按钮添加 `.is-live`。

#### M5-P3-05｜实时伴看微细节｜工具记录进行中双文案冗余、浮窗提示缺断词、换片胶囊文案被音轨回调提前冲掉、直播间通知缺 role="status"

- 用户影响：伴看委托文本模型分析进行中，状态栏记录会同时出现「正在生成…」与「文本模型正在整理结果」两句相似提示；浮窗内含长链接或超长标题的通知条缺少断词约束；视频切 P 或换片后，迷你胶囊原本展示 4 秒的换片提示文案可能被随后到达的音轨状态回调提前覆盖为「正在伴看」；直播间控制栏浮出提示未带无障碍状态角色，读屏无法自动播报。
- 代码证据：`extension/reader/chat-live-text-records.ts:25-28,44-46,62,67` 在 `status === "running"` 且无 `summary` 时同时输出 `statusLabel`（「正在生成…」）与兜底摘要（「文本模型正在整理结果」）；`extension/entry/styles/player-ai.css:1170-1175` 的 `.live-overlay-interpret-notice` 缺少 `overflow-wrap: anywhere` / `word-break: break-word`；`extension/live/fullscreen-live-overlay.ts:862-873,979-984` 与 `extension/live/live-overlay-binding.ts:324-327` 中 `showVideoContextSwitch` 写入的 `miniCapsuleStatusTextEl.textContent` 会在定时恢复前被 `onVideoAudioStatusChange` 触发的 `overlay?.syncState()` 覆写；`extension/live/live-room-entry.ts:83-92` 的 `showNotice` 未为 `.biliscript-live-room-notice` 设置 `role="status"` 或 `aria-live`。
