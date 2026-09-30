# Flyme 动效参考（Alive Design 动效引擎 → Web 实现）

事实锚点，数值均为按真机观感的推导值：

- **Flyme 9 知意动效**：分层图标、惯性回弹、贝塞尔轨迹；图标动画化时壁纸实时缩放 + 模糊联动；动画中断后衔接自然。
- **Flyme 9.2**：应用未完全打开时可上滑关闭（打开动画可被打断）。
- **Flyme AIOS**：手势动效可打断（退出应用时点击桌面 / 桌面翻页、关闭文件夹并翻页、打开关闭应用）；物理引擎升级，下拉控制中心、切换应用回弹更真实；Alive 壁纸跟手渐变——下滑 / 收起通知面板时壁纸效果随滑动幅度逐渐变化。

一句话总纲：**任何手势驱动的动效 = 跟手阶段 1:1 线性驱动 + 松手瞬间把位置和速度交给弹簧。** 中间没有"播动画"状态，因此随时可打断。

## 1. 单进度源 — 一切联动从一个 p 出发

相关联的视觉变化（面板位移、壁纸模糊、遮罩透明度、时钟缩放）全部由同一个进度 `p ∈ [0,1]` 推导，不各自动画。这样手势接管时所有层天然同步，打断不留破绽。

```js
function render(p) { // p: 0 = 收起, 1 = 展开
  sheet.style.transform = `translate(-50%, ${-(1 - p) * 102}%)`;
  wallpaper.style.filter = `blur(${p * 24}px) saturate(${1 + p * 0.2})`;
  wallpaper.style.transform = `scale(${1.06 - p * 0.06})`; //  Alive 壁纸跟手渐变
  scrim.style.opacity = p * 0.35;
}
```

跟手阶段直接 `render(p)`（`transition: none`）；松手后把 `p` 和速度交给弹簧，弹簧每帧继续调 `render`。

## 2. 跟手 — 1:1 线性，记录速度史

- Pointer Events + `setPointerCapture`，指针划出元素也不断线。
- 8–10px  hysteresis 后才认领手势方向，此前不拦截点击。
- 跟手阶段 `transition: none`，每帧 1:1 写 transform——绝不在手势进行中用 CSS transition 追手指。
- 维护最近几次 pointermove 的 {t, y} 环形缓冲，松手时算速度（见 §5）。

```js
el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  trail = [{ t: e.timeStamp, y: e.clientY }];
  el.style.transition = 'none'; // 跟手阶段：线性，无惯性
});
```

## 3. 可打断 — 从屏幕上当前值起跳

- 转换期间不锁输入（不置 `pointer-events: none`）。
- 新动画永远从**表现值**（当前屏幕上读到的位置 / 进度）和**当前速度**起跳，不从逻辑目标值起跳——后者必跳变。
- 手势驱动的动效用 rAF 弹簧（§4），不用 CSS transition / `@keyframes`：它们无法带着速度中途换目标。
- 反向时不清零速度，把当前速度直接带进新弹簧（速度不连续 = "撞墙感"）。

官方明确的可打断场景，原型里优先演示：退出应用时点击桌面 / 桌面翻页、关闭文件夹并翻页、应用打开中途上滑关闭。

## 4. 弹簧 — 唯一允许的"播动画"

单文件原型不依赖动画库，用这个极简半隐式欧拉弹簧（返回取消函数 = 可打断）：

```js
function spring({ from, to, velocity = 0, stiffness = 300, damping = 34, onUpdate, onDone }) {
  let x = from, v = velocity, last, raf;
  const tick = (t) => {
    const dt = Math.min((t - last) / 1000, 0.032); last = t;
    v += (-stiffness * (x - to) - damping * v) * dt;
    x += v * dt;
    onUpdate(x, v);
    if (Math.abs(x - to) < 0.002 && Math.abs(v) < 0.02) { onUpdate(to, 0); onDone?.(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame((t) => { last = t; raf = requestAnimationFrame(tick); });
  return () => cancelAnimationFrame(raf);
}
```

阻尼比 ζ = damping / (2·√stiffness)。手感档位（位移归一化到 0–1 进度时）：

| 场景 | stiffness / damping | ζ | 手感 | CSS 近似（非手势场景才用） |
|------|--------------------|---|------|--------------------------|
| 默认（入场、弹窗、开关） | 340 / 37 | ≈1.0 | 干脆利落，无过冲 | `cubic-bezier(0.32, 0.72, 0, 1)` 200–350ms |
| 面板展开收起、应用切换、小窗 | 300 / 30 | ≈0.87 | 收尾一次小幅回稳 | `cubic-bezier(0.3, 1.2, 0.4, 1)` ≤350ms |
| 抛掷类（甩动卡片） | 260 / 24 | ≈0.74 | 明显一点弹性 | —（必须弹簧） |

回稳只允许一次：过冲幅度 ≤2%（位移折算 ≤8px）。无物理依据的弹跳、旋转不用（spinner 除外）。

## 5. 松手 — 速度交接 + 动量投影

松手瞬间两件事：用速度**投影落点**决定目标，把速度**原样交接**给弹簧当初速度。动画从手指的速度继续，没有接缝。

```js
function releaseVelocity(trail, now) { // px/s，取最近 100ms 窗口
  const recent = trail.filter(p => now - p.t < 100);
  if (recent.length < 2) return 0;
  const a = recent[0], b = recent[recent.length - 1];
  return (b.y - a.y) / (b.t - a.t) * 1000;
}

function project(v, d = 0.998) { return (v / 1000) * d / (1 - d); } // 指数衰减投影

const v = releaseVelocity(trail, e.timeStamp);
const landing = p + project(v) / range;          // 落在哪里，而不是停在哪里
const target = landing > 0.5 ? 1 : 0;            // 快甩时符号即决定方向
spring({ from: p, to: target, velocity: v / range, onUpdate: render });
```

判定用**速度方向 + 投影落点**，不用松手位置硬阈值：缓慢拖到 40% 松手应回去，快速轻甩 20% 也应过去。

## 6. 返回桌面 — 签名动效编排

退出应用返回桌面是 Flyme 最讲究的一段，四层同时发生：

1. **跟手**：上滑手势驱动窗口缩小（scale 1→图标大小）+ 圆角增大（0→20+px）+ 整体上移，全部由 §1 的 `p` 线性驱动。
2. **壁纸联动**：p 同时驱动壁纸 scale 1.06→1、blur 退到 0（Alive 壁纸跟手渐变）。
3. **松手**：投影判定回桌面还是返回应用；回桌面则窗口沿**贝塞尔弧线**（不是直线）飞向图标位置——中段横向偏移一点，先快后慢。
4. **分层图标收尾**：图标背景层先到位，前景（图形层）带 40–60ms 延迟用 ζ≈0.87 弹簧回稳，一次过冲；整行图标 20–30ms stagger 归位。

```js
// 飞向图标：FLIP 思路，目标 = 图标的屏幕 rect
const r = icon.getBoundingClientRect();
const s = r.width / winRect.width;
const dx = r.left + r.width / 2 - (winRect.left + winRect.width / 2);
const dy = r.top + r.height / 2 - (winRect.top + winRect.height / 2);
// scale、translate 各走一条弹簧；弧线 = 给 translateX 加一项随 p 衰减的横向偏移
```

反向（打开应用）是同一条路径倒放：图标分层弹起 → 窗口从图标放大铺开 → 壁纸放大 + 模糊。**进出场同路径、锚点永远是触发它的图标。**

## 7. 下拉控制中心 / 通知中心

- 下拉 1:1 跟手，面板、壁纸模糊、顶部时钟由同一 p 驱动；上滑收起同理，滚动到顶后继续上滑才接管（面板内容可滚动时）。
- 松手投影判定展开 / 收起；展开收尾 ζ≈0.87 一次回稳（AIOS 物理引擎卖点）。
- 展开 / 收起全程可打断：动画中途反向拖动立即接管（§3）。

## 8. 橡皮筋 — 边界软阻尼

列表滚过头、面板拖到边界外时，阻力随超出距离递增，不硬停：

```js
const rubberband = (overshoot, dim, c = 0.55) => (overshoot * dim * c) / (dim + c * Math.abs(overshoot));
```

松手后用默认档弹簧归位，无过冲。

## 9. 帧级顺滑与降级

- 只动 `transform` / `opacity`；将动的元素提前 `will-change: transform`；模糊 / 滤镜联动每帧改的是 `filter`，面积控制在壁纸一层。
- 快速位移允许轻微拉伸（scaleY 1.02–1.05）编码速度感，到位回弹。
- `prefers-reduced-motion: reduce`：全部退化为 ≤100ms 交叉淡化，跟手联动保留（用户自己驱动，非前庭刺激），回弹、stagger、呼吸全部去掉。
