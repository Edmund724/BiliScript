// ui/toggle-switch.ts — 设置抽屉持久布尔开关的自绘开关组件（ADR-0019）。
//
// 组件边界：只有设置抽屉里 5 个持久设置布尔开关用本组件；操作型复选框
//（provider 行的全选等）保持原生。原生 <input type="checkbox"> 仍是值源与
// 事件链——collect* 照读 .checked，即时保存监听照收 change——组件只做展示
// 与手势：轨道 + 滑块是 label 内的装饰元素，原生 input 视觉隐藏（clip，不
// display:none）留在 Tab 序与无障碍树里，键盘 Space 与读屏语义零自建。
//
// 手势三路（与原生行为互补，不重复造切换）：
// - 点击（非拖拽）：走原生 label→input 激活，change 事件驱动弹簧动画；
// - 键盘 Space：原生切换 + change，同一弹簧路径；
// - 拖拽（Pointer Events + pointer capture）：滑块跟手，松手按「位置过半 +
//   松手速度加权」（iOS 行为）决定吸附侧并弹簧到位；吸附结果与现态不同才
//   翻转 input.checked 并派发 bubbling change——拖拽本身不重复触发表单切换。
//
// 动效：滑块位置由手写 RAF 弹簧积分器驱动（stiffness/damping 半隐式欧拉，
// 轻微过冲回弹）；prefers-reduced-motion 下全部退化为瞬时吸附，无动画。
//
// 组件表随组件走（custom-select.css 同款先例）：模块求值即挂
// ensureToggleSwitchStyles，不依赖设置抽屉的装载时机。
import { ensureToggleSwitchStyles } from "../shared/style-injector.js";

ensureToggleSwitchStyles();

// 弹簧参数（真弹簧，非 CSS 曲线近似）：ζ ≈ 0.7 欠阻尼——滑向目标时轻微
// overshoot 回弹，iOS 开关的观感档。K/C 单位分别为 1/s² 与 1/s。
const SPRING_STIFFNESS = 600;
const SPRING_DAMPING = 34;
// 单帧步长上限：切后台回来不爆步长（dt 截到 1/30s）。
const MAX_FRAME_DT = 1 / 30;
// 吸附判定的速度加权投影时长（ms）：松手速度按 120ms 外推落点，落点过半
// 即吸向该侧——快甩短程也能翻过去，慢拖看位置。iOS 开关同款行为。
const VELOCITY_PROJECTION_MS = 120;
// 拖拽跟手阈值：pointermove 位移小于该值视为点击抖动，仍走原生点击路径。
const DRAG_THRESHOLD_PX = 3;

// 滑块行程兜底值：轨道 40 - 滑块 20.8 - 两侧内边距各 1.6 = 16。jsdom / 无布局
// 环境 clientWidth 为 0，几何量不出时按设计尺寸走。
const FALLBACK_TRAVEL_PX = 16;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

// 已初始化开关的壳内部操作（initToggleSwitch 建壳时登记）：
// - sync：按 input.checked 现值吸附滑块（弹簧或瞬时），外部程序化写值
//  （loadSettings 水合 / watchStorageKeys 回读）后经这里回流视觉。
// 未初始化的 input 查不到，退化为 no-op。
const shellOps = new WeakMap<HTMLInputElement, { sync: () => void }>();

// 外部写值的视觉回流入口：settings-panel 的水合与 storage 回读直接写
// .checked（值源语义不变，零事件），视觉侧由此吸附到现值。不派发 change——
// 与 custom-select 的 setCustomSelectValue 同口径：change 只属于用户手势。
export function syncToggleSwitch(input: HTMLInputElement): void {
  shellOps.get(input)?.sync();
}

// 初始化一个开关（幂等，dataset.toggleSwitchInitialized 使重复调用直接返回）。
// 模板（settings-panel-html.ts）已备好壳结构：
//   <div class="biliscript-set-check biliscript-toggle-row">
//     <span class="biliscript-toggle-text">…</span>
//     <label class="biliscript-toggle-switch">
//       <input type="checkbox" class="biliscript-toggle-input" />
//       <span class="biliscript-toggle-track"><span class="biliscript-toggle-thumb"></span></span>
//     </label>
//   </div>
// 本函数只接线手势与动画，不重建 DOM；input 与 track 必须是相邻兄弟
//（CSS 的 :checked ~ .biliscript-toggle-track 配色选择器依赖这个次序）。
export function initToggleSwitch(input: HTMLInputElement): void {
  if (input.dataset.toggleSwitchInitialized === "1") return;
  const track = input.nextElementSibling;
  if (!(track instanceof HTMLElement) || !track.classList.contains("biliscript-toggle-track")) {
    return;
  }
  const thumb = track.firstElementChild;
  if (!(thumb instanceof HTMLElement)) return;
  input.dataset.toggleSwitchInitialized = "1";
  // 拖拽松手后的 click 抑制按 label 边界判定（见 finishDrag）。
  const label = input.closest("label");

  // 滑块行程：轨道内容盒宽 - 滑块宽 - 两侧内边距（各 1.6px）。每次取用现量，
  // 面板宽度变化（窄容器适配）后吸附目标仍是正确几何。滑块宽用
  // getBoundingClientRect 而非 offsetWidth：20.8 的小数宽会被 offsetWidth 向上
  // 取整成 21（40-21-4=15 ≠ 16），rect 保小数值才量得准。
  const travel = (): number => {
    const measured = track.clientWidth - thumb.getBoundingClientRect().width - 3.2;
    return measured > 0 ? measured : FALLBACK_TRAVEL_PX;
  };

  // 弹簧积分器状态：pos 滑块 X（0..travel），vel px/s，raf 非零即在飞。
  let pos = input.checked ? travel() : 0;
  let vel = 0;
  let raf = 0;

  // 用 2D translateX 而非 translate3d：静止时不创建独立合成层，滑块与轨道在同一
  // 绘制域做设备像素取整——分数倍率（Windows 125%/150%）下各行 Y 坐标小数部分
  // 不同，分层取整会把同一 CSS 几何渲染成有的行居中、有的行偏下（真机实测）。
  // X 向弹簧动画期间浏览器仍会做短暂合成（transform 动画），亚像素残差被运动掩盖。
  const apply = (): void => {
    thumb.style.transform = pos === 0 ? "none" : `translateX(${pos}px)`;
  };
  apply();

  const settle = (): void => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const springTo = (target: number, initialVel = 0): void => {
    settle();
    if (prefersReducedMotion()) {
      pos = target;
      vel = 0;
      apply();
      return;
    }
    pos = Math.min(Math.max(pos, 0), travel());
    vel = initialVel;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min((now - last) / 1000, MAX_FRAME_DT);
      last = now;
      const accel = -SPRING_STIFFNESS * (pos - target) - SPRING_DAMPING * vel;
      vel += accel * dt;
      pos += vel * dt;
      apply();
      if (Math.abs(pos - target) < 0.05 && Math.abs(vel) < 5) {
        pos = target;
        vel = 0;
        apply();
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  // 按现值吸附（外部写值回流；未在拖拽中时也可作 change 路径的统一收口）。
  const sync = (): void => springTo(input.checked ? travel() : 0);

  // change 三来路：原生点击（label 激活 / 轨道点击冒泡）、键盘 Space、拖拽
  // 松手后的程序化翻转。前两者需要弹簧动画；拖拽路径在松手处已带松手速度
  // 起弹，这里早退避免把 fling 速度清掉。
  let dragHandledChange = false;
  input.addEventListener("change", () => {
    if (dragHandledChange) return;
    sync();
  });

  // 拖拽状态：dragging 期间 change 监听不重复动画；moved 区分点击与拖拽
  //（未过阈值的 pointerup 留给原生 click 路径，组件不动）。
  let dragging = false;
  let moved = false;
  let startClientX = 0;
  let startPos = 0;
  // 跟手速度采样：最近两个 move 样本算 px/ms；不足两份按 0（位置判定兜底）。
  let samples: { x: number; t: number }[] = [];

  const releaseVelocity = (endEvent: Event): number => {
    const end = samples[samples.length - 1];
    const prev = samples[samples.length - 2];
    if (!end || !prev) return 0;
    const dt = end.t - prev.t;
    if (dt <= 0) return 0;
    return (end.x - prev.x) / dt;
  };

  track.addEventListener("pointerdown", (e) => {
    if (input.disabled) return;
    dragging = true;
    moved = false;
    startClientX = e.clientX;
    startPos = pos;
    samples = [{ x: e.clientX, t: e.timeStamp }];
    settle();
    // capture 让 move/up 不论指针滑出轨道都回到 track 上；个别环境无该 API
    //（jsdom）时事件本就以 track 为目标派发，行为一致。
    try {
      track.setPointerCapture?.(e.pointerId);
    } catch {
      // 指针已释放等场景 capture 会抛，拖拽降级为无 capture 跟随。
    }
    // 不 preventDefault：pointerdown 的默认动作取消会连带吞掉兼容 click，
    // 点击路径（label 原生激活）就断了。拖选由组件表的 user-select: none 挡。
  });

  track.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startClientX;
    if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    moved = true;
    pos = Math.min(Math.max(startPos + dx, 0), travel());
    apply();
    samples.push({ x: e.clientX, t: e.timeStamp });
    if (samples.length > 4) samples.shift();
  });

  const finishDrag = (e: Event): void => {
    if (!dragging) return;
    dragging = false;
    if (!moved) return; // 点击：原生 click 即将激活 input，组件不插手。
    samples.push({ x: (e as PointerEvent).clientX ?? samples[samples.length - 1]?.x ?? 0, t: e.timeStamp });
    const vPxMs = releaseVelocity(e);
    const range = travel();
    // 位置 + 速度加权：速度按投影时长外推落点，落点过半吸向该侧。
    const projected = pos + vPxMs * VELOCITY_PROJECTION_MS;
    const target = projected >= range / 2 ? range : 0;
    // 拖拽松手后同一次手势还会派发一个 click（落在 label 内就触发原生激活，
    // 把刚吸附的结果翻回去）。document capture 处拦：只在点击目标仍在本 label
    // 内时 preventDefault；无论 click 落哪都会自我摘除，不留下误伤后续点击的
    // 埋伏。pointercancel 不产生 click，不拦。
    if (e.type === "pointerup") {
      const suppress = (clickEvent: Event): void => {
        document.removeEventListener("click", suppress, true);
        if (label && clickEvent.target instanceof Node && label.contains(clickEvent.target)) {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        }
      };
      document.addEventListener("click", suppress, { capture: true });
    }
    const nextChecked = target === range;
    if (input.checked !== nextChecked) {
      dragHandledChange = true;
      input.checked = nextChecked;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      dragHandledChange = false;
    }
    springTo(target, vPxMs * 1000);
  };

  track.addEventListener("pointerup", finishDrag);
  track.addEventListener("pointercancel", finishDrag);

  shellOps.set(input, { sync });
}
