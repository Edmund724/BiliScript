// model-select-width.ts — 模型 chip 宽度度量（候选09 自 sidepanel.js 迁出；
// 工单 arch-review-2026-09/10 自 ui/ 搬入 chat/；发送框重构起度量对象从原生
// select 换成模型 chip——chip 是隐藏 select 的展示层，宽度按内容自适应）。
//
// 纯 UI 度量叶子（零 import）：用离屏 canvas 按当前计算字体测量 chip 文案宽
// （模型名 + 档位），叠加 44px 装饰余量（左右 padding 20 + chevron 14 + 两个
// flex gap 8，另留 2px buffer），再夹在 [92, 420] 区间内，结果写回 chip 的内联
// width。420 只防极端长名——正常状态 hug content；
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

let modelSelectMeasureCanvas: HTMLCanvasElement | null = null;
let modelSelectWidthRafId = 0;
let pendingModelSelectWidthEls: ModelSelectWidthEls | null = null;

// rAF 合帧入口（P2-3，仓内 reader/digest-host.ts 的 scheduleDigestLayout 先例）：
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

// 挂起帧无需显式作废：els 指向的壳元素随阅读模式常驻，帧回调执行时目标仍有效；
// 会话关闭只是断流，不拆 DOM。
export function updateModelSelectWidth(els: ModelSelectWidthEls): void {
  if (!els.chip) {
    return;
  }
  const model = String(els.chipModel?.textContent || "").trim() || "未配置平台";
  const level = String(els.chipLevel?.textContent || "").trim();
  const text = level ? `${model} ${level}` : model;
  const computedStyle = window.getComputedStyle(els.chip);
  const measuredTextWidth = measureTextWidth(text, computedStyle);
  // 装饰余量 = 左右 padding 20 + chevron 14 + 两个 flex gap 8，另留 2px buffer；
  // 旧实现叠加的 "000" 兜底宽是原生 select 时代的遗留，chip hug content 后
  // 只会在 chevron 右侧留出多余空白，已移除。
  const desiredWidth = Math.ceil(measuredTextWidth + 44);
  const minWidth = 92;
  const nextWidth = Math.max(minWidth, Math.min(desiredWidth, MODEL_CHIP_MAX_WIDTH));
  els.chip.style.width = `${nextWidth}px`;
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
