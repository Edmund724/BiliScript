// extension/reader/quote-share-spring.ts
// 阻尼弹簧物理模拟器（刚度 70，阻尼比 0.86），用于卡片悬停微视差与平滑回弹。

export interface SpringConfig {
  stiffness?: number; // 默认 70
  dampingRatio?: number; // 默认 0.86（略欠阻尼，有机柔和回弹）
  precision?: number; // 位移停稳阈值，默认 0.002
  velocityPrecision?: number; // 速度停稳阈值，默认 0.005
}

export interface SpringPoint2D {
  x: number;
  y: number;
}

export interface SpringState2D {
  current: SpringPoint2D;
  target: SpringPoint2D;
  velocity: SpringPoint2D;
  settled: boolean;
}

export interface Spring2DInstance {
  setTarget(x: number, y: number): void;
  snapTo(x: number, y: number): void;
  step(dt: number): SpringState2D;
  start(onUpdate: (pos: SpringPoint2D) => void, onComplete?: () => void): void;
  stop(): void;
  isSettled(): boolean;
  getState(): SpringState2D;
}

export interface CreateSpring2DOptions extends SpringConfig {
  initial?: SpringPoint2D;
  onUpdate?: (pos: SpringPoint2D) => void;
  onComplete?: () => void;
}

/**
 * 计算欠阻尼/临界阻尼弹簧在 dt 秒步进后的解析解。
 * 基于单自由度二阶线性阻尼系统解析积分，数值绝对稳定，不受帧率波动影响。
 */
export function solveSpring1D(
  current: number,
  velocity: number,
  target: number,
  dt: number,
  stiffness = 70,
  dampingRatio = 0.86
): [newPos: number, newVel: number] {
  if (dt <= 0) {
    return [current, velocity];
  }

  // 状态平移至以 target 为原点
  const p0 = current - target;
  const v0 = velocity;

  const w0 = Math.sqrt(Math.max(0.0001, stiffness));
  const alpha = dampingRatio * w0;

  if (dampingRatio < 1) {
    // 欠阻尼情况（本系统标准配置：dampingRatio = 0.86）
    const wd = w0 * Math.sqrt(1 - dampingRatio * dampingRatio);
    const decay = Math.exp(-alpha * dt);
    const cosVal = Math.cos(wd * dt);
    const sinVal = Math.sin(wd * dt);

    const b = (v0 + alpha * p0) / wd;
    const pNew = decay * (p0 * cosVal + b * sinVal);
    const vNew = -alpha * pNew + decay * (-p0 * wd * sinVal + (v0 + alpha * p0) * cosVal);

    return [target + pNew, vNew];
  }

  if (dampingRatio === 1) {
    // 临界阻尼情况
    const decay = Math.exp(-alpha * dt);
    const c1 = p0;
    const c2 = v0 + alpha * p0;
    const pNew = decay * (c1 + c2 * dt);
    const vNew = decay * (v0 - alpha * c2 * dt);
    return [target + pNew, vNew];
  }

  // 过阻尼情况
  const w1 = w0 * Math.sqrt(dampingRatio * dampingRatio - 1);
  const r1 = -alpha + w1;
  const r2 = -alpha - w1;
  const c2 = (v0 - r1 * p0) / (r2 - r1);
  const c1 = p0 - c2;
  const pNew = c1 * Math.exp(r1 * dt) + c2 * Math.exp(r2 * dt);
  const vNew = c1 * r1 * Math.exp(r1 * dt) + c2 * r2 * Math.exp(r2 * dt);
  return [target + pNew, vNew];
}

/**
 * 创建 2D 弹簧物理模拟器实例。
 */
export function createSpring2D(options: CreateSpring2DOptions = {}): Spring2DInstance {
  const stiffness = options.stiffness ?? 70;
  const dampingRatio = options.dampingRatio ?? 0.86;
  const precision = options.precision ?? 0.002;
  const velPrecision = options.velocityPrecision ?? 0.005;

  let currentX = options.initial?.x ?? 0;
  let currentY = options.initial?.y ?? 0;
  let targetX = currentX;
  let targetY = currentY;
  let velX = 0;
  let velY = 0;
  let settled = true;

  let rafId: number | null = null;
  let lastTimestamp = 0;
  let activeOnUpdate = options.onUpdate;
  let activeOnComplete = options.onComplete;

  function isSettled(): boolean {
    return settled;
  }

  function getState(): SpringState2D {
    return {
      current: { x: currentX, y: currentY },
      target: { x: targetX, y: targetY },
      velocity: { x: velX, y: velY },
      settled
    };
  }

  function snapTo(x: number, y: number): void {
    currentX = x;
    currentY = y;
    targetX = x;
    targetY = y;
    velX = 0;
    velY = 0;
    settled = true;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function setTarget(x: number, y: number): void {
    if (targetX === x && targetY === y) {
      return;
    }
    targetX = x;
    targetY = y;
    settled = false;
    ensureRunning();
  }

  function step(dt: number): SpringState2D {
    if (settled) {
      return getState();
    }

    // 钳制单步时间上限为 64ms（防止切后台恢复后超大步长造成跳帧）
    const safeDt = Math.max(0.001, Math.min(0.064, dt));

    const [nextX, nextVx] = solveSpring1D(currentX, velX, targetX, safeDt, stiffness, dampingRatio);
    const [nextY, nextVy] = solveSpring1D(currentY, velY, targetY, safeDt, stiffness, dampingRatio);

    currentX = nextX;
    velX = nextVx;
    currentY = nextY;
    velY = nextVy;

    const diffX = Math.abs(currentX - targetX);
    const diffY = Math.abs(currentY - targetY);
    const speedX = Math.abs(velX);
    const speedY = Math.abs(velY);

    if (diffX < precision && diffY < precision && speedX < velPrecision && speedY < velPrecision) {
      currentX = targetX;
      currentY = targetY;
      velX = 0;
      velY = 0;
      settled = true;
    }

    return getState();
  }

  function tick(timestamp: number): void {
    if (lastTimestamp === 0) {
      lastTimestamp = timestamp;
    }
    const dt = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    const state = step(dt);
    activeOnUpdate?.(state.current);

    if (state.settled) {
      rafId = null;
      lastTimestamp = 0;
      activeOnComplete?.();
      return;
    }

    rafId = requestAnimationFrame(tick);
  }

  function ensureRunning(): void {
    if (rafId === null && typeof requestAnimationFrame === "function") {
      lastTimestamp = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  function start(onUpdate: (pos: SpringPoint2D) => void, onComplete?: () => void): void {
    activeOnUpdate = onUpdate;
    if (onComplete !== undefined) {
      activeOnComplete = onComplete;
    }
    if (!settled) {
      ensureRunning();
    }
  }

  function stop(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastTimestamp = 0;
  }

  return {
    setTarget,
    snapTo,
    step,
    start,
    stop,
    isSettled,
    getState
  };
}
