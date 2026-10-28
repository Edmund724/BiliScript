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
  PaperGrainOverlay,
  ProductFrame,
  ReadingLampBeam,
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
        title={"既然难免幻觉，\n怎么选 AI 才对？"}
        subtitle="带着问题追问视频上下文，点按时间戳让原片老师亲自举证。"
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
        <Sequence from={CHAT_PLAYER_VERIFY_FROM - 4} layout="none">
          <OffthreadVideo
            muted
            src={staticFile("media/subtitle-seek-03.mp4")}
            startFrom={215}
            playbackRate={0.2}
            style={{
              position: "absolute",
              left: -PLAYER_CROP.x * playerScale,
              top: -PLAYER_CROP.y * playerScale,
              width: 1920 * playerScale,
              height: 1080 * playerScale,
              maxWidth: "none"
            }}
          />
        </Sequence>
        <VoiceWaveBar timestamp="04:44 · 赵老师原声举证" quote="“这里有一个研究 · 人机协作象棋实验”" active={true} />
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

  // Global fourth-wall ambient transitions:
  // 1) Dark Night-Reading mode (frames 21..56): entire canvas dims + warm amber reading lamp blooms behind cards
  // 2) Editorial Warm-Paper mode (frames 57..89): entire canvas reveals delicate yellowish paper grain & warm parchment light
  const darkStageBlend = interpolate(
    frame,
    [18, 25, 54, 61],
    [0, 1, 1, 0],
    {...CLAMP, easing: SMOOTH}
  );
  const editorialStageBlend = interpolate(
    frame,
    [54, 62],
    [0, 1],
    {...CLAMP, easing: SMOOTH}
  );

  let pageFlipPulse = 0;
  for (const switchFrame of [21, 57]) {
    const dt = frame - switchFrame;
    if (dt >= -1 && dt <= 9) {
      pageFlipPulse = Math.max(
        pageFlipPulse,
        interpolate(dt, [-1, 2, 9], [0, 1, 0], {...CLAMP, easing: SMOOTH})
      );
    }
  }

  const badges = [
    {label: "浅色 · 蓝雾玻璃", dot: "#008CFF", glow: "rgba(0, 140, 255, 0.22)", centerX: 1185},
    {label: "深色 · 夜读", dot: "#F59E0B", glow: "rgba(245, 158, 11, 0.34)", centerX: 1412},
    {label: "数字刊物 · 暖纸衬线", dot: "#E08B5B", glow: "rgba(224, 139, 91, 0.28)", centerX: 1668}
  ];

  // Pointer interaction on theme badges at frame 21 (Dark) and frame 57 (Editorial)
  const showBadgeCursor = (frame >= 12 && frame <= 28) || (frame >= 48 && frame <= 65);
  const badgeCursorOpacity =
    frame <= 35
      ? interpolate(frame, [12, 16, 24, 28], [0, 1, 1, 0], CLAMP)
      : interpolate(frame, [48, 52, 61, 65], [0, 1, 1, 0], CLAMP);
  const badgeCursorX =
    frame <= 35
      ? interpolate(frame, [12, 20], [1240, 1418], {...CLAMP, easing: SMOOTH})
      : interpolate(frame, [48, 56], [1428, 1676], {...CLAMP, easing: SMOOTH});
  const badgeCursorY =
    frame <= 35
      ? interpolate(frame, [12, 20], [116, 82], {...CLAMP, easing: SMOOTH})
      : interpolate(frame, [48, 56], [108, 82], {...CLAMP, easing: SMOOTH});
  const badgeCursorScale =
    frame <= 35
      ? interpolate(frame, [19, 21, 24], [1, 0.84, 1], CLAMP)
      : interpolate(frame, [55, 57, 60], [1, 0.84, 1], CLAMP);

  const cardBg = isEditorial
    ? "linear-gradient(145deg, rgba(252, 246, 233, 0.97) 0%, rgba(242, 231, 210, 0.98) 100%)"
    : isDark
      ? "linear-gradient(145deg, rgba(22, 30, 46, 0.96) 0%, rgba(12, 17, 28, 0.98) 100%)"
      : "rgba(255, 255, 255, 0.96)";

  const cardText = isEditorial ? "#241B14" : isDark ? "#F8FAFC" : COLORS.foreground;
  const cardSub = isEditorial ? "#6E5A48" : isDark ? "#94A3B8" : COLORS.muted;
  const cardAccent = isEditorial ? "#B8562B" : isDark ? "#F59E0B" : "#008CFF";
  const cardShadow = isEditorial
    ? "-28px 44px 110px -22px rgba(68, 46, 24, 0.28), 0 0 64px -10px rgba(214, 148, 86, 0.28), 0 0 0 1.5px rgba(184, 134, 88, 0.28)"
    : isDark
      ? "-28px 44px 110px -18px rgba(2, 6, 23, 0.78), 0 0 84px -8px rgba(245, 158, 11, 0.36), 0 0 0 1.5px rgba(255, 214, 148, 0.22)"
      : ELEVATION.heroFloat;

  const stageTitleColor = darkStageBlend > 0.5 ? "#F8FAFC" : isEditorial ? "#231A12" : COLORS.foreground;
  const stageSubColor = darkStageBlend > 0.5 ? "#CBD5E1" : isEditorial ? "#695544" : COLORS.muted;

  const rotateY = -8 - pageFlipPulse * 8.5;
  const rotateX = 5 + pageFlipPulse * 2.4;

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      {/* 1. Full-Screen Dark Night-Reading Global Backdrop + Amber Desk Lamp Halo */}
      {darkStageBlend > 0.01 && (
        <AbsoluteFill
          style={{
            opacity: darkStageBlend,
            background: [
              "radial-gradient(ellipse 58% 64% at 28% 58%, rgba(245, 158, 11, 0.26) 0%, rgba(217, 119, 6, 0.11) 42%, rgba(15, 23, 42, 0) 74%)",
              "radial-gradient(ellipse 46% 52% at 74% 48%, rgba(251, 191, 36, 0.14) 0%, rgba(56, 189, 248, 0.07) 48%, rgba(15, 23, 42, 0) 76%)",
              "linear-gradient(158deg, #090D16 0%, #0F172A 54%, #131C31 100%)"
            ].join(", "),
            pointerEvents: "none"
          }}
        >
          {/* Warm Amber Desk Lamp Cone & Backlight Halo behind the preview card */}
          <div
            style={{
              position: "absolute",
              left: 18,
              top: 260,
              width: 980,
              height: 680,
              borderRadius: "50%",
              background:
                "radial-gradient(circle at 46% 44%, rgba(255, 196, 108, 0.46) 0%, rgba(245, 158, 11, 0.24) 36%, rgba(217, 119, 6, 0.08) 62%, rgba(217, 119, 6, 0) 80%)",
              filter: "blur(24px)"
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 520,
              top: -80,
              width: 680,
              height: 620,
              background:
                "conic-gradient(from 195deg at 58% 8%, rgba(255, 214, 148, 0) 0deg, rgba(255, 204, 128, 0.22) 24deg, rgba(245, 158, 11, 0.08) 48deg, rgba(255, 214, 148, 0) 72deg)",
              filter: "blur(18px)"
            }}
          />
        </AbsoluteFill>
      )}

      {/* 2. Full-Screen Editorial Warm-Paper Global Backdrop + Delicate Yellowish Paper Grain */}
      {editorialStageBlend > 0.01 && (
        <AbsoluteFill
          style={{
            opacity: editorialStageBlend,
            background: [
              "radial-gradient(ellipse 68% 62% at 26% 24%, rgba(255, 251, 240, 0.78) 0%, rgba(244, 232, 208, 0.24) 56%, rgba(212, 186, 146, 0) 82%)",
              "radial-gradient(ellipse 62% 58% at 78% 72%, rgba(226, 194, 148, 0.28) 0%, rgba(212, 180, 136, 0) 74%)",
              "linear-gradient(162deg, #F8F2E4 0%, #F1E6D0 52%, #E8D9BC 100%)"
            ].join(", "),
            pointerEvents: "none"
          }}
        >
          {/* Full-screen woven yellowish paper fiber & laid-paper watermark lines */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: [
                "repeating-linear-gradient(0deg, rgba(148, 114, 76, 0.055) 0px 1px, transparent 1px 28px)",
                "repeating-linear-gradient(90deg, rgba(168, 132, 92, 0.035) 0px 1px, transparent 1px 64px)",
                "repeating-linear-gradient(34deg, rgba(162, 122, 78, 0.07) 0px 1px, transparent 1px 4px)",
                "repeating-linear-gradient(-56deg, rgba(124, 92, 58, 0.055) 0px 1px, transparent 1px 5px)"
              ].join(", "),
              boxShadow: "inset 0 0 120px rgba(146, 108, 66, 0.16)"
            }}
          />
          <PaperGrainOverlay opacity={0.68} warm borderRadius={0} />
        </AbsoluteFill>
      )}

      <BrandWhisper
        style={{
          color: stageTitleColor
        }}
      />

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
          const isDarkStage = darkStageBlend > 0.5;
          return (
            <div
              key={badge.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 22px",
                borderRadius: 999,
                background: active
                  ? isDarkStage
                    ? "rgba(30, 41, 59, 0.96)"
                    : isEditorial
                      ? "rgba(255, 250, 240, 0.98)"
                      : "rgba(255, 255, 255, 0.98)"
                  : isDarkStage
                    ? "rgba(15, 23, 42, 0.68)"
                    : isEditorial
                      ? "rgba(246, 236, 218, 0.74)"
                      : "rgba(255, 255, 255, 0.68)",
                backdropFilter: "blur(20px)",
                boxShadow: active
                  ? `0 16px 38px -14px rgba(17, 24, 39, 0.28), 0 0 28px ${badge.glow}, 0 0 0 1.5px ${badge.dot}`
                  : isDarkStage
                    ? "0 10px 24px -14px rgba(2, 6, 23, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.10)"
                    : "0 10px 24px -14px rgba(17, 24, 39, 0.10), 0 0 0 1px rgba(17, 24, 39, 0.06)",
                color: isDarkStage ? (active ? "#FEF3C7" : "#CBD5E1") : isEditorial ? "#241B14" : COLORS.foreground,
                fontSize: 21,
                fontWeight: active ? 600 : 500,
                scale: active ? 1.04 : 1
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: badge.dot,
                  boxShadow: active ? `0 0 10px ${badge.dot}` : "none",
                  display: "inline-block"
                }}
              />
              <span>{badge.label}</span>
            </div>
          );
        })}
      </div>

      {/* Cursor clicking Dark Mode & Editorial badges */}
      {showBadgeCursor && (
        <svg
          viewBox="0 0 30 38"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 32,
            height: 40,
            filter: "drop-shadow(0 6px 12px rgba(2, 6, 23, 0.42))",
            opacity: badgeCursorOpacity,
            translate: `${badgeCursorX}px ${badgeCursorY}px`,
            scale: badgeCursorScale,
            pointerEvents: "none",
            zIndex: 30
          }}
        >
          <path
            d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z"
            fill="white"
            stroke="#111827"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      )}

      {/* Scene Title adapting to Dark Night-Reading & Editorial Paper stage */}
      <div style={{position: "absolute", left: 96, top: 152, width: 760, zIndex: 10}}>
        <div
          style={{
            color: stageTitleColor,
            fontSize: 68,
            lineHeight: 1.16,
            fontWeight: 600,
            letterSpacing: -2.4,
            textShadow: darkStageBlend > 0.5 ? "0 8px 28px rgba(2, 6, 23, 0.55)" : "none"
          }}
        >
          {frame < APPEARANCE_SHOTS[0].duration ? (
            <>
              <div>明暗模式切换，</div>
              <div>
                <span style={{color: isDark ? "#FBBF24" : COLORS.foreground}}>夜读台灯</span>护眼。
              </div>
            </>
          ) : (
            <>
              <div>外观色板定制，</div>
              <div>
                如读<span style={{color: "#B8562B"}}>纸质刊物</span>。
              </div>
            </>
          )}
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 25,
            fontWeight: 450,
            lineHeight: 1.5,
            letterSpacing: -0.3,
            color: stageSubColor
          }}
        >
          {isEditorial
            ? "当前演示：数字刊物色板 · 暖黄纸张肌理与人文衬线排版"
            : isDark
              ? "当前演示：深色夜读模式 · 全场暗室护眼与琥珀色台灯光晕"
              : "默认浅色 · 蓝雾玻璃色板，通透毛玻璃与空间景深"}
        </div>
      </div>

      {/* Left Spatial Floating Preview Surface */}
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
          overflow: "hidden",
          transformOrigin: "10% 50%",
          transform: `perspective(1600px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg)`,
          zIndex: 10
        }}
      >
        <PaperGrainOverlay opacity={isEditorial ? 0.64 : 0.34} warm />
        <ReadingLampBeam intensity={isEditorial ? 0.88 : isDark ? 0.96 : 0.30} warm={true} />
        {pageFlipPulse > 0.02 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(108deg, rgba(255, 244, 218, 0.38) 0%, rgba(255, 244, 218, 0.12) 42%, rgba(255, 244, 218, 0) 78%)",
              opacity: pageFlipPulse,
              pointerEvents: "none"
            }}
          />
        )}
        <div style={{position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20}}>
          <div style={{display: "flex", alignItems: "center", gap: 14}}>
            <span
              style={{
                background: cardAccent,
                color: isDark && !isEditorial ? "#0F172A" : "#FFFFFF",
                fontFamily: BRAND_FONT_FAMILY,
                fontSize: 20,
                fontWeight: 700,
                padding: "4px 15px",
                borderRadius: 999
              }}
            >
              02:32
            </span>
            <span
              style={{
                fontSize: 28,
                fontWeight: 600,
                color: cardText,
                letterSpacing: -0.6,
                fontFamily: isEditorial ? '"Noto Serif SC", "Source Han Serif SC", Georgia, serif' : FONT_FAMILY
              }}
            >
              AI 并非越强越好，适配才是关键
            </span>
          </div>
          <span
            style={{
              padding: "5px 14px",
              borderRadius: 999,
              background: isEditorial
                ? "rgba(184, 86, 43, 0.12)"
                : isDark
                  ? "rgba(245, 158, 11, 0.16)"
                  : "rgba(17, 24, 39, 0.06)",
              color: isEditorial ? "#9A4420" : isDark ? "#FCD34D" : cardSub,
              fontSize: 18,
              fontWeight: 600
            }}
          >
            {isEditorial ? "数字刊物" : isDark ? "深色夜读" : "蓝雾玻璃"}
          </span>
        </div>
        <div
          style={{
            position: "relative",
            fontSize: 28,
            fontWeight: isEditorial ? 560 : 600,
            lineHeight: 1.48,
            letterSpacing: isEditorial ? 0.1 : -0.6,
            color: cardText,
            fontFamily: isEditorial ? '"Noto Serif SC", "Source Han Serif SC", Georgia, serif' : FONT_FAMILY,
            marginBottom: 22
          }}
        >
          “人与 AI 的关系是<span style={{color: cardAccent, fontWeight: 700}}>「协作」</span>，而非<span style={{color: cardAccent, fontWeight: 700}}>「替代」</span>。哪怕投喂 100% 准确的数据，依然难以彻底消除幻觉。”
        </div>
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 16,
            borderTop: isEditorial
              ? "1px solid rgba(138, 102, 68, 0.16)"
              : isDark
                ? "1px solid rgba(255, 255, 255, 0.10)"
                : "1px solid rgba(17, 24, 39, 0.06)",
            color: cardSub,
            fontSize: 19
          }}
        >
          <span>{isEditorial ? "微黄纸张肌理 · 纸质杂志衬线排版" : isDark ? "琥珀色夜读台灯 · 全局暗场伴随" : "明暗模式 × 外观色板 · 像读杂志一样看 B 站"}</span>
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
              top: 132,
              zIndex: 10,
              boxShadow: isDark && !isEditorial
                ? "-28px 44px 110px -20px rgba(2, 6, 23, 0.72), 0 0 68px -12px rgba(245, 158, 11, 0.28), 0 0 0 1px rgba(255, 214, 148, 0.18)"
                : isEditorial
                  ? "-28px 44px 104px -24px rgba(68, 46, 24, 0.28), 0 0 48px -12px rgba(214, 148, 86, 0.22), 0 0 0 1px rgba(184, 134, 88, 0.22)"
                  : undefined
            }}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
