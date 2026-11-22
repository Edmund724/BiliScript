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

const ALLOWED_SETTER_ARITY = {
  duration: 1,
  style: 2,
  attr: 2,
  text: 1,
  html: 1,
  remove: 0
};

function failUnsupportedTransition(detail) {
  throw new Error(
    `vendor-d3-slim: ${detail}；当前瘦身替身仅支持无回调终态写入（duration/style/attr/text/html/remove/selection），请复核 Mermaid 依赖的 d3-transition 方法面`
  );
}

function assertSetterArgs(method, args) {
  const min = ALLOWED_SETTER_ARITY[method];
  if (args.length < min || (min >= 1 && args[min - 1] === undefined)) {
    failUnsupportedTransition(
      `transition.${method}() 仅支持 setter 形式（需至少 ${min} 个已定义参数，实际 ${args.length} 个）`
    );
  }
}

function instantTransition(sel) {
  const methods = {
    duration() {
      assertSetterArgs("duration", arguments);
      return proxy;
    },
    style(name, value, priority) {
      assertSetterArgs("style", arguments);
      sel.style(name, value, priority);
      return proxy;
    },
    attr(name, value) {
      assertSetterArgs("attr", arguments);
      sel.attr(name, value);
      return proxy;
    },
    text(value) {
      assertSetterArgs("text", arguments);
      sel.text(value);
      return proxy;
    },
    html(value) {
      assertSetterArgs("html", arguments);
      sel.html(value);
      return proxy;
    },
    remove() {
      sel.remove();
      return proxy;
    },
    selection() {
      return sel;
    }
  };
  const proxy = new Proxy(methods, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON" || prop in Object.prototype) {
        return Reflect.get(target, prop, receiver);
      }
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        return target[prop];
      }
      return () => failUnsupportedTransition(`transition.${String(prop)}() 不受支持`);
    }
  });
  return proxy;
}

selection.prototype.transition = function transition(name) {
  if (arguments.length > 0 && name !== undefined) {
    failUnsupportedTransition("selection.transition(name) 具名或继承过渡不受支持");
  }
  return instantTransition(this);
};

selection.prototype.interrupt = function interrupt() {
  failUnsupportedTransition("selection.interrupt() 不受支持");
};
