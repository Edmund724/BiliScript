import {AbsoluteFill, Easing, OffthreadVideo, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  APPEARANCE_SHOTS,
  APPEARANCE_TIMELINE,
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_PLAYER_VERIFY_TO,
  CHAT_TIMESTAMP_CLICK_FRAME,
  PANEL_FOCUS_HANDOFFS,
  SUBTOOLS_TIMELINE,
  WEBSEARCH_TIMELINE
} from "../timeline.mjs";
import {
  BottomLectureCaption,
  BRAND_FONT_FAMILY,
  BrandWhisper,
  COLORS,
  Crop,
  ELEVATION,
  FONT_FAMILY,
  MIST_GLASS,
  VideoReferenceCard,
  entranceOpacity,
  microPerspective
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);
const SERIF_FONT_FAMILY = '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", Georgia, serif';

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat")!;
const SUBTOOLS_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "subtools")!;
const WEBSEARCH_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "websearch")!;
const APPEARANCE_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "appearance")!;

const PLAYER_CROP: Crop = {x: 54, y: 171, width: 1272, height: 764};

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

type HeadlinePart = {text: string; accent?: boolean};

const CHAT_HEADLINE: HeadlinePart[][] = [
  [{text: "带着问题"}, {text: "追问视频", accent: true}, {text: "，"}],
  [{text: "点按"}, {text: "时间戳", accent: true}, {text: "让 UP 主亲自举证。"}]
];

export const CHAT_QUESTION = "为什么作者说 AI 并非越强越好，适配才是关键？";
export const CHAT_CONCLUSIONS = ["人与 AI 是「协作」，不是「替代」", "象棋实验：会配合的组合胜过最强单兵"];
export const CHAT_CITATION = "(04:44–05:15)";
export const CHAT_VERIFY_QUOTE = "“这里有一个研究……”";

const SectionHeadline = ({
  lines,
  opacity = 1,
  subtext
}: {
  lines: HeadlinePart[][];
  opacity?: number;
  subtext?: string;
}) => {
  const frame = useCurrentFrame();
  if (opacity <= 0.01) return null;
  const markerSweep = interpolate(frame, [6, 22], [0.55, 1], {...CLAMP, easing: SMOOTH});

  return (
    <div
      style={{
        position: "absolute",
        left: 96,
        top: 128,
        width: 820,
        color: COLORS.foreground,
        fontSize: 60,
        fontWeight: 700,
        lineHeight: 1.16,
        letterSpacing: -2.2,
        opacity,
        zIndex: 4
      }}
    >
      {lines.map((line, lineIndex) => {
        const start = lineIndex * 3;
        return (
          <div key={lineIndex} style={{overflow: "hidden", paddingBottom: 4, whiteSpace: "nowrap"}}>
            <div
              style={{
                opacity: entranceOpacity(frame, start, 0),
                translate: interpolate(frame, [start, start + 14], ["0px 1.1em", "0px 0em"], {
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
      {subtext ? (
        <div
          style={{
            marginTop: 18,
            fontSize: 27,
            fontWeight: 620,
            lineHeight: 1.4,
            letterSpacing: -0.4,
            color: COLORS.muted,
            opacity: entranceOpacity(frame, 6, 0)
          }}
        >
          {subtext}
        </div>
      ) : null}
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

const usePanelHandoffFocus = (
  totalDuration: number,
  enterHandoff: {enterFrames: number; maxBlur: number},
  exitHandoff?: {exitFrames: number; maxBlur: number}
) => {
  const frame = useCurrentFrame();
  const enterBlur = interpolate(frame, [0, enterHandoff.enterFrames], [enterHandoff.maxBlur, 0], {
    ...CLAMP,
    easing: SMOOTH
  });
  const exitBlur = exitHandoff
    ? interpolate(frame, [totalDuration - exitHandoff.exitFrames, totalDuration], [0, exitHandoff.maxBlur], {
        ...CLAMP,
        easing: SMOOTH
      })
    : 0;
  const blur = Math.max(enterBlur, exitBlur);
  const focusScale =
    interpolate(frame, [0, enterHandoff.enterFrames], [0.97, 1], {...CLAMP, easing: SMOOTH}) *
    (exitHandoff
      ? interpolate(frame, [totalDuration - exitHandoff.exitFrames, totalDuration], [1, 0.97], {
          ...CLAMP,
          easing: SMOOTH
        })
      : 1);
  return {blur, focusScale};
};

const ChatHeroPanel = ({panelLeft, panelScale}: {panelLeft: number; panelScale: number}) => {
  const frame = useCurrentFrame();
  const {blur, focusScale} = usePanelHandoffFocus(180, CHAT_HANDOFF, SUBTOOLS_HANDOFF);

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
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20}}>
          <span style={{color: "#6B5E51", fontSize: 22, fontWeight: 620}}>UP主: 复旦赵斌</span>
          <div style={{display: "flex", alignItems: "center", gap: 22, color: "#574B40", fontSize: 22}}>
            <span>☀</span>
            <span>⚙</span>
            <span>✕</span>
          </div>
        </div>

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
      <SectionHeadline lines={CHAT_HEADLINE} opacity={1 - Math.min(1, verifyBlend * 3)} />
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

/* ==========================================================================
   Scene 5: SubtoolsScene (19.0s–22.5s, 105 frames)
   先介绍硅基流动免费 API 转写与双语对照，再介绍字幕复制与导出
   ========================================================================== */

export const SUBTOOLS_HEADLINE = "遇到没字幕的视频？\n语音转写 · 双语对照。";
export const SUBTOOLS_SUBHEADLINE = "调用硅基流动免费 API";
export const SUBTOOLS_EXPORT_HEADLINE = "字幕复制与导出。";
export const SUBTOOLS_EXPORT_SUBHEADLINE = "Markdown · SRT · TXT";

const SUBTOOLS_HEADLINE_LINES: HeadlinePart[][] = [
  [{text: "遇到"}, {text: "没字幕", accent: true}, {text: "的视频？"}],
  [{text: "语音转写", accent: true}, {text: " · 双语对照。"}]
];

const SUBTOOLS_EXPORT_HEADLINE_LINES: HeadlinePart[][] = [
  [{text: "字幕"}, {text: "复制与导出", accent: true}, {text: "。"}]
];

export const SUBTOOLS_BILINGUAL_ROWS = [
  {
    timestamp: "01:14",
    source: "Attention mechanisms allow the model to focus on relevant tokens.",
    translation: "注意力机制让模型能够聚焦于上下文中最相关的词元。"
  },
  {
    timestamp: "01:28",
    source: "We project queries, keys, and values into latent subspaces.",
    translation: "我们将查询、键与值向量投影至低维潜在子空间。"
  }
] as const;

export const SUBTOOLS_EXPORT_BUTTONS = ["复制 Markdown", "导出 SRT · TXT"] as const;

export const SubtoolsScene = () => {
  const frame = useCurrentFrame();
  const {blur, focusScale} = usePanelHandoffFocus(SUBTOOLS_TIMELINE.duration, SUBTOOLS_HANDOFF, WEBSEARCH_HANDOFF);
  const exportAt = SUBTOOLS_TIMELINE.exportAt;
  const clickAt = SUBTOOLS_TIMELINE.exportClickAt;
  const isExported = frame >= clickAt;
  const exportPhase = interpolate(frame, [exportAt - 4, exportAt + 4], [0, 1], {...CLAMP, easing: SMOOTH});
  const exportCardProgress = interpolate(frame, [clickAt, clickAt + 12], [0, 1], {...CLAMP, easing: SMOOTH});
  const pointerOpacity =
    interpolate(frame, [clickAt - 16, clickAt - 10], [0, 1], CLAMP) *
    interpolate(frame, [clickAt + 6, clickAt + 12], [1, 0], CLAMP);
  const pointerX = interpolate(frame, [clickAt - 16, clickAt - 2], [140, 48], {...CLAMP, easing: SMOOTH});
  const pointerY = interpolate(frame, [clickAt - 16, clickAt - 2], [96, 26], {...CLAMP, easing: SMOOTH});

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <BrandWhisper />
      <SectionHeadline lines={SUBTOOLS_HEADLINE_LINES} subtext={SUBTOOLS_SUBHEADLINE} opacity={1 - exportPhase} />
      <SectionHeadline
        lines={SUBTOOLS_EXPORT_HEADLINE_LINES}
        subtext={SUBTOOLS_EXPORT_SUBHEADLINE}
        opacity={exportPhase}
      />

      <VideoReferenceCard
        variant="bar"
        width={760}
        headerText="正在阅读：MIT 6.S191 · 英文生肉"
        badgeText="无原生字幕"
        delay={4}
        style={{position: "absolute", left: 96, top: 430}}
      />

      {/* Right Subtitle Panel */}
      <div
        style={{
          position: "absolute",
          left: 916,
          top: 146,
          width: 908,
          transformOrigin: "0 0",
          scale: focusScale,
          filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined
        }}
      >
        <div
          style={{
            position: "relative",
            width: 908,
            borderRadius: 30,
            background: MIST_GLASS.surface,
            backdropFilter: "blur(24px) saturate(1.2)",
            boxShadow: MIST_GLASS.shellShadow,
            padding: "28px 34px 34px",
            transform: microPerspective(-5),
            color: MIST_GLASS.text
          }}
        >
          {/* Tabs + Export Action Bar */}
          <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20}}>
            <div style={{display: "flex", alignItems: "center", gap: 8}}>
              {["字幕", "概览", "AI 对话"].map((tab, idx) => (
                <div
                  key={tab}
                  style={{
                    padding: "10px 22px",
                    borderRadius: 12,
                    background: idx === 0 ? MIST_GLASS.cardElevated : "transparent",
                    boxShadow: idx === 0 ? MIST_GLASS.tabActiveShadow : "none",
                    color: idx === 0 ? MIST_GLASS.accent : MIST_GLASS.muted,
                    fontSize: 21,
                    fontWeight: idx === 0 ? 740 : 580
                  }}
                >
                  {tab}
                </div>
              ))}
            </div>

            <div style={{display: "flex", alignItems: "center", gap: 10}}>
              <span
                style={{
                  padding: "8px 16px",
                  borderRadius: 999,
                  background: "rgba(16, 185, 129, 0.14)",
                  color: "#047857",
                  fontSize: 18,
                  fontWeight: 740
                }}
              >
                ✓ 硅基流动免费 API · 转写完成
              </span>
              <span
                style={{
                  padding: "8px 16px",
                  borderRadius: 999,
                  background: "rgba(0, 140, 255, 0.14)",
                  color: MIST_GLASS.accent,
                  fontSize: 18,
                  fontWeight: 740
                }}
              >
                双语对照 ON
              </span>
            </div>
          </div>

          {/* Subtitle Toolbar: Copy Markdown & Export SRT/TXT */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 20px",
              borderRadius: 18,
              background: MIST_GLASS.cardElevated,
              boxShadow: MIST_GLASS.cardShadow,
              marginBottom: 20
            }}
          >
            <span style={{fontSize: 20, fontWeight: 650, color: MIST_GLASS.muted}}>
              共 412 条双语时间轴字幕
            </span>
            <div style={{display: "flex", alignItems: "center", gap: 12}}>
              <div
                style={{
                  position: "relative",
                  padding: "10px 22px",
                  borderRadius: 12,
                  background: isExported ? COLORS.pink : "rgba(0, 140, 255, 0.12)",
                  color: isExported ? "#FFFFFF" : MIST_GLASS.accent,
                  fontSize: 20,
                  fontWeight: 760,
                  boxShadow: isExported ? "0 12px 26px -8px rgba(232, 93, 135, 0.52)" : "none",
                  scale: interpolate(frame, [clickAt - 2, clickAt, clickAt + 4], [1, 0.94, 1], CLAMP)
                }}
              >
                {isExported ? "✓ 已复制 Markdown" : SUBTOOLS_EXPORT_BUTTONS[0]}
                {pointerOpacity > 0.01 && (
                  <svg
                    viewBox="0 0 30 38"
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      width: 32,
                      height: 40,
                      opacity: pointerOpacity,
                      translate: `${pointerX}px ${pointerY}px`,
                      filter: "drop-shadow(0 4px 8px rgba(17, 24, 39, 0.35))",
                      pointerEvents: "none",
                      zIndex: 12
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
              </div>
              <div
                style={{
                  padding: "10px 18px",
                  borderRadius: 12,
                  background: "rgba(15, 23, 42, 0.06)",
                  color: MIST_GLASS.text,
                  fontSize: 20,
                  fontWeight: 680
                }}
              >
                {SUBTOOLS_EXPORT_BUTTONS[1]}
              </div>
            </div>
          </div>

          {/* Bilingual Subtitle Rows */}
          <div style={{display: "flex", flexDirection: "column", gap: 16}}>
            {SUBTOOLS_BILINGUAL_ROWS.map((row) => (
              <div
                key={row.timestamp}
                style={{
                  padding: "20px 24px",
                  borderRadius: 20,
                  background: MIST_GLASS.cardElevated,
                  boxShadow: MIST_GLASS.cardShadow
                }}
              >
                <div style={{display: "flex", alignItems: "center", gap: 14, marginBottom: 8}}>
                  <span
                    style={{
                      padding: "4px 14px",
                      borderRadius: 999,
                      background: MIST_GLASS.timeBg,
                      color: MIST_GLASS.timeColor,
                      fontFamily: BRAND_FONT_FAMILY,
                      fontSize: 21,
                      fontWeight: 780
                    }}
                  >
                    {row.timestamp}
                  </span>
                  <span style={{fontSize: 22, fontWeight: 640, color: MIST_GLASS.text}}>{row.source}</span>
                </div>
                <div
                  style={{
                    paddingLeft: 14,
                    borderLeft: `3px solid ${MIST_GLASS.accent}`,
                    fontSize: 24,
                    fontWeight: 720,
                    color: "#0F172A"
                  }}
                >
                  {row.translation}
                </div>
              </div>
            ))}
          </div>

          {/* Floating Markdown Preview Card after clicking Copy Markdown */}
          {exportCardProgress > 0.01 && (
            <div
              style={{
                marginTop: 18,
                padding: "18px 24px",
                borderRadius: 20,
                background: "#111827",
                color: "#F8FAFC",
                boxShadow: "0 24px 48px -14px rgba(15, 23, 42, 0.45), 0 0 0 1.5px rgba(232, 93, 135, 0.48)",
                opacity: exportCardProgress,
                translate: `0px ${(1 - exportCardProgress) * 18}px`,
                fontFamily: BRAND_FONT_FAMILY
              }}
            >
              <div style={{marginBottom: 8, color: "#FB7299", fontSize: 18, fontWeight: 740}}>
                已复制 · 含时间轴与双语对照
              </div>
              <div style={{fontSize: 19, lineHeight: 1.5, color: "#E2E8F0"}}>
                - **[01:14]** Attention mechanisms... / 注意力机制让模型聚焦相关词元。
              </div>
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ==========================================================================
   Scene 6: WebSearchScene (22.5s–25.0s, 75 frames)
   主标题：UP 主说得对不对？AI 联网检索辅助核对
   副标/追问气泡：超纲概念背景补充
   ========================================================================== */

export const WEBSEARCH_HEADLINE = "UP 主说得对不对？\nAI 联网检索辅助核对。";
export const WEBSEARCH_SUBHEADLINE = "超纲概念听不懂？检索公开网页和论文摘要，附来源链接，方便进一步核实。";
export const WEBSEARCH_QUESTION = "UP 主说 MLA 能省 93% KV Cache，有依据吗？这个超纲概念怎么理解？";
export const WEBSEARCH_CONCLUSION = "论文摘要：DeepSeek-V2 相比 DeepSeek 67B，KV Cache 减少 93.3%";

const WEBSEARCH_HEADLINE_LINES: HeadlinePart[][] = [
  [{text: "UP 主说得"}, {text: "对不对", accent: true}, {text: "？"}],
  [{text: "AI 联网检索辅助核对", accent: true}, {text: "。"}]
];

export const WebSearchScene = () => {
  const frame = useCurrentFrame();
  const {blur, focusScale} = usePanelHandoffFocus(WEBSEARCH_TIMELINE.duration, WEBSEARCH_HANDOFF, APPEARANCE_HANDOFF);
  const verifyReveal = interpolate(
    frame,
    [WEBSEARCH_TIMELINE.verifyCardAt - 6, WEBSEARCH_TIMELINE.verifyCardAt + 8],
    [0, 1],
    {...CLAMP, easing: SMOOTH}
  );

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <BrandWhisper />
      <SectionHeadline lines={WEBSEARCH_HEADLINE_LINES} subtext={WEBSEARCH_SUBHEADLINE} />

      <VideoReferenceCard
        variant="bar"
        width={760}
        headerText="正在阅读：复旦赵斌《大模型公开课》48:16"
        badgeText="联网检索 · 背景补充"
        delay={4}
        style={{position: "absolute", left: 96, top: 690}}
      />

      {/* Right AI Web Search Panel */}
      <div
        style={{
          position: "absolute",
          left: 916,
          top: 156,
          width: 908,
          transformOrigin: "0 0",
          scale: focusScale,
          filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined
        }}
      >
        <div
          style={{
            position: "relative",
            width: 908,
            borderRadius: 30,
            background: MIST_GLASS.surface,
            backdropFilter: "blur(24px) saturate(1.2)",
            boxShadow: MIST_GLASS.shellShadow,
            padding: "28px 36px 36px",
            transform: microPerspective(-5),
            color: MIST_GLASS.text
          }}
        >
          {/* Header with Web Search Active */}
          <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22}}>
            <div style={{display: "flex", alignItems: "center", gap: 8}}>
              {["字幕", "概览", "AI 对话"].map((tab, idx) => (
                <div
                  key={tab}
                  style={{
                    padding: "10px 22px",
                    borderRadius: 12,
                    background: idx === 2 ? MIST_GLASS.cardElevated : "transparent",
                    boxShadow: idx === 2 ? MIST_GLASS.tabActiveShadow : "none",
                    color: idx === 2 ? MIST_GLASS.accent : MIST_GLASS.muted,
                    fontSize: 21,
                    fontWeight: idx === 2 ? 740 : 580
                  }}
                >
                  {tab}
                </div>
              ))}
            </div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 18px",
                borderRadius: 999,
                background: "rgba(0, 140, 255, 0.14)",
                color: MIST_GLASS.accent,
                fontSize: 19,
                fontWeight: 760
              }}
            >
              <span>🌐 联网搜索 · 已开启</span>
            </div>
          </div>

          {/* User Question Bubble */}
          <div style={{display: "flex", justifyContent: "flex-end", marginBottom: 20}}>
            <div
              style={{
                maxWidth: 760,
                padding: "16px 24px",
                borderRadius: "22px 22px 8px 22px",
                background: "rgba(0, 140, 255, 0.12)",
                color: "#0F172A",
                fontSize: 24,
                fontWeight: 680,
                lineHeight: 1.42
              }}
            >
              {WEBSEARCH_QUESTION}
            </div>
          </div>

          {/* Live Web Sources Pill */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 18,
              fontSize: 19,
              fontWeight: 660,
              color: MIST_GLASS.muted
            }}
          >
            <span
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                background: "rgba(16, 185, 129, 0.14)",
                color: "#047857",
                fontWeight: 740
              }}
            >
              ✓ 检索到 3 个外部来源
            </span>
            <span>arXiv:2405.04434 · DeepSeek-V2 论文</span>
          </div>

          {/* Search Summary + Concept Explanation Card */}
          <div
            style={{
              padding: "24px 28px",
              borderRadius: 24,
              background: MIST_GLASS.cardElevated,
              boxShadow: MIST_GLASS.cardShadow,
              opacity: verifyReveal,
              translate: `0px ${(1 - verifyReveal) * 14}px`
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 18px",
                borderRadius: 999,
                background: "rgba(232, 93, 135, 0.14)",
                color: "#C81E5B",
                fontSize: 22,
                fontWeight: 780,
                marginBottom: 16
              }}
            >
              ✓ {WEBSEARCH_CONCLUSION}
            </div>
            <div style={{fontSize: 24, fontWeight: 660, lineHeight: 1.5, color: "#1E293B"}}>
              <strong>超纲概念补充：</strong>MLA（多头潜在注意力）将键值矩阵联合低秩压缩为潜在向量，从而减少推理时的 KV Cache 占用。
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ==========================================================================
   Scene 7: AppearanceScene (25.0s–28.0s, 90 frames)
   同一阅读面板连续切换 4 种主题实际阅读效果（蓝雾玻璃日/夜 + 数字刊物日/夜）
   搭配字号变大、刊物衬线排版动态变化，彻底移除后台设置菜单
   ========================================================================== */

export const APPEARANCE_THEMES = APPEARANCE_SHOTS;

const APPEARANCE_HEADLINE_LINES: HeadlinePart[][] = [
  [{text: "蓝雾玻璃或"}, {text: "纸质刊物", accent: true}, {text: "，"}],
  [{text: "四款主题"}, {text: "日夜皆宜", accent: true}, {text: "。"}]
];

type ThemeStyleConfig = {
  id: string;
  label: string;
  paletteLabel: string;
  modeLabel: string;
  fontScale: number;
  isSerif: boolean;
  panelBg: string;
  cardBg: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  accentSoft: string;
  border: string;
  shadow: string;
};

const THEME_CONFIGS: readonly ThemeStyleConfig[] = [
  {
    id: "flyme-light",
    label: "蓝雾玻璃 · 日间",
    paletteLabel: "蓝雾玻璃",
    modeLabel: "日间模式",
    fontScale: 1.0,
    isSerif: false,
    panelBg: "linear-gradient(155deg, rgba(242, 247, 253, 0.96) 0%, rgba(232, 241, 250, 0.94) 100%)",
    cardBg: "rgba(255, 255, 255, 0.92)",
    textPrimary: "#0F172A",
    textSecondary: "#475569",
    accent: "#008CFF",
    accentSoft: "rgba(0, 140, 255, 0.14)",
    border: "rgba(0, 140, 255, 0.22)",
    shadow: "-28px 44px 100px -24px rgba(15, 23, 42, 0.22), 0 0 0 1.5px rgba(255, 255, 255, 0.9)"
  },
  {
    id: "flyme-dark",
    label: "蓝雾玻璃 · 夜间",
    paletteLabel: "蓝雾玻璃",
    modeLabel: "夜间模式",
    fontScale: 1.06,
    isSerif: false,
    panelBg: "linear-gradient(155deg, rgba(15, 23, 42, 0.97) 0%, rgba(23, 37, 68, 0.96) 100%)",
    cardBg: "rgba(30, 41, 59, 0.92)",
    textPrimary: "#F8FAFC",
    textSecondary: "#94A3B8",
    accent: "#38BDF8",
    accentSoft: "rgba(56, 189, 248, 0.18)",
    border: "rgba(56, 189, 248, 0.30)",
    shadow: "-28px 44px 104px -22px rgba(2, 6, 23, 0.55), 0 0 56px -14px rgba(56, 189, 248, 0.32)"
  },
  {
    id: "editorial-light",
    label: "数字刊物 · 日间",
    paletteLabel: "数字刊物",
    modeLabel: "日间模式",
    fontScale: 1.12,
    isSerif: true,
    panelBg: "linear-gradient(155deg, #FBF6EC 0%, #F4EBD9 100%)",
    cardBg: "#FFFDF8",
    textPrimary: "#221C16",
    textSecondary: "#6B5E51",
    accent: "#B5472A",
    accentSoft: "rgba(181, 71, 42, 0.14)",
    border: "rgba(181, 71, 42, 0.28)",
    shadow: "-28px 44px 100px -24px rgba(68, 46, 24, 0.26), 0 0 52px -14px rgba(214, 148, 86, 0.28)"
  },
  {
    id: "editorial-dark",
    label: "数字刊物 · 夜间",
    paletteLabel: "数字刊物",
    modeLabel: "夜间模式",
    fontScale: 1.18,
    isSerif: true,
    panelBg: "linear-gradient(155deg, #1C1917 0%, #29231E 100%)",
    cardBg: "#26201B",
    textPrimary: "#F5EFE6",
    textSecondary: "#A89F91",
    accent: "#F59E0B",
    accentSoft: "rgba(245, 158, 11, 0.18)",
    border: "rgba(245, 158, 11, 0.34)",
    shadow: "-28px 44px 104px -22px rgba(12, 10, 9, 0.62), 0 0 64px -12px rgba(245, 158, 11, 0.36)"
  }
] as const;

export function appearanceThemeIndexAtFrame(frame: number): number {
  if (frame < APPEARANCE_TIMELINE.flymeDarkFrom) return 0;
  if (frame < APPEARANCE_TIMELINE.editorialLightFrom) return 1;
  if (frame < APPEARANCE_TIMELINE.editorialDarkFrom) return 2;
  return 3;
}

export const AppearanceScene = () => {
  const frame = useCurrentFrame();
  const {blur, focusScale} = usePanelHandoffFocus(90, APPEARANCE_HANDOFF);
  const themeIndex = appearanceThemeIndexAtFrame(frame);
  const theme = THEME_CONFIGS[themeIndex];
  const fontPercent = Math.round(theme.fontScale * 100);

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      <BrandWhisper />
      <SectionHeadline
        lines={APPEARANCE_HEADLINE_LINES}
        subtext="同一阅读面板连续切换四套日夜主题，字号放大与杂志级衬线排版一目了然。"
      />

      {/* Left 4-Theme Live Switcher Pills */}
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 436,
          width: 740,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          opacity: entranceOpacity(frame, 4, 0)
        }}
      >
        {THEME_CONFIGS.map((item, idx) => {
          const active = idx === themeIndex;
          return (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "18px 24px",
                borderRadius: 20,
                background: active ? "#111827" : "rgba(255, 255, 255, 0.86)",
                color: active ? "#FFFFFF" : COLORS.foreground,
                boxShadow: active
                  ? "0 20px 42px -14px rgba(17, 24, 39, 0.32), 0 0 0 2px rgba(232, 93, 135, 0.55)"
                  : ELEVATION.cardSoft,
                scale: active ? 1.02 : 1
              }}
            >
              <span style={{fontSize: 23, fontWeight: 740}}>{item.label}</span>
              <span
                style={{
                  padding: "4px 12px",
                  borderRadius: 999,
                  background: active ? "rgba(251, 114, 153, 0.24)" : "rgba(15, 23, 42, 0.06)",
                  color: active ? "#FB7299" : COLORS.muted,
                  fontFamily: BRAND_FONT_FAMILY,
                  fontSize: 18,
                  fontWeight: 760
                }}
              >
                {Math.round(item.fontScale * 100)}%
              </span>
            </div>
          );
        })}
      </div>

      {/* Right Reading Panel: Pure Reading Experience (Zero Settings Menu) */}
      <div
        style={{
          position: "absolute",
          left: 916,
          top: 136,
          width: 908,
          transformOrigin: "0 0",
          scale: focusScale,
          filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined
        }}
      >
        <div
          style={{
            position: "relative",
            width: 908,
            borderRadius: 32,
            background: theme.panelBg,
            boxShadow: theme.shadow,
            border: `1.5px solid ${theme.border}`,
            padding: "30px 38px 38px",
            transform: microPerspective(-6),
            color: theme.textPrimary,
            fontFamily: theme.isSerif ? SERIF_FONT_FAMILY : FONT_FAMILY
          }}
        >
          {/* Top Reader Bar with Live Theme & Font Scale HUD */}
          <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22}}>
            <div style={{display: "flex", alignItems: "center", gap: 10}}>
              <span
                style={{
                  padding: "7px 16px",
                  borderRadius: 999,
                  background: theme.accentSoft,
                  color: theme.accent,
                  fontSize: 19,
                  fontWeight: 780,
                  fontFamily: FONT_FAMILY
                }}
              >
                {theme.label}
              </span>
              <span
                style={{
                  padding: "7px 14px",
                  borderRadius: 999,
                  background: theme.accentSoft,
                  color: theme.accent,
                  fontSize: 18,
                  fontWeight: 740,
                  fontFamily: FONT_FAMILY
                }}
              >
                {theme.isSerif ? "刊物衬线排版" : "现代无衬线"} · 字号 {fontPercent}%
              </span>
            </div>
            <span style={{color: theme.textSecondary, fontSize: 19, fontWeight: 640, fontFamily: FONT_FAMILY}}>
              复旦赵斌 · 大模型公开课
            </span>
          </div>

          {/* Magazine / Reader Article Card */}
          <div
            style={{
              padding: "28px 32px",
              borderRadius: 24,
              background: theme.cardBg,
              border: `1px solid ${theme.border}`,
              marginBottom: 18
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 14,
                fontFamily: BRAND_FONT_FAMILY
              }}
            >
              <span
                style={{
                  padding: "5px 14px",
                  borderRadius: 999,
                  background: theme.accentSoft,
                  color: theme.accent,
                  fontSize: 19,
                  fontWeight: 780
                }}
              >
                02:32 章节精读
              </span>
              <span style={{fontSize: 19, color: theme.textSecondary, fontFamily: FONT_FAMILY}}>
                {theme.isSerif ? "DIGITAL EDITORIAL EDITION" : "MIST GLASS READER"}
              </span>
            </div>

            <div
              style={{
                fontSize: Math.round(28 * theme.fontScale),
                fontWeight: 780,
                lineHeight: 1.32,
                letterSpacing: theme.isSerif ? 0.2 : -0.6,
                marginBottom: 14
              }}
            >
              大模型为什么宁可编造答案，也不愿承认「我不知道」？
            </div>

            <div
              style={{
                fontSize: Math.round(21 * theme.fontScale),
                lineHeight: 1.62,
                color: theme.textSecondary,
                marginBottom: 18
              }}
            >
              现行评测体系按答对计分、空缺记零分，激励模型在不确定时依然输出高置信度文本，从而产生系统性幻觉。
            </div>

            <div
              style={{
                padding: "16px 22px",
                borderLeft: `4px solid ${theme.accent}`,
                background: theme.accentSoft,
                borderRadius: "0 16px 16px 0",
                fontSize: Math.round(22 * theme.fontScale),
                fontWeight: 720,
                color: theme.textPrimary
              }}
            >
              “如果他不答，一定是零分；哪怕瞎猜，也有概率得分。”
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
