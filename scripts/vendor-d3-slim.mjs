// d3 瘦身 shim（体积裁剪）：mermaid 保留闭包（core 入口 + flowchart/sequence/
// dagre 可达 chunk）对 d3 umbrella 的具名 import 只有 select 与 d3-shape 的
// line/曲线族——chunk-75Z2AOVW 顶层 d3CurveTypes 映射（flowchart 默认
// curve=basis，运行时真实使用，必须给真实现）。umbrella 其余成员
// （transition/brush/zoom/force/geo…）只为已裁剪图类型服务，随 import 站点
// 消失；katex/iconify 同款先例见 vendor-iconify-stub.mjs。
//
// transition 只有 flow tooltip 一处（chunk-SHT3W25Y.mjs:560,565）：tooltip 初值
// opacity 0，靠 .transition().duration(n).style("opacity", …) 显隐。纯 no-op
// 会让 tooltip 永不出现，因此补丁策略是「立即应用终值、无动画」：style/attr
// 直接落到选中元素上，duration/delay/ease 等只保持链式可调用。200/500ms 的
// 淡入淡出退化为瞬时切换，tooltip 行为与数据流不崩。
//
// 经 esbuild alias（vendor-mermaid-slim.mjs 探针轮 + build-content.js 轮 B）
// 接入。构建守卫经 sourcemap sources 识别本文件。

import { select, selection } from "d3-selection";
import {
  line,
  curveBasis,
  curveBasisClosed,
  curveBasisOpen,
  curveBumpX,
  curveBumpY,
  curveBundle,
  curveCardinal,
  curveCardinalClosed,
  curveCardinalOpen,
  curveCatmullRom,
  curveCatmullRomClosed,
  curveCatmullRomOpen,
  curveLinear,
  curveLinearClosed,
  curveMonotoneX,
  curveMonotoneY,
  curveNatural,
  curveStep,
  curveStepAfter,
  curveStepBefore
} from "d3-shape";

export {
  select,
  line,
  curveBasis,
  curveBasisClosed,
  curveBasisOpen,
  curveBumpX,
  curveBumpY,
  curveBundle,
  curveCardinal,
  curveCardinalClosed,
  curveCardinalOpen,
  curveCatmullRom,
  curveCatmullRomClosed,
  curveCatmullRomOpen,
  curveLinear,
  curveLinearClosed,
  curveMonotoneX,
  curveMonotoneY,
  curveNatural,
  curveStep,
  curveStepAfter,
  curveStepBefore
};

// d3-transition 原版补丁的语义子集：transition() 返回链式对象，style/attr/text
// 立即写入选中元素（无动画），duration/delay/ease/on 仅保持链式。style/attr 只
// 实现 setter 形式——d3 的单参 getter 调用会把 undefined 写进样式；唯一调用点
//（flow tooltip 链）全是 setter 且为 mermaid 11.17.2 里的死路径，够用。
function instantTransition(sel) {
  const transition = {
    delay: () => transition,
    duration: () => transition,
    ease: () => transition,
    style(name, value, priority) {
      sel.style(name, value, priority);
      return transition;
    },
    attr(name, value) {
      sel.attr(name, value);
      return transition;
    },
    text(value) {
      sel.text(value);
      return transition;
    },
    html(value) {
      sel.html(value);
      return transition;
    },
    remove() {
      sel.remove();
      return transition;
    },
    on: () => transition,
    transition: () => instantTransition(sel),
    selection: () => sel,
    end: Promise.resolve()
  };
  return transition;
}

selection.prototype.transition = function transition() {
  return instantTransition(this);
};

selection.prototype.interrupt = function interrupt() {
  return this;
};
