import {AbsoluteFill, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  APPEARANCE_SHOTS,
  APPEARANCE_TIMELINE,
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
  ProductFrame,
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

const APPEARANCE_PANEL = {left: 984, top: 132, width: 820, radius: 32};
const APPEARANCE_PANEL_TILT = -8;
const APPEARANCE_DARK_FROM = APPEARANCE_TIMELINE.darkFrom;
const APPEARANCE_EDITORIAL_FROM = APPEARANCE_TIMELINE.editorialFrom;

const appearanceCrop = (index: number): Crop =>
  index === 0
    ? {x: PANEL_CROPS.appearance.x, y: PANEL_CROPS.appearance.y + 132, width: PANEL_CROPS.appearance.width, height: 600}
    : {x: PANEL_CROPS.appearance.x, y: PANEL_CROPS.appearance.y + 420, width: PANEL_CROPS.appearance.width, height: 560};

const AppearancePanel = ({
  index,
  shot,
  isDark,
  isEditorial,
  lampGlow,
  paperGlow
}: {
  index: number;
  shot: (typeof APPEARANCE_SHOTS)[number];
  isDark: boolean;
  isEditorial: boolean;
  lampGlow: number;
  paperGlow: number;
}) => {
  const crop = appearanceCrop(index);
  const height = Math.round((crop.height * APPEARANCE_PANEL.width) / crop.width);
  const panelShadow = isEditorial
    ? "-26px 42px 100px -26px rgba(68, 46, 24, 0.24), 0 0 52px -14px rgba(214, 148, 86, 0.26), 0 0 0 1px rgba(184, 134, 88, 0.22)"
    : isDark
      ? "-26px 42px 96px -24px rgba(17, 24, 39, 0.34), 0 0 72px -12px rgba(245, 158, 11, 0.42), 0 0 0 1px rgba(146, 96, 36, 0.20)"
      : "-28px 44px 104px -26px rgba(17, 24, 39, 0.20), 0 12px 32px -12px rgba(17, 24, 39, 0.06), 0 0 0 1px rgba(17, 24, 39, 0.05)";

  return (
    <>
      {lampGlow > 0.01 && (
        <div
          style={{
            position: "absolute",
            left: APPEARANCE_PANEL.left - 150,
            top: APPEARANCE_PANEL.top - 110,
            width: APPEARANCE_PANEL.width + 300,
            height: height + 220,
            borderRadius: 999,
            background:
              "radial-gradient(ellipse 54% 48% at 50% 46%, rgba(255, 206, 130, 0.46) 0%, rgba(245, 158, 11, 0.22) 42%, rgba(245, 158, 11, 0) 76%)",
            filter: "blur(30px)",
            opacity: lampGlow,
            pointerEvents: "none",
            zIndex: 8
          }}
        />
      )}
      {paperGlow > 0.01 && (
        <div
          style={{
            position: "absolute",
            left: APPEARANCE_PANEL.left - 130,
            top: APPEARANCE_PANEL.top - 100,
            width: APPEARANCE_PANEL.width + 260,
            height: height + 200,
            borderRadius: 999,
            background:
              "radial-gradient(ellipse 54% 48% at 50% 46%, rgba(238, 208, 164, 0.44) 0%, rgba(214, 166, 104, 0.18) 44%, rgba(214, 166, 104, 0) 76%)",
            filter: "blur(30px)",
            opacity: paperGlow,
            pointerEvents: "none",
            zIndex: 9
          }}
        />
      )}
      <ProductFrame
        source="appearance.mp4"
        crop={crop}
        width={APPEARANCE_PANEL.width}
        startFrom={index === 0 ? 22 : shot.startFrom}
        playbackRate={shot.playbackRate}
        duration={shot.duration}
        animate={false}
        tilt={APPEARANCE_PANEL_TILT}
        focus={index === 0 ? {direction: "in", frames: APPEARANCE_HANDOFF.enterFrames, maxBlur: APPEARANCE_HANDOFF.maxBlur} : undefined}
        style={{
          left: APPEARANCE_PANEL.left,
          top: APPEARANCE_PANEL.top,
          zIndex: 10,
          boxShadow: panelShadow
        }}
      />
      {lampGlow > 0.01 && (
        <div
          style={{
            position: "absolute",
            left: APPEARANCE_PANEL.left,
            top: APPEARANCE_PANEL.top,
            width: APPEARANCE_PANEL.width,
            height,
            borderRadius: APPEARANCE_PANEL.radius,
            overflow: "hidden",
            transform: microPerspective(APPEARANCE_PANEL_TILT),
            background: [
              "radial-gradient(ellipse 68% 46% at 86% 2%, rgba(255, 214, 148, 0.40) 0%, rgba(238, 168, 88, 0.15) 46%, rgba(238, 168, 88, 0) 76%)",
              "linear-gradient(128deg, rgba(255, 232, 190, 0.14) 0%, rgba(255, 232, 190, 0) 58%)"
            ].join(", "),
            mixBlendMode: "screen",
            opacity: lampGlow,
            pointerEvents: "none",
            zIndex: 11
          }}
        />
      )}
    </>
  );
};

export const AppearanceScene = () => {
  const frame = useCurrentFrame();
  const isDark = frame >= APPEARANCE_DARK_FROM && frame < APPEARANCE_EDITORIAL_FROM;
  const isEditorial = frame >= APPEARANCE_EDITORIAL_FROM;
  const lampGlow = interpolate(
    frame,
    [APPEARANCE_DARK_FROM - 3, APPEARANCE_DARK_FROM + 5, APPEARANCE_EDITORIAL_FROM - 5, APPEARANCE_EDITORIAL_FROM + 3],
    [0, 1, 1, 0],
    {...CLAMP, easing: SMOOTH}
  );
  const paperGlow = interpolate(frame, [APPEARANCE_EDITORIAL_FROM - 2, APPEARANCE_EDITORIAL_FROM + 10], [0, 1], {
    ...CLAMP,
    easing: SMOOTH
  });

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      <BrandWhisper />

      {/* 左上极简标题：先讲明暗模式，再讲外观色板 */}
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 392,
          width: 760,
          zIndex: 10,
          color: COLORS.foreground,
          fontSize: 76,
          fontWeight: 700,
          lineHeight: 1.16,
          letterSpacing: -2.6,
          opacity: entranceOpacity(frame, 2, 0),
          translate: interpolate(frame, [2, 20], ["0px 22px", "0px 0px"], {...CLAMP, easing: SMOOTH})
        }}
      >
        {isEditorial ? (
          <>
            <div>外观色板定制，</div>
            <div>
              如读<span style={{color: "#B8562B"}}>纸质刊物</span>。
            </div>
          </>
        ) : (
          <>
            <div>明暗模式切换，</div>
            <div>
              <span style={{color: "#B45309"}}>夜读台灯</span>护眼。
            </div>
          </>
        )}
      </div>

      {/* 居中偏右的真实文摘面板：浅色蓝雾玻璃 → 深色夜读 → 数字刊物暖纸衬线 */}
      {APPEARANCE_SHOTS.map((shot, index) => (
        <Sequence key={shot.title} from={shotOffset(APPEARANCE_SHOTS, index)} durationInFrames={shot.duration}>
          <AppearancePanel
            index={index}
            shot={shot}
            isDark={isDark}
            isEditorial={isEditorial}
            lampGlow={lampGlow}
            paperGlow={paperGlow}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
