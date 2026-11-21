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
