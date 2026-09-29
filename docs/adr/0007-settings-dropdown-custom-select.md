# 设置页下拉选择器统一到 custom-select 组件，放弃原生 select

> 状态：有效｜带重开条件

设置页视觉统一（settings-ui-coherence 轮）收尾时，页面上还剩最后一个原生下拉「正文附加段落 - 段落位置」，它与已换壳的「下载格式」、Modal ASR 预设形成两族 affordance：原生一族渐变三角、自定义一族 chevron。我们决定：**设置页所有下拉选择器统一到 `custom-select` 组件**（`ui/custom-select.ts`），段落位置一并换壳；代价是原生 select 自带的键盘与读屏语义改由组件自担——listbox 键盘（↑/↓ 漫游不循环、Home/End、Enter/Space 开合与选中、Esc 归焦、Tab 穿行）+ ARIA（`aria-haspopup/expanded/controls`、`role=listbox/option`、`aria-selected`，选项以程序化 focus 漫游），不做首字符 typeahead（选项都是 3~5 项短列表）。

## 考虑过的方案

- **A1：接受两族并存**（原生 select 保留渐变三角，自定义下拉用 chevron）：省掉组件的 a11y 维护，但与本轮统一目的相反，且段落位置会成为页面上唯一键控体验不同的控件。（原编号 A2 的「换组件」案即本文决议，不再作为备选列出。）
- **A3：保留原生 select，用 CSS 把渐变三角重画成 chevron**：不引入组件维护成本，但两条细渐变拼出的 V 不可读，且渐变色只能写死 fallback——读不到 CSS 变量的 `background-image` 在深色档失配。

## 后果

- 原生 select 仍是值源与收集链：`collect*` 系列照读 `select.value`，组件写回值并派生 bubbling `change`，收集与校验逻辑零改。
- 隐藏正确性依赖 03 的提权规则：`.custom-select-hidden` 的尺寸/描边由宿主前置规则覆盖回，不依赖 clip 兜底；新增下拉来路必须落在带该提权的选择器域内。
- 页面上多一份非原生控件的 a11y 维护责任：键盘与 ARIA 语义收在 `custom-select.ts` 单文件内，三处调用点（下载格式、Modal ASR 预设、段落位置）共用；模型选择不套本方案——它是可输入的 combobox 语义，硬套 listbox 会误导读屏。
- 校验失败的 `input-error` 与焦点落在组件壳（`.custom-select-trigger`）上，原生 select 已被隐藏，直接标错会掉 1px 黑洞。

## 重开条件

若自定义下拉的读屏/键控体验明显劣于原生（实测口径：读屏念得出当前值与角色、纯键盘能改值），退回 A1 并接受两族 affordance。决策与验收记录见 commit 5a4f28b。

**这条出路已被外观否决**（2026-09-29，真机对照）：原生 select 的弹层由浏览器/系统绘制，圆角、行高与高亮都不可定制，与设置页、编辑 Modal 内其余 12px 弹层不一致，实测观感不可接受（与 [provider-editor-modal.ts:606](extension/ui/provider-editor-modal.ts#L606) 记的同一条理由）。故判据不过时的出路改为**继续修组件**，不再回退 A1。

## 修订（日期：2026-09-29）

按上述判据做了一轮复核，发现三处实现缺陷并修复（commit `e65555a`，`tests/ui/custom-select.test.ts` 5 例结构核验）：

- 隐藏的原生 select 只是视觉隐藏（1px + overflow），仍留在 Tab 序与无障碍树里：同一设置会被念两遍，Tab 还会先停在看不见的那个上。补 `tabindex="-1"` + `aria-hidden="true"`；值源与 `collect*` 系列仍读 `.value`，零改。
- trigger 的可访问名只有当前值（「SRT，按钮」），字段名丢失——`label[for]` 指向的是那个已藏起来的 select。改用 `aria-labelledby` 指向「字段标签 + 当前值」两个节点（无 `for` 的 Modal 形态按同级前置 label 认），名字随值自动重算；label 的 `for` 一并重指到 trigger，点标签不再把焦点送进隐藏控件。
- Tab 从展开列表离开时，焦点落在已隐藏的 li 上会掉回 body，默认 Tab 于是从文档头重新起算。改为收拢列表并把焦点交还 trigger（不 preventDefault），默认动作从 trigger 续行。

**实测（2026-09-29，Chrome 无障碍树）**：取浏览器计算的 AX 树，折叠态的 trigger 为 `button`，名字 `下载格式 SRT`（字段标签 + 当前值），`hasPopup=listbox`、`expanded=false`；展开后出现 `listbox`（名字 `下载格式`、`orientation=vertical`）与两个 `option`（`SRT selected=true` / `TXT selected=false`）；隐藏的原生 select 不再出现在树里，全页只有这一份控件。纯键盘用真实 trusted `Tab` 事件核验：从展开的列表按 Tab 后 dropdown `hidden=true`、`aria-expanded=false`，焦点落在 trigger 之后的**下一个控件**（而不是文档头）——修复前它在已隐藏的 li 上掉回 body，默认 Tab 会从文档头重新起算。

仍未做的是**真读屏的语序/措辞实测**（NVDA/讲述人念出来的样子）：AX 树能证明控件名、角色与状态正确，不能证明读起来是否别扭。这是本条已知缺口。
