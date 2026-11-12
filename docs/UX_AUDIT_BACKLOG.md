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
