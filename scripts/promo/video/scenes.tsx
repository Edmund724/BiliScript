import {AbsoluteFill, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  APPEARANCE_SHOTS,
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_PLAYER_VERIFY_TO,
  CHAT_TIMESTAMP_CLICK_FRAME,
  PANEL_FOCUS_HANDOFFS
} from "../timeline.mjs";
import {
  BottomLectureCaption,
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
  VideoReferenceCard,
  entranceOpacity,
  microPerspective
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat")!;
const APPEARANCE_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "appearance")!;

const PLAYER_CROP: Crop = {x: 54, y: 171, width: 1272, height: 764};

const shotOffset = (shots: ReadonlyArray<{duration: number}>, index: number) =>
  shots.slice(0, index).reduce((total, previous) => total + previous.duration, 0);

const CHAT_VIDEO_SOURCE = "subtitle-seek-03.mp4";
const CHAT_REFERENCE_START_FROM = 84;
const CHAT_SEEK_START_FROM = 215;
// 参照窗按合成起点计帧，点击后需要按该帧反算，画面才停在 04:44
const CHAT_REFERENCE_SEEK_START_FROM = CHAT_SEEK_START_FROM - (CHAT_TIMESTAMP_CLICK_FRAME + 2) * 0.2;

const CHAT_REFERENCE = {left: 96, top: 312, width: 840};
const CHAT_REFERENCE_WINDOW_TOP = 378;
const CHAT_PLAYER = {left: 96, top: 124, width: 1080, height: 649};

const CHAT_PUSH_IN_FROM = CHAT_PLAYER_VERIFY_FROM - 6;
const CHAT_PUSH_IN_TO = CHAT_PLAYER_VERIFY_FROM + 12;
const CHAT_PUSH_OUT_FROM = CHAT_PLAYER_VERIFY_TO - 4;
const CHAT_PUSH_OUT_TO = CHAT_PLAYER_VERIFY_TO + 6;
const PUSH_EASING = Easing.bezier(0.45, 0, 0.15, 1);

type ChatHeadlinePart = {text: string; accent?: boolean};

const CHAT_HEADLINE: ChatHeadlinePart[][] = [
  [{text: "带着问题"}, {text: "追问视频", accent: true}, {text: "，"}],
  [{text: "点按"}, {text: "时间戳", accent: true}, {text: "让 UP 主亲自举证。"}]
];

const CHAT_QUESTION = "为什么作者说 AI 并非越强越好，适配才是关键？";
const CHAT_CONCLUSIONS = ["人与 AI 是「协作」，不是「替代」", "象棋实验：会配合的组合胜过最强单兵"];
const CHAT_CITATION = "(04:44–05:15)";
const CHAT_VERIFY_QUOTE = "“这里有一个研究……”";

const ChatHeadline = ({opacity}: {opacity: number}) => {
  const frame = useCurrentFrame();
  if (opacity <= 0.01) return null;
  const markerSweep = interpolate(frame, [8, 24], [0.55, 1], {...CLAMP, easing: SMOOTH});

  return (
    <div
      style={{
        position: "absolute",
        left: 96,
        top: 128,
        width: 840,
        color: COLORS.foreground,
        fontSize: 62,
        fontWeight: 700,
        lineHeight: 1.16,
        letterSpacing: -2.4,
        opacity,
        zIndex: 4
      }}
    >
      {CHAT_HEADLINE.map((line, lineIndex) => {
        const start = lineIndex * 3;
        return (
          <div key={lineIndex} style={{overflow: "hidden", paddingBottom: 4, whiteSpace: "nowrap"}}>
            <div
              style={{
                opacity: entranceOpacity(frame, start, 0),
                translate: interpolate(frame, [start, start + 16], ["0px 1.15em", "0px 0em"], {
                  ...CLAMP,
                  easing: SMOOTH
                })
              }}
            >
              {line.map((part) =>
                part.accent ? (
                  <span key={part.text} style={{position: "relative", display: "inline-block", padding: "0 3px", color: "#C81E5B"}}>
                    <span
                      style={{
                        position: "absolute",
                        inset: "9px 0",
                        borderRadius: 14,
                        background: "linear-gradient(96deg, rgba(255, 212, 59, 0.72) 0%, rgba(251, 114, 153, 0.44) 100%)",
                        transformOrigin: "0% 50%",
                        transform: `scaleX(${markerSweep.toFixed(3)}) skewX(-6deg)`,
                        zIndex: -1
                      }}
                    />
                    {part.text}
                  </span>
                ) : (
                  <span key={part.text}>{part.text}</span>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const ChatReferenceBar = ({opacity}: {opacity: number}) => {
  if (opacity <= 0.01) return null;

  return (
    <VideoReferenceCard
      variant="bar"
      width={CHAT_REFERENCE.width}
      badgeText="B 站原片"
      delay={4}
      style={{
        position: "absolute",
        left: CHAT_REFERENCE.left,
        top: CHAT_REFERENCE.top,
        opacity,
        zIndex: 7
      }}
    />
  );
};

const ChatVerifyWindow = ({progress}: {progress: number}) => {
  const frame = useCurrentFrame();
  const cropScale = CHAT_PLAYER.width / PLAYER_CROP.width;
  const scale = interpolate(progress, [0, 1], [CHAT_REFERENCE.width / CHAT_PLAYER.width, 1], CLAMP);
  const lift = interpolate(progress, [0, 1], [CHAT_REFERENCE_WINDOW_TOP - CHAT_PLAYER.top, 0], CLAMP);
  const seeked = frame >= CHAT_TIMESTAMP_CLICK_FRAME + 2;

  return (
    <div
      style={{
        position: "absolute",
        left: CHAT_PLAYER.left,
        top: CHAT_PLAYER.top,
        width: CHAT_PLAYER.width,
        height: CHAT_PLAYER.height,
        transformOrigin: "0 0",
        scale,
        translate: `0px ${lift.toFixed(1)}px`,
        opacity: entranceOpacity(frame, 2, 0),
        zIndex: 6
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          borderRadius: 26,
          overflow: "hidden",
          boxShadow: ELEVATION.videoPlane,
          background: "#0F172A"
        }}
      >
        <OffthreadVideo
          muted
          src={staticFile(`media/${CHAT_VIDEO_SOURCE}`)}
          startFrom={seeked ? Math.round(CHAT_REFERENCE_SEEK_START_FROM) : CHAT_REFERENCE_START_FROM}
          playbackRate={0.2}
          style={{
            position: "absolute",
            left: -PLAYER_CROP.x * cropScale,
            top: -PLAYER_CROP.y * cropScale - 28,
            width: 1920 * cropScale,
            height: 1080 * cropScale,
            maxWidth: "none"
          }}
        />
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
  const moveEnd = CHAT_PUSH_IN_FROM - 2;
  const showPointer = frame >= moveStart && frame <= moveEnd;
  const pointerOpacity =
    interpolate(frame, [moveStart, moveStart + 5], [0, 1], CLAMP) *
    interpolate(frame, [moveEnd - 6, moveEnd], [1, 0], CLAMP);
  const highlightOpacity = interpolate(frame, [moveStart + 6, clickAt, moveEnd + 40, moveEnd + 50], [0, 1, 1, 0.85], CLAMP);
  const rippleOpacity = interpolate(frame, [clickAt - 1, clickAt + 1, clickAt + 14], [0, 0.88, 0], CLAMP);
  const rippleScale = interpolate(frame, [clickAt - 1, clickAt + 14], [0.45, 1.85], {...CLAMP, easing: SMOOTH});
  const isClicked = frame >= clickAt;

  const cursorOffsetX = interpolate(frame, [moveStart, clickAt - 2], [150, 52], {...CLAMP, easing: SMOOTH});
  const cursorOffsetY = interpolate(frame, [moveStart, clickAt - 2], [206, 30], {...CLAMP, easing: SMOOTH});

  const answerReveal = interpolate(frame, [6, 22], [0.92, 1], {...CLAMP, easing: SMOOTH});

  return (
    <div
      style={{
        position: "absolute",
        left: panelLeft,
        top: 300,
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

        {/* AI 回答：一句提问 + 两条单行结论 */}
        <div style={{opacity: answerReveal}}>
          <div style={{display: "flex", justifyContent: "flex-end", marginBottom: 30}}>
            <div
              style={{
                maxWidth: 720,
                padding: "16px 26px",
                borderRadius: "22px 22px 8px 22px",
                background: "rgba(232, 93, 135, 0.12)",
                color: "#3C2A31",
                fontSize: 25,
                fontWeight: 660,
                lineHeight: 1.45,
                letterSpacing: -0.3
              }}
            >
              {CHAT_QUESTION}
            </div>
          </div>

          {CHAT_CONCLUSIONS.map((conclusion, index) => (
            <div
              key={conclusion}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                marginBottom: index === 0 ? 20 : 0
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: "rgba(181, 71, 42, 0.12)",
                  color: "#B5472A",
                  fontSize: 16,
                  fontWeight: 800,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0
                }}
              >
                ✓
              </span>
              <span style={{fontSize: 28, fontWeight: 700, color: "#1E1914", letterSpacing: -0.6, whiteSpace: "nowrap"}}>
                {conclusion}
              </span>
              {index > 0 ? null : (
                <span
                  style={{
                    position: "relative",
                    display: "inline-flex",
                    alignItems: "center",
                    marginLeft: 6,
                    padding: "10px 22px",
                    borderRadius: 999,
                    background: isClicked ? "rgba(232, 93, 135, 0.22)" : "rgba(181, 71, 42, 0.12)",
                    boxShadow:
                      highlightOpacity > 0.05
                        ? `0 14px 32px -8px rgba(232, 93, 135, ${(0.52 * highlightOpacity).toFixed(2)}), 0 0 0 2.5px rgba(232, 93, 135, ${(0.6 * highlightOpacity).toFixed(2)})`
                        : "0 0 0 1px rgba(181, 71, 42, 0.26)",
                    fontFamily: BRAND_FONT_FAMILY,
                    fontSize: 28,
                    fontWeight: 750,
                    color: isClicked ? COLORS.pink : "#B5472A",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap"
                  }}
                >
                  {CHAT_CITATION}
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
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export const ChatScene = () => {
  const frame = useCurrentFrame();
  const verifyBlend = interpolate(
    frame,
    [CHAT_PUSH_IN_FROM, CHAT_PUSH_IN_TO, CHAT_PUSH_OUT_FROM, CHAT_PUSH_OUT_TO],
    [0, 1, 1, 0],
    {...CLAMP, easing: PUSH_EASING}
  );
  const panelLeft = interpolate(verifyBlend, [0, 1], [940, 1220]);
  const panelScale = interpolate(verifyBlend, [0, 1], [1, 0.68]);

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <BrandWhisper />
      <ChatHeadline opacity={1 - Math.min(1, verifyBlend * 3)} />
      <ChatVerifyWindow progress={verifyBlend} />
      <ChatReferenceBar opacity={1 - Math.min(1, verifyBlend * 4)} />
      <ChatHeroPanel panelLeft={panelLeft} panelScale={panelScale} />
      <BottomLectureCaption
        timestamp="04:44"
        speaker="赵老师原声举证"
        quote={CHAT_VERIFY_QUOTE}
        from={CHAT_PLAYER_VERIFY_FROM}
        duration={CHAT_PLAYER_VERIFY_TO - CHAT_PLAYER_VERIFY_FROM + 6}
      />
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
