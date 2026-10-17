# 设置抽屉持久布尔开关自绘 iOS 风格开关（toggle-switch），操作型复选框保持原生

> 状态：有效

reader-settings-shell.css 的旧约定「设置表内不引入自定义替代控件，原生控件一律 accent-color 着色」在自定义下拉（ADR-0007）落地时已对 select 开过一次口子。设置抽屉的 5 个持久布尔开关（asrAutoFallback / enablePlayerAiQuickAction / includeDateInFilename / includeTimestampInBody / enableDebugLogs）仍用原生 checkbox：与已经自绘的下拉、iOS 风格的目标观感（Flyme token 体系）相比，原生 checkbox 的方框形态是设置抽屉里最后一处异质控件。我们决定：**把自绘边界画在「持久设置的布尔开关」上**——这一类允许自绘为 iOS 风格开关（`ui/toggle-switch.ts` 组件）；**操作型复选框**（provider 编辑/获取弹窗里的全选、选模型等）**保持原生**，不改。旧约定中「不引入自定义替代控件」的说法随本条废止，reader-settings-shell.css 的注释已按现状改写。

## 考虑过的方案

- **A1：5 个开关保持原生 checkbox（维持旧约定）**：零组件维护成本，但开关是设置抽屉里点击频率最高的控件，方框形态与已自绘的下拉、胶囊按钮不同族；且弹簧跟手拖拽这类手感原生控件给不了。
- **A2：抽屉内全部复选框自绘（含操作型）**：视觉彻底统一，但操作型复选框（全选/选模型）高信息密度、常以成组批量出现，自绘收益低、a11y 维护面翻倍——组件要为键盘/读屏补齐语义的地方从 5 处暴涨到十几处。
- **A3：CSS transition 近似弹簧（cubic-bezier 过冲曲线）**：`--biliscript-reader-ease-bounce` 这类曲线只能近似「滑向目标」，做不了**跟手拖拽**（滑块实时跟随光标 X）与松手速度加权的吸附判定；真弹簧必须手写积分器。

## 后果

- 原生 `<input type="checkbox">` 仍是值源与事件链：视觉隐藏（clip，非 display:none，留在 Tab 序与无障碍树）后，装载（回填 `.checked`）、保存（`collectFormPayload` 读 `.checked`）、即时保存（`asrAutoFallback` 的 change 监听）全部零改动。
- 手势三路分工：点击/键盘走原生 label→input 激活与 Space，change 事件驱动弹簧；拖拽走 Pointer Events（pointer capture 跟手），松手按「位置过半 + 松手速度加权」（iOS 行为）吸附，吸附结果与现态不同才翻转 checked 并派发 change——拖拽不重复触发表单切换。
- 动效是手写 RAF 弹簧积分器（stiffness 600 / damping 34，ζ≈0.7 轻微过冲），`prefers-reduced-motion` 下退化为瞬时吸附（JS 与 CSS 双侧）。
- 组件表 `entry/styles/toggle-switch.css` 随组件走（`ensureToggleSwitchStyles` 模块顶层挂载，custom-select.css 同款先例），行布局覆盖 `.biliscript-set-check` 度量靠更具体的选择器（组件表先于设置三件套挂载，同分比不过）。
- 新增样式表的三处登记（style-injector 路径 + ensure、构建侧 CSS 入口、manifest WAR 放行）按 ADR-0007 修订段的清单执行；构建侧 cssEntries 按目录派生无需登记，WAR 通配 `entry/styles/*` 已放行。
- 代价与 ADR-0007 同构：多一份非原生控件的键盘/读屏维护责任，收在 `ui/toggle-switch.ts` 单文件；真读屏语序实测仍是已知缺口（AX 树语义由原生 input 承担，风险低于 custom-select）。

## 重开条件

若自绘开关的读屏/键控体验劣于原生（实测口径：读屏念得出开关名与开关状态、纯键盘 Space 能切换），或拖拽手势在真机上误触/卡死不可修，退回 A1：5 处模板换回裸原生 checkbox，组件与组件表删除。
