import {AbsoluteFill, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  APPEARANCE_SHOTS,
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_PLAYER_VERIFY_TO,
  CHAT_TIMESTAMP_CLICK_FRAME,
  PANEL_FOCUS_HANDOFFS
} from "../timeline.mjs";
import {
  BRAND_FONT_FAMILY,
  BrandWhisper,
  COLORS,
  Crop,
  ELEVATION,
  FONT_FAMILY,
  PANEL_CROPS,
  ProductFrame,
  SceneTitle,
  VoiceWaveBar,
  microPerspective
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat")!;
const APPEARANCE_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "appearance")!;

const PLAYER_CROP: Crop = {x: 54, y: 171, width: 1272, height: 764};

const shotOffset = (shots: ReadonlyArray<{duration: number}>, index: number) =>
  shots.slice(0, index).reduce((total, previous) => total + previous.duration, 0);

const ChatLeftContext = () => {
  const frame = useCurrentFrame();
  const verifyBlend = interpolate(
    frame,
    [CHAT_PLAYER_VERIFY_FROM - 4, CHAT_PLAYER_VERIFY_FROM + 4, CHAT_PLAYER_VERIFY_TO - 4, CHAT_PLAYER_VERIFY_TO + 4],
    [0, 1, 1, 0],
    {...CLAMP, easing: SMOOTH}
  );
  const leftOpacity = 1 - verifyBlend;
  if (leftOpacity <= 0.01) return null;

  return (
    <div style={{position: "absolute", inset: 0, opacity: leftOpacity, pointerEvents: "none"}}>
      <SceneTitle
        title={"看完还有问题？\n接着问。"}
        subtitle="围绕视频上下文深入追问，点击回答内时间戳回到原片那一秒。"
        style={{left: 96, top: 152, width: 760}}
      />
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 438,
          width: 760,
          padding: "28px 34px",
          borderRadius: 28,
          background: "rgba(255, 255, 255, 0.96)",
          boxShadow: ELEVATION.heroFloat,
          transform: "perspective(1600px) rotateX(4deg) rotateY(-8deg)",
          display: "flex",
          flexDirection: "column",
          gap: 16
        }}
      >
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
          <span
            style={{
              padding: "5px 14px",
              borderRadius: 999,
              background: "rgba(232, 93, 135, 0.12)",
              color: COLORS.pink,
              fontSize: 18,
              fontWeight: 720
            }}
          >
            追问原片上下文
          </span>
          <span style={{color: COLORS.muted, fontSize: 18, fontWeight: 560}}>自动挂载完整字幕与章节索引</span>
        </div>
        <div style={{color: COLORS.foreground, fontSize: 30, fontWeight: 740, lineHeight: 1.36, letterSpacing: -0.6}}>
          “为什么作者说 <span style={{color: COLORS.pink}}>AI 并非越强越好</span>，适配才是关键？”
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 96,
          top: 660,
          width: 760,
          padding: "22px 28px",
          borderRadius: 24,
          background: "rgba(251, 246, 236, 0.96)",
          boxShadow: "0 24px 56px -20px rgba(17, 24, 39, 0.16), 0 0 0 1.5px rgba(180, 142, 108, 0.32)",
          transform: "perspective(1600px) rotateX(3deg) rotateY(-6deg)",
          display: "flex",
          flexDirection: "column",
          gap: 18
        }}
      >
        <div style={{color: "#8C7B6B", fontSize: 20, fontWeight: 540}}>回车发送，Shift+Enter 换行</div>
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              background: "rgba(140, 123, 107, 0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#6E5D4F",
              fontSize: 18
            }}
          >
            🌐
          </div>
          <div style={{display: "flex", alignItems: "center", gap: 14}}>
            <span style={{color: "#5C4D40", fontFamily: BRAND_FONT_FAMILY, fontSize: 19, fontWeight: 620}}>
              ModelScope · DeepSeek-V3 ▾
            </span>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: "50%",
                background: "#B5472A",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              <div style={{width: 12, height: 12, borderRadius: 2, background: "#FFFFFF"}} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const ChatHeroPanel = ({panelLeft, panelScale}: {panelLeft: number; panelScale: number}) => {
  const frame = useCurrentFrame();
  const totalDuration = 180;

  const enterBlur = interpolate(frame, [0, CHAT_HANDOFF.enterFrames], [CHAT_HANDOFF.maxBlur, 0], {
    ...CLAMP,
    easing: SMOOTH
  });
  const exitBlur = interpolate(
    frame,
    [totalDuration - APPEARANCE_HANDOFF.exitFrames, totalDuration],
    [0, APPEARANCE_HANDOFF.maxBlur],
    {...CLAMP, easing: SMOOTH}
  );
  const blur = Math.max(enterBlur, exitBlur);
  const focusScale =
    interpolate(frame, [0, CHAT_HANDOFF.enterFrames], [0.97, 1], {...CLAMP, easing: SMOOTH}) *
    interpolate(frame, [totalDuration - APPEARANCE_HANDOFF.exitFrames, totalDuration], [1, 0.97], {
      ...CLAMP,
      easing: SMOOTH
    });

  const moveStart = CHAT_TIMESTAMP_CLICK_FRAME - 20;
  const clickAt = CHAT_TIMESTAMP_CLICK_FRAME;
  const moveEnd = CHAT_PLAYER_VERIFY_FROM - 2;
  const showPointer = frame >= moveStart && frame <= moveEnd;
  const pointerOpacity =
    interpolate(frame, [moveStart, moveStart + 5], [0, 1], CLAMP) *
    interpolate(frame, [moveEnd - 6, moveEnd], [1, 0], CLAMP);
  const highlightOpacity = interpolate(frame, [moveStart + 6, clickAt, moveEnd + 40, moveEnd + 50], [0, 1, 1, 0.85], CLAMP);
  const rippleOpacity = interpolate(frame, [clickAt - 1, clickAt + 1, clickAt + 14], [0, 0.88, 0], CLAMP);
  const rippleScale = interpolate(frame, [clickAt - 1, clickAt + 14], [0.45, 1.85], {...CLAMP, easing: SMOOTH});
  const isClicked = frame >= clickAt;

  const cursorOffsetX = interpolate(frame, [moveStart, clickAt - 2], [-120, 68], {...CLAMP, easing: SMOOTH});
  const cursorOffsetY = interpolate(frame, [moveStart, clickAt - 2], [210, 18], {...CLAMP, easing: SMOOTH});

  const answerReveal = interpolate(frame, [6, 22], [0.92, 1], {...CLAMP, easing: SMOOTH});

  return (
    <div
      style={{
        position: "absolute",
        left: panelLeft,
        top: 52,
        width: 880,
        transformOrigin: "0 0",
        scale: panelScale * focusScale,
        filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined
      }}
    >
      <div
        style={{
          position: "relative",
          width: 880,
          borderRadius: 28,
          background: "#FBF6EC",
          boxShadow: ELEVATION.heroFloat,
          padding: "28px 36px 36px",
          transform: microPerspective(-6),
          transformOrigin: "50% 50%",
          color: "#221C16"
        }}
      >
        {/* Top Header */}
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20}}>
          <span style={{color: "#6B5E51", fontSize: 22, fontWeight: 620}}>UP主: 复旦赵斌</span>
          <div style={{display: "flex", alignItems: "center", gap: 22, color: "#574B40", fontSize: 22}}>
            <span>☀</span>
            <span>⚙</span>
            <span>✕</span>
          </div>
        </div>

        {/* Reader Tabs */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr auto",
            alignItems: "center",
            gap: 10,
            paddingBottom: 18,
            borderBottom: "1px solid rgba(140, 123, 107, 0.18)",
            marginBottom: 20
          }}
        >
          {["字幕", "概览", "AI 对话"].map((tab, idx) => (
            <div
              key={tab}
              style={{
                padding: "11px 0",
                textAlign: "center",
                borderRadius: 12,
                background: idx === 2 ? "#F2E9D8" : "transparent",
                boxShadow: idx === 2 ? "0 2px 8px rgba(34, 28, 22, 0.06), 0 0 0 1px rgba(181, 71, 42, 0.18)" : "none",
                color: idx === 2 ? "#B5472A" : "#574B40",
                fontSize: 21,
                fontWeight: idx === 2 ? 740 : 620
              }}
            >
              {tab}
            </div>
          ))}
          <div style={{padding: "0 10px", color: "#6B5E51", fontSize: 22, fontWeight: 700}}>⋮</div>
        </div>

        {/* Jump Toast Banner */}
        <div
          style={{
            padding: "13px 22px",
            borderRadius: 14,
            background: "#F3EBDC",
            boxShadow: "0 0 0 1px rgba(140, 123, 107, 0.24) inset",
            textAlign: "center",
            color: "#5C4E41",
            fontSize: 20,
            fontWeight: 620,
            marginBottom: 24,
            opacity: interpolate(frame, [clickAt - 6, clickAt + 2], [0.78, 1], CLAMP)
          }}
        >
          {isClicked ? "正在跳转到 04:44..." : "已关联 247 条时间轴字幕 · 点击时间戳即可跳播"}
        </div>

        {/* AI Structured Response Hero Content */}
        <div style={{opacity: answerReveal}}>
          <div
            style={{
              fontFamily: '"Noto Serif SC", "Source Han Serif SC", Georgia, serif',
              fontSize: 34,
              fontWeight: 760,
              color: "#1E1914",
              letterSpacing: -0.6,
              marginBottom: 18
            }}
          >
            作者主张「适配优先」的三个理由
          </div>

          {/* Citation Row 1 with Inline Timestamp Pill + Native Capsule & Cursor */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 10,
              fontSize: 27,
              fontWeight: 780,
              color: "#1E1914",
              lineHeight: 1.4,
              marginBottom: 18
            }}
          >
            <span>1. 人与 AI 的关系是「协作」，而非「替代」</span>
            <span
              style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                padding: "3px 14px",
                borderRadius: 999,
                background: isClicked ? "rgba(232, 93, 135, 0.20)" : "rgba(181, 71, 42, 0.10)",
                boxShadow:
                  highlightOpacity > 0.05
                    ? `0 10px 28px -6px rgba(232, 93, 135, ${(0.48 * highlightOpacity).toFixed(2)}), 0 0 0 2px rgba(232, 93, 135, ${(0.58 * highlightOpacity).toFixed(2)})`
                    : "0 0 0 1px rgba(181, 71, 42, 0.26)",
                fontFamily: BRAND_FONT_FAMILY,
                fontSize: 24,
                fontWeight: 740,
                color: isClicked ? COLORS.pink : "#B5472A",
                fontVariantNumeric: "tabular-nums"
              }}
            >
              (04:44–05:15)
              {/* Concentric Click Ripple centered directly on the timestamp badge */}
              <span
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 56,
                  height: 56,
                  marginLeft: -28,
                  marginTop: -28,
                  borderRadius: "50%",
                  background: "rgba(232, 93, 135, 0.26)",
                  boxShadow: "0 0 32px rgba(232, 93, 135, 0.55)",
                  opacity: rippleOpacity,
                  scale: rippleScale,
                  pointerEvents: "none"
                }}
              />
              {/* Vector Cursor anchored directly to the timestamp badge */}
              {showPointer && (
                <svg
                  viewBox="0 0 30 38"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: 34,
                    height: 43,
                    filter: "drop-shadow(0 4px 8px rgba(17, 24, 39, 0.35))",
                    opacity: pointerOpacity,
                    translate: `${cursorOffsetX}px ${cursorOffsetY}px`,
                    scale: interpolate(frame, [clickAt - 2, clickAt, clickAt + 4], [1, 0.82, 1], CLAMP),
                    pointerEvents: "none",
                    zIndex: 10
                  }}
                >
                  <path
                    d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z"
                    fill="white"
                    stroke={COLORS.foreground}
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
          </div>

          <p
            style={{
              margin: "0 0 26px 0",
              fontSize: 23,
              fontWeight: 510,
              lineHeight: 1.62,
              color: "#332B24"
            }}
          >
            UP 主先驳斥一个常见预设：人们总以为强大的 AI 能替代自己、弥补智力不足。但他认为，「用 AI 换掉人脑」不是这个时代能做的事；现实形态是人与 AI 协作。关键推论是：如果只是替代，那当然越强越好；但既然是协作，最强就未必带来最大优势。这是整段论证的前提。
          </p>

          <div
            style={{
              fontSize: 26,
              fontWeight: 780,
              color: "#1E1914",
              lineHeight: 1.42,
              marginBottom: 14
            }}
          >
            2. 象棋实验：会配合的组合胜过拥有最强成员的组合{" "}
            <span
              style={{
                padding: "2px 10px",
                borderRadius: 999,
                background: "rgba(181, 71, 42, 0.08)",
                color: "#B5472A",
                fontFamily: BRAND_FONT_FAMILY,
                fontSize: 23,
                fontWeight: 700
              }}
            >
              (05:17–06:33)
            </span>
          </div>

          <p
            style={{
              margin: 0,
              fontSize: 23,
              fontWeight: 510,
              lineHeight: 1.62,
              color: "#332B24"
            }}
          >
            他引用一个象棋实验：每队两人，一强一弱，每轮下完后抽签决定下一轮由谁走，因此队员必须为同伴留棋，并照顾较弱的队友。结果，整体上「更会协作、会照顾较弱成员并充分理解对方」的组合表现优异。
          </p>
        </div>
      </div>
    </div>
  );
};

const ChatReturnVerification = () => {
  const frame = useCurrentFrame();
  if (frame < CHAT_PLAYER_VERIFY_FROM - 4 || frame > CHAT_PLAYER_VERIFY_TO + 6) return null;
  const progress = interpolate(
    frame,
    [CHAT_PLAYER_VERIFY_FROM - 4, CHAT_PLAYER_VERIFY_FROM + 4, CHAT_PLAYER_VERIFY_TO - 4, CHAT_PLAYER_VERIFY_TO + 4],
    [0, 1, 1, 0],
    {...CLAMP, easing: SMOOTH}
  );
  const playerScale = 1080 / PLAYER_CROP.width;
  const playerHeight = PLAYER_CROP.height * playerScale;

  return (
    <div
      style={{
        position: "absolute",
        left: 96,
        top: 124,
        width: 1080,
        height: playerHeight,
        opacity: progress,
        scale: interpolate(progress, [0, 1], [0.95, 1]),
        translate: `${(1 - progress) * -28}px 0px`,
        transform: "perspective(1600px) rotateX(3deg) rotateY(5deg)",
        zIndex: 8
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          borderRadius: 28,
          overflow: "hidden",
          boxShadow: ELEVATION.videoPlane,
          background: "#0F172A"
        }}
      >
        <OffthreadVideo
          muted
          src={staticFile("media/subtitle-seek-03.mp4")}
          startFrom={135}
          playbackRate={1}
          style={{
            position: "absolute",
            left: -PLAYER_CROP.x * playerScale,
            top: -PLAYER_CROP.y * playerScale,
            width: 1920 * playerScale,
            height: 1080 * playerScale,
            maxWidth: "none"
          }}
        />
        <VoiceWaveBar timestamp="04:44" quote="“这里有一个研究 · 人机协作实验”" active={true} />
      </div>
    </div>
  );
};

export const ChatScene = () => {
  const frame = useCurrentFrame();
  const verifyBlend = interpolate(
    frame,
    [CHAT_PLAYER_VERIFY_FROM - 4, CHAT_PLAYER_VERIFY_FROM + 4, CHAT_PLAYER_VERIFY_TO - 4, CHAT_PLAYER_VERIFY_TO + 4],
    [0, 1, 1, 0],
    {...CLAMP, easing: SMOOTH}
  );
  const panelLeft = interpolate(verifyBlend, [0, 1], [940, 1220]);
  const panelScale = interpolate(verifyBlend, [0, 1], [1, 0.68]);

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <BrandWhisper />
      <ChatLeftContext />
      <ChatHeroPanel panelLeft={panelLeft} panelScale={panelScale} />
      <ChatReturnVerification />
    </AbsoluteFill>
  );
};

export const AppearanceScene = () => {
  const frame = useCurrentFrame();
  const isDark = frame >= 21;
  const isEditorial = frame >= 57;
  const activeStep = isEditorial ? 2 : isDark ? 1 : 0;

  const badges = [
    {label: "晨读纸白", dot: "#E85D87", glow: "rgba(232, 93, 135, 0.22)"},
    {label: "深色夜读", dot: "#38BDF8", glow: "rgba(56, 189, 248, 0.24)"},
    {label: "数字刊物", dot: "#E08B5B", glow: "rgba(224, 139, 91, 0.24)"}
  ];

  const cardBg = isEditorial
    ? "linear-gradient(145deg, rgba(42, 31, 26, 0.96) 0%, rgba(28, 20, 17, 0.98) 100%)"
    : isDark
      ? "linear-gradient(145deg, rgba(24, 34, 50, 0.95) 0%, rgba(13, 19, 30, 0.98) 100%)"
      : "rgba(255, 255, 255, 0.96)";

  const cardText = isDark ? "#F8FAFC" : COLORS.foreground;
  const cardSub = isDark ? "#94A3B8" : COLORS.muted;
  const cardAccent = isEditorial ? "#E08B5B" : isDark ? "#38BDF8" : COLORS.pink;
  const cardShadow = isDark
    ? "-28px 44px 110px -22px rgba(15, 23, 42, 0.42), 0 0 48px -12px rgba(56, 189, 248, 0.18), 0 0 0 1px rgba(255, 255, 255, 0.14)"
    : ELEVATION.heroFloat;

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      <BrandWhisper />

      <div
        style={{
          position: "absolute",
          right: 96,
          top: 52,
          display: "flex",
          alignItems: "center",
          gap: 14,
          zIndex: 20
        }}
      >
        {badges.map((badge, index) => {
          const active = index === activeStep;
          return (
            <div
              key={badge.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 22px",
                borderRadius: 999,
                background: active ? "rgba(255, 255, 255, 0.98)" : "rgba(255, 255, 255, 0.68)",
                backdropFilter: "blur(20px)",
                boxShadow: active
                  ? `0 16px 38px -14px rgba(17, 24, 39, 0.18), 0 0 24px ${badge.glow}, 0 0 0 1.5px ${badge.dot}`
                  : "0 10px 24px -14px rgba(17, 24, 39, 0.10), 0 0 0 1px rgba(17, 24, 39, 0.04)",
                color: COLORS.foreground,
                fontSize: 21,
                fontWeight: active ? 600 : 500,
                scale: active ? 1.04 : 1
              }}
            >
              <span style={{width: 12, height: 12, borderRadius: "50%", background: badge.dot, display: "inline-block"}} />
              <span>{badge.label}</span>
            </div>
          );
        })}
      </div>

      <SceneTitle
        title={frame < APPEARANCE_SHOTS[0].duration ? "晨读亮场为主，\n亦备深色夜读。" : "多款阅读色板，\n随你偏好。"}
        subtitle={
          isEditorial
            ? "当前演示：数字刊物暖棕色板 · 适配长文沉浸精读"
            : isDark
              ? "当前演示：深色夜读模式 · 夜间低眩光视觉保护"
              : "默认晨读亮场 · 通透纸感与空间景深"
        }
        style={{left: 96, top: 152, width: 760}}
      />

      {/* Left Spatial Floating Preview Surface showcasing Dark Mode & Editorial Palettes inside the Morning Light Stage */}
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 444,
          width: 790,
          padding: "36px 42px",
          borderRadius: 32,
          background: cardBg,
          backdropFilter: "blur(28px)",
          boxShadow: cardShadow,
          transform: "perspective(1600px) rotateX(5deg) rotateY(-8deg)"
        }}
      >
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20}}>
          <div style={{display: "flex", alignItems: "center", gap: 14}}>
            <span
              style={{
                background: cardAccent,
                color: "#FFFFFF",
                fontFamily: BRAND_FONT_FAMILY,
                fontSize: 20,
                fontWeight: 600,
                padding: "4px 15px",
                borderRadius: 999
              }}
            >
              02:32
            </span>
            <span style={{fontSize: 28, fontWeight: 600, color: cardText, letterSpacing: -0.6}}>
              AI 并非越强越好，适配才是关键
            </span>
          </div>
          <span
            style={{
              padding: "5px 14px",
              borderRadius: 999,
              background: isDark ? "rgba(255, 255, 255, 0.10)" : "rgba(17, 24, 39, 0.06)",
              color: cardSub,
              fontSize: 18,
              fontWeight: 600
            }}
          >
            {isEditorial ? "数字刊物" : isDark ? "深色夜读" : "晨读纸白"}
          </span>
        </div>
        <div style={{fontSize: 29, fontWeight: 600, lineHeight: 1.42, letterSpacing: -0.6, color: cardText, marginBottom: 22}}>
          “人与 AI 的关系是<span style={{color: cardAccent}}>「协作」</span>，而非<span style={{color: cardAccent}}>「替代」</span>。哪怕投喂 100% 准确的数据，依然难以彻底消除幻觉。”
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 16,
            borderTop: isDark ? "1px solid rgba(255, 255, 255, 0.08)" : "1px solid rgba(17, 24, 39, 0.06)",
            color: cardSub,
            fontSize: 19
          }}
        >
          <span>白天通透晨读 · 夜间深邃护眼</span>
          <span style={{color: cardAccent, fontFamily: BRAND_FONT_FAMILY, fontWeight: 600}}>04:07 – 05:15 ↗</span>
        </div>
      </div>

      {/* Right Foreground 3D Plane: Real Appearance Extension Panel */}
      {APPEARANCE_SHOTS.map((shot, index) => (
        <Sequence key={shot.title} from={shotOffset(APPEARANCE_SHOTS, index)} durationInFrames={shot.duration}>
          <ProductFrame
            source="appearance.mp4"
            crop={
              index === 0
                ? {x: PANEL_CROPS.appearance.x, y: PANEL_CROPS.appearance.y + 132, width: PANEL_CROPS.appearance.width, height: 600}
                : {x: PANEL_CROPS.appearance.x, y: PANEL_CROPS.appearance.y + 420, width: PANEL_CROPS.appearance.width, height: 560}
            }
            width={820}
            startFrom={index === 0 ? 22 : shot.startFrom}
            playbackRate={shot.playbackRate}
            duration={shot.duration}
            animate={false}
            tilt={-8}
            focus={index === 0 ? {direction: "in", frames: APPEARANCE_HANDOFF.enterFrames, maxBlur: APPEARANCE_HANDOFF.maxBlur} : undefined}
            style={{
              left: 984,
              top: 132
            }}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
