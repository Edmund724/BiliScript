// model-select-width.ts — 模型 chip 宽度度量（候选09 自 sidepanel.js 迁出；
// 工单 arch-review-2026-09/10 自 ui/ 搬入 chat/；发送框重构起度量对象从原生
// select 换成模型 chip——chip 是隐藏 select 的展示层，宽度按内容自适应）。
// 发送框紧凑化起本模块还导出模型面板宽度度量 measureModelPanelWidth：面板从
// chip 上方呼出，宽度跟 chip 的**可见宽**（渲染宽）而非内容度量宽。
//
// 纯 UI 度量叶子（零 import）：用离屏 canvas 按当前计算字体分别测量 chip 的
// 模型名与档位宽（DOM 里两者之间是 4px flex gap，不整串测），叠加 44px 装饰余量
// （左右 padding 20 + 两个 gap 8 + chevron 14，另留 2px buffer），再夹在
// [92, 420] 区间内，结果写回 chip 的内联 width。420 只防极端长名——正常状态
// hug content；
// 溢出截断由 CSS 施加在模型名 span 上（档位与 chevron 恒完整，不进截断流）。
// canvas 不可用（getContext 返回 null）时退化为每字符 8px 估算，行为与迁出前一致。
//
// 依赖方向：无——消费方（对话组合根/providers 工厂）在 change/resize/渲染三个
// 调用点传入其模块级 `els` 引用包（chip/chipModel/chipLevel），本模块不反向
// 依赖任何页面模块，可在 jsdom 下直接单测。

// 消费方模块级 els 引用包中本模块关心的字段；均可缺省（缺省时走兜底分支：
// 无 chip 直接返回，模型名缺失用「未配置平台」参与测量）。
export interface ModelSelectWidthEls {
  chip?: HTMLElement | null;
  chipModel?: HTMLElement | null;
  chipLevel?: HTMLElement | null;
}

// 宽度上限：只防极端长模型名把 chip 撑爆；正常内容永远到不了（hug content）。
const MODEL_CHIP_MAX_WIDTH = 420;

// chip 宽度下限：低于此值连「Off」档位都挤。
const MODEL_CHIP_MIN_WIDTH = 92;

// 模型面板宽度区间（发送框紧凑化）：下限保「思考 Off/Low/High」一行放得下
// （chip 的 92 下限对面板太窄，档位行会横向溢出），上限防面板在宽对话列里
// 占满整列——面板跟的是 chip 可见宽，正常落在区间内。
const MODEL_PANEL_MIN_WIDTH = 240;
const MODEL_PANEL_MAX_WIDTH = 320;

let modelSelectMeasureCanvas: HTMLCanvasElement | null = null;
let modelSelectWidthRafId = 0;
let pendingModelSelectWidthEls: ModelSelectWidthEls | null = null;

// rAF 合帧入口（P2-3，仓内 reader/script-host.ts 的 scheduleScriptLayout 先例）：
// resize 一帧内可触发多次，直接调用 updateModelSelectWidth 会让「读布局
// （clientWidth/offsetWidth）→ 写内联 width」在每次事件上各跑一遍，反复强制
// 布局。此处置脏 + 一帧至多跑一次，读写各发生一次。同帧重复调度以最后一次
// 传入的 els 为准（rAF 只认 fn 引用，不认形参，故显式存最新 els）。
export function scheduleModelSelectWidthUpdate(els: ModelSelectWidthEls): void {
  pendingModelSelectWidthEls = els;
  if (modelSelectWidthRafId) {
    return;
  }
  modelSelectWidthRafId = window.requestAnimationFrame(() => {
    modelSelectWidthRafId = 0;
    const target = pendingModelSelectWidthEls;
    pendingModelSelectWidthEls = null;
    if (target) {
      updateModelSelectWidth(target);
    }
  });
}

// chip 的内容宽 = canvas 度量 + 44 装饰余量（未夹取）：chip 自身按 [92, 420] 夹，
// 面板回落分支按 [240, 320] 夹，两侧共用同一份度量。
function measureChipContentWidth(els: ModelSelectWidthEls): number {
  const model = String(els.chipModel?.textContent || "").trim() || "未配置平台";
  const level = String(els.chipLevel?.textContent || "").trim();
  const computedStyle = els.chip ? window.getComputedStyle(els.chip) : null;
  // 模型名与档位分开测量（不能整串测：DOM 里两者之间是 4px flex gap 而非空格
  // 字形，整串测会把空格宽也计进内容，多出的 ~5px 全部落在 chevron 右侧）。
  const measuredTextWidth =
    measureTextWidth(model, computedStyle) + (level ? measureTextWidth(level, computedStyle) : 0);
  // 装饰余量 = 左右 padding 20 + 两个 flex gap 8 + chevron 14，另留 2px buffer；
  // 旧实现叠加的 "000" 兜底宽是原生 select 时代的遗留，chip hug content 后
  // 只会在 chevron 右侧留出多余空白，已移除。
  return Math.ceil(measuredTextWidth + 44);
}

// 挂起帧无需显式作废：els 指向的壳元素随阅读模式常驻，帧回调执行时目标仍有效；
// 会话关闭只是断流，不拆 DOM。
export function updateModelSelectWidth(els: ModelSelectWidthEls): void {
  if (!els.chip) {
    return;
  }
  const desiredWidth = measureChipContentWidth(els);
  const nextWidth = Math.max(MODEL_CHIP_MIN_WIDTH, Math.min(desiredWidth, MODEL_CHIP_MAX_WIDTH));
  els.chip.style.width = `${nextWidth}px`;
}

// 模型面板宽度（发送框紧凑化）：面板从 chip 上方呼出、右缘对齐 chip 右缘，宽度
// 跟 chip 的**可见宽**——即用户在输入行里看到的「模型名显示区域」（flex 挤压 +
// 省略号之后的渲染宽），而不是内容度量宽（长名一律撞 420，面板会宽出可见 chip
// 一大截）。可见宽取不到（jsdom 无布局、或调用时 chip 尚未布局为 0）时回落
// 内容度量宽（与 chip 宽度同源）。结果夹在 [240, 320]。
// 调用方（chat-model-panel 打开面板时）取一次值写内联宽——打开期间不跟随，避免
// 点档位改 chip 文案时面板宽度抖动。
export function measureModelPanelWidth(els: ModelSelectWidthEls): number {
  const visibleWidth = els.chip ? els.chip.getBoundingClientRect().width : 0;
  const source = visibleWidth > 0 ? visibleWidth : measureChipContentWidth(els);
  return Math.max(MODEL_PANEL_MIN_WIDTH, Math.min(Math.ceil(source), MODEL_PANEL_MAX_WIDTH));
}

export function measureTextWidth(text: string, style?: CSSStyleDeclaration | null): number {
  if (!modelSelectMeasureCanvas) {
    modelSelectMeasureCanvas = document.createElement("canvas");
  }
  const ctx = modelSelectMeasureCanvas.getContext("2d");
  if (!ctx) {
    return text.length * 8;
  }
  const fontStyle = style?.fontStyle || "normal";
  const fontVariant = style?.fontVariant || "normal";
  const fontWeight = style?.fontWeight || "400";
  const fontSize = style?.fontSize || "11px";
  const fontFamily = style?.fontFamily || "sans-serif";
  ctx.font = `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
  return ctx.measureText(text).width;
}
