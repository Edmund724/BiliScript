import {AbsoluteFill, Easing, OffthreadVideo, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  APPEARANCE_SHOTS,
  APPEARANCE_TIMELINE,
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_PLAYER_VERIFY_TO,
  CHAT_TIMESTAMP_CLICK_FRAME,
  PANEL_FOCUS_HANDOFFS,
  SCENES,
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
const CHAT_DURATION = SCENES.find((scene) => scene.id === "chat")!.duration;

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
  subtext,
  subtextOpacity = 1
}: {
  lines: HeadlinePart[][];
  opacity?: number;
  subtext?: string;
  subtextOpacity?: number;
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
            opacity: entranceOpacity(frame, 6, 0) * subtextOpacity,
            translate: `0px ${((1 - subtextOpacity) * 10).toFixed(1)}px`
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
  const width = interpolate(progress, [0, 1], [CHAT_REFERENCE.width, CHAT_PLAYER.width], CLAMP);
  const height = interpolate(
    progress,
    [0, 1],
    [Math.round((CHAT_REFERENCE.width * CHAT_PLAYER.height) / CHAT_PLAYER.width), CHAT_PLAYER.height],
    CLAMP
  );
  const top = interpolate(progress, [0, 1], [CHAT_REFERENCE_WINDOW_TOP, CHAT_PLAYER.top], CLAMP);
  const cropScale = width / PLAYER_CROP.width;
  const borderRadius = interpolate(progress, [0, 1], [20, 26], CLAMP);
  const topOffset = 28 * (width / CHAT_PLAYER.width);
  const seeked = frame >= CHAT_TIMESTAMP_CLICK_FRAME + 2;

  return (
    <div
      style={{
        position: "absolute",
        left: CHAT_PLAYER.left,
        top,
        width,
        height,
        opacity: entranceOpacity(frame, 2, 0),
        zIndex: 6
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          borderRadius,
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
            top: -PLAYER_CROP.y * cropScale - topOffset,
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
  const {blur, focusScale} = usePanelHandoffFocus(CHAT_DURATION, CHAT_HANDOFF, SUBTOOLS_HANDOFF);

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

  const panelZoom = panelScale * focusScale;

  return (
    <div
      style={{
        position: "absolute",
        left: panelLeft,
        top: 300,
        width: 880,
        filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined
      }}
    >
      <div
        style={{
          position: "relative",
          width: 880,
          borderRadius: 30,
          overflow: "hidden",
          background: MIST_GLASS.surface,
          backdropFilter: "blur(24px) saturate(1.2)",
          WebkitBackdropFilter: "blur(24px) saturate(1.2)",
          boxShadow: MIST_GLASS.shellShadow,
          padding: "28px 36px 36px",
          zoom: Math.abs(panelZoom - 1) > 0.001 ? panelZoom : undefined,
          transform: microPerspective(-6),
          transformOrigin: "50% 50%",
          color: MIST_GLASS.text
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: MIST_GLASS.blobs,
            filter: "blur(28px)",
            pointerEvents: "none"
          }}
        />

        <div style={{position: "relative", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20}}>
          <span style={{color: MIST_GLASS.muted, fontSize: 22, fontWeight: 620}}>UP主: 复旦赵斌</span>
          <div style={{display: "flex", alignItems: "center", gap: 18, color: MIST_GLASS.text}}>
            <AppearanceIcon name="theme" size={22} />
            <AppearanceIcon name="settings" size={22} />
            <AppearanceIcon name="close" size={22} />
          </div>
        </div>

        <div
          style={{
            position: "relative",
            zIndex: 1,
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr auto",
            alignItems: "center",
            gap: 10,
            paddingBottom: 18,
            borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
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
                background: idx === 2 ? MIST_GLASS.cardElevated : "transparent",
                boxShadow: idx === 2 ? MIST_GLASS.tabActiveShadow : "none",
                color: idx === 2 ? MIST_GLASS.accent : MIST_GLASS.muted,
                fontSize: 21,
                fontWeight: idx === 2 ? 740 : 620
              }}
            >
              {tab}
            </div>
          ))}
          <div style={{padding: "0 10px", color: MIST_GLASS.muted, fontSize: 22, fontWeight: 700}}>⋮</div>
        </div>

        <div style={{position: "relative", zIndex: 1, opacity: answerReveal}}>
          <div style={{display: "flex", justifyContent: "flex-end", marginBottom: 30}}>
            <div
              style={{
                maxWidth: 720,
                padding: "16px 26px",
                borderRadius: "22px 22px 8px 22px",
                background: "rgba(0, 140, 255, 0.12)",
                boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.72)",
                color: MIST_GLASS.text,
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
                  background: MIST_GLASS.accentSoft,
                  color: MIST_GLASS.accent,
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
              <span style={{fontSize: 28, fontWeight: 700, color: MIST_GLASS.text, letterSpacing: -0.6, whiteSpace: "nowrap"}}>
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
                    background: isClicked ? "rgba(0, 140, 255, 0.18)" : MIST_GLASS.timeBg,
                    boxShadow:
                      highlightOpacity > 0.05
                        ? `0 14px 32px -8px rgba(0, 140, 255, ${(0.48 * highlightOpacity).toFixed(2)}), 0 0 0 2.5px rgba(0, 140, 255, ${(0.58 * highlightOpacity).toFixed(2)})`
                        : "0 0 0 1px rgba(0, 140, 255, 0.24)",
                    fontFamily: BRAND_FONT_FAMILY,
                    fontSize: 28,
                    fontWeight: 750,
                    color: MIST_GLASS.timeColor,
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
                      background: "rgba(0, 140, 255, 0.26)",
                      boxShadow: "0 0 32px rgba(0, 140, 255, 0.55)",
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
   Scene 5: SubtoolsScene (20.0s–24.5s, 135 frames)
   两拍：0–66 无字幕的视频整段转写；66–135 视频自带双轨时的中英对照与复制导出
   （双语对照只在视频本身有两条字幕轨时成立，复制导出并入第二拍的副行）
   ========================================================================== */

const SUBTOOLS_ASR_HEADLINE_LINES: HeadlinePart[][] = [
  [{text: "没字幕的视频，"}],
  [{text: "整段转成文字", accent: true}, {text: "。"}]
];

const SUBTOOLS_BILINGUAL_HEADLINE_LINES: HeadlinePart[][] = [
  [{text: "中英双轨，"}],
  [{text: "逐句对照着看", accent: true}, {text: "。"}]
];

export const SUBTOOLS_ROWS = [
  {
    timestamp: "01:14",
    source: "Attention mechanisms allow the model to focus on relevant tokens.",
    translation: "注意力机制让模型能够聚焦于上下文中最相关的词元。",
    active: true
  },
  {
    timestamp: "01:28",
    source: "We project queries, keys, and values into latent subspaces.",
    translation: "我们将查询、键与值向量投影至低维潜在子空间。",
    active: false
  },
  {
    timestamp: "01:42",
    source: "Softmax normalizes attention weights across the sequence.",
    translation: "Softmax 在序列维度上对注意力权重进行归一化。",
    active: false
  }
] as const;

const SUBTOOLS_EXPORT_BUTTONS = ["复制字幕", "导出字幕"] as const;

export const SubtoolsScene = () => {
  const frame = useCurrentFrame();
  const {blur, focusScale} = usePanelHandoffFocus(SUBTOOLS_TIMELINE.duration, SUBTOOLS_HANDOFF, WEBSEARCH_HANDOFF);
  const bilingualAt = SUBTOOLS_TIMELINE.bilingualAt;
  const sublineAt = SUBTOOLS_TIMELINE.exportAt;
  const clickAt = SUBTOOLS_TIMELINE.exportClickAt;
  const isExported = frame >= clickAt;
  const showCheck = frame >= clickAt + 2;
  const dualActive = frame >= bilingualAt;
  const dualReveal = dualActive ? 1 : 0;

  const asrFadeOut = interpolate(frame, [bilingualAt - 2, bilingualAt], [0, 1], CLAMP);
  const sublineReveal = interpolate(frame, [sublineAt, sublineAt + 6], [0, 1], {...CLAMP, easing: SMOOTH});
  const asrStatusIn = interpolate(frame, [6, 12], [0, 1], CLAMP) * (1 - asrFadeOut);

  const copyHoverOpacity = interpolate(frame, [clickAt - 10, clickAt - 4, clickAt + 2, clickAt + 8], [0, 1, 1, 0], CLAMP);
  const copyPopScale = showCheck
    ? interpolate(frame, [clickAt + 2, clickAt + 8], [0.7, 1], {...CLAMP, easing: Easing.bezier(0.34, 1.56, 0.64, 1)})
    : 1;
  const copyPopOpacity = showCheck ? interpolate(frame, [clickAt + 2, clickAt + 7], [0.6, 1], CLAMP) : 1;
  const copyPressScale = interpolate(frame, [clickAt - 2, clickAt, clickAt + 3], [1, 0.91, 1], CLAMP);
  const statusSlideProgress = interpolate(frame, [clickAt, clickAt + 8], [0, 1], {...CLAMP, easing: SMOOTH});
  const pointerOpacity =
    interpolate(frame, [clickAt - 16, clickAt - 10], [0, 1], CLAMP) *
    interpolate(frame, [clickAt + 2, clickAt + 8], [1, 0], CLAMP);
  const pointerX = interpolate(frame, [clickAt - 16, clickAt - 2], [96, 22], {...CLAMP, easing: SMOOTH});
  const pointerY = interpolate(frame, [clickAt - 16, clickAt - 2], [84, 24], {...CLAMP, easing: SMOOTH});

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <BrandWhisper />
      <SectionHeadline
        lines={SUBTOOLS_ASR_HEADLINE_LINES}
        subtext="免费语音识别 · 412 条字幕"
        opacity={1 - asrFadeOut}
      />
      <SectionHeadline
        lines={SUBTOOLS_BILINGUAL_HEADLINE_LINES}
        subtext="选中复制 · SRT / Markdown / TXT"
        opacity={dualReveal}
        subtextOpacity={sublineReveal}
      />

      <div style={{position: "absolute", left: 96, top: 430, opacity: 1 - dualReveal}}>
        <VideoReferenceCard
          variant="bar"
          width={760}
          headerText="正在阅读：MIT 6.S191 · 英文生肉"
          badgeText="无原生字幕"
          delay={4}
        />
      </div>
      <div style={{position: "absolute", left: 96, top: 430, opacity: dualReveal}}>
        <VideoReferenceCard
          variant="bar"
          width={760}
          headerText="正在阅读：MIT 6.S191 · 中英双轨"
          badgeText="2 条字幕轨"
          delay={4}
        />
      </div>

      {/* Right Subtitle Panel */}
      <div
        style={{
          position: "absolute",
          left: 916,
          top: 132,
          width: 908,
          transformOrigin: "0 0",
          scale: undefined,
          filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined
        }}
      >
        <div
          style={{
            position: "relative",
            width: 908,
            borderRadius: 30,
            overflow: "hidden",
            background: MIST_GLASS.surface,
            backdropFilter: "blur(24px) saturate(1.2)",
            boxShadow: MIST_GLASS.shellShadow,
            padding: "22px 26px 26px",
            transform: microPerspective(-5, focusScale),
            color: MIST_GLASS.text
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: MIST_GLASS.blobs,
              filter: "blur(28px)",
              pointerEvents: "none"
            }}
          />

          {/* Row 1: .biliscript-reading-header */}
          <div
            style={{
              position: "relative",
              zIndex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 6px",
              marginBottom: 8
            }}
          >
            <span style={{fontSize: 22, fontWeight: 620, color: MIST_GLASS.muted}}>UP主：MIT 6.S191</span>
            <div style={{display: "flex", alignItems: "center", gap: 18, color: MIST_GLASS.text}}>
              <AppearanceIcon name="theme" size={22} />
              <AppearanceIcon name="settings" size={22} />
              <AppearanceIcon name="close" size={22} />
            </div>
          </div>

          {/* Row 2: #biliscript-reading-status */}
          <div
            style={{
              position: "relative",
              zIndex: 1,
              padding: "0 6px",
              marginBottom: 12,
              minHeight: 30,
              display: "flex",
              alignItems: "center",
              fontSize: 22,
              fontWeight: 620,
              color: MIST_GLASS.muted
            }}
          >
            {isExported ? (
              <span style={{opacity: statusSlideProgress, translate: `0px ${(1 - statusSlideProgress) * 4}px`}}>
                字幕已复制到剪贴板。
              </span>
            ) : (
              <span style={{opacity: asrStatusIn}}>语音识别完成，已生成 412 条字幕。</span>
            )}
          </div>

          {/* Row 3: .biliscript-reading-tabs-row */}
          <div
            style={{
              position: "relative",
              zIndex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 16
            }}
          >
            <div
              style={{
                display: "inline-grid",
                gridAutoFlow: "column",
                gridAutoColumns: "1fr",
                gap: 6,
                padding: 5,
                borderRadius: 18,
                background: "#e9ebef"
              }}
            >
              {["字幕", "概览", "AI 对话"].map((tab, idx) => (
                <div
                  key={tab}
                  style={{
                    minWidth: 112,
                    padding: "9px 24px",
                    borderRadius: 14,
                    background: idx === 0 ? MIST_GLASS.cardElevated : "transparent",
                    boxShadow: idx === 0 ? MIST_GLASS.tabActiveShadow : "none",
                    color: idx === 0 ? MIST_GLASS.accent : MIST_GLASS.muted,
                    fontSize: 22,
                    fontWeight: idx === 0 ? 700 : 600,
                    textAlign: "center"
                  }}
                >
                  {tab}
                </div>
              ))}
            </div>
          </div>

          {/* Row 4: .biliscript-reading-tab-body */}
          <div
            style={{
              position: "relative",
              zIndex: 1,
              padding: "18px 20px 20px",
              borderRadius: 26,
              background: MIST_GLASS.card,
              boxShadow: MIST_GLASS.cardShadow
            }}
          >
            {/* .biliscript-reading-sub-toolbar */}
            <div style={{display: "flex", alignItems: "center", gap: 12, marginBottom: 16}}>
              {/* .biliscript-reading-search */}
              <div
                style={{
                  flex: "1 1 180px",
                  height: 46,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 8px 0 16px",
                  borderRadius: 20,
                  border: "1px solid #dcdfe5",
                  background: MIST_GLASS.cardElevated
                }}
              >
                <span style={{fontSize: 22, color: MIST_GLASS.faint}}>搜索字幕…</span>
                <div style={{display: "flex", alignItems: "center", gap: 4, color: MIST_GLASS.muted, opacity: 0.45, fontSize: 20}}>
                  <span style={{width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center"}}>↑</span>
                  <span style={{width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center"}}>↓</span>
                </div>
              </div>

              {/* .biliscript-reading-track-picker（.custom-select-trigger + .biliscript-bilingual-badge） */}
              <div
                style={{
                  flex: "0 0 auto",
                  height: 46,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 14px",
                  borderRadius: 20,
                  border: "1px solid #dcdfe5",
                  background: MIST_GLASS.cardElevated,
                  color: MIST_GLASS.text,
                  fontSize: 22,
                  fontWeight: 600
                }}
              >
                <span>{dualActive ? "英文" : "自配平台转写（英文）"}</span>
                {dualActive && (
                  <span
                    style={{
                      padding: "2px 9px",
                      borderRadius: 6,
                      background: MIST_GLASS.accentSoft,
                      color: MIST_GLASS.accent,
                      fontSize: 20,
                      fontWeight: 720,
                      lineHeight: "24px"
                    }}
                  >
                    双语
                  </span>
                )}
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={MIST_GLASS.faint} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* #biliscript-reading-copy-subtitle-btn (.biliscript-reading-icon-btn) */}
              <div
                aria-label={showCheck ? "已复制" : SUBTOOLS_EXPORT_BUTTONS[0]}
                style={{
                  position: "relative",
                  width: 46,
                  height: 46,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 16,
                  background: `rgba(23, 24, 26, ${(0.06 * copyHoverOpacity).toFixed(3)})`,
                  color: showCheck ? MIST_GLASS.accent : MIST_GLASS.text,
                  scale: copyPressScale
                }}
              >
                <div style={{display: "inline-flex", scale: copyPopScale, opacity: copyPopOpacity}}>
                  {showCheck ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="10" height="10" rx="2" />
                      <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </div>
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

              {/* #biliscript-reading-export-subtitle-btn (.biliscript-reading-icon-btn) */}
              <div
                aria-label={SUBTOOLS_EXPORT_BUTTONS[1]}
                style={{
                  width: 46,
                  height: 46,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 16,
                  background: "transparent",
                  color: MIST_GLASS.text
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
                  <path d="M12 3v12" />
                  <path d="m7 10 5 5 5-5" />
                </svg>
              </div>
            </div>

            {/* .biliscript-reading-subtitle */}
            <div style={{display: "flex", flexDirection: "column", gap: 6, padding: "4px 4px 2px"}}>
              {SUBTOOLS_ROWS.map((row) => (
                <div
                  key={row.timestamp}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "82px minmax(0, 1fr)",
                    gap: 14,
                    alignItems: "start",
                    padding: "14px 16px",
                    borderRadius: 22,
                    background: row.active ? MIST_GLASS.cardElevated : "transparent",
                    boxShadow: row.active ? MIST_GLASS.tabActiveShadow : "none"
                  }}
                >
                  {/* .biliscript-reading-time */}
                  <span
                    style={{
                      justifySelf: "start",
                      alignSelf: "start",
                      padding: row.active ? "2px 10px" : 0,
                      borderRadius: 999,
                      background: row.active ? MIST_GLASS.timeBg : "transparent",
                      color: row.active ? MIST_GLASS.timeColor : MIST_GLASS.muted,
                      fontFamily: BRAND_FONT_FAMILY,
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 22,
                      fontWeight: 680,
                      lineHeight: 1.5
                    }}
                  >
                    {row.timestamp}
                  </span>

                  {/* .biliscript-reading-text + .biliscript-reading-subtext（副行只在双语态出现） */}
                  <div style={{minWidth: 0, lineHeight: 1.48}}>
                    <div style={{fontSize: 22, fontWeight: row.active ? 680 : 540, color: MIST_GLASS.text}}>
                      {row.source}
                    </div>
                    <div
                      style={{
                        marginTop: 4 * dualReveal,
                        maxHeight: 40 * dualReveal,
                        opacity: dualReveal,
                        overflow: "hidden",
                        fontSize: 21,
                        fontWeight: 520,
                        lineHeight: 1.42,
                        color: MIST_GLASS.faint
                      }}
                    >
                      {row.translation}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* .biliscript-bilingual-footer：双语开关 + 单轨说明 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 12,
                marginTop: 14,
                padding: "0 4px"
              }}
            >
              <span style={{fontSize: 21, fontWeight: 640, color: MIST_GLASS.muted}}>双语字幕</span>
              {dualActive ? null : (
                <span style={{fontSize: 21, color: MIST_GLASS.muted}}>本视频只有一条字幕轨</span>
              )}
              <span
                style={{
                  width: 46,
                  height: 26,
                  borderRadius: 999,
                  background: dualActive ? MIST_GLASS.accent : "#d5d8dd",
                  display: "inline-flex",
                  alignItems: "center",
                  padding: 3
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 999,
                    background: "#ffffff",
                    translate: `${dualActive ? 20 : 0}px 0px`
                  }}
                />
              </span>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ==========================================================================
   Scene 6: WebSearchScene (24.5s–27.0s, 75 frames)
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
          scale: undefined,
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
            transform: microPerspective(-5, focusScale),
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
                fontSize: 22,
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
              fontSize: 21,
              fontWeight: 680,
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
   Scene 7: AppearanceScene (27.0s–29.0s, 60 frames)
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
    panelBg: "linear-gradient(155deg, rgba(16, 17, 20, 0.97) 0%, rgba(27, 31, 38, 0.96) 100%)",
    cardBg: "rgba(35, 38, 43, 0.92)",
    textPrimary: "#F4F5F7",
    textSecondary: "#A3A8B3",
    accent: "#3D9BFF",
    accentSoft: "rgba(61, 155, 255, 0.18)",
    border: "rgba(255, 255, 255, 0.12)",
    shadow: "-28px 44px 104px -22px rgba(2, 6, 23, 0.55), 0 0 56px -14px rgba(61, 155, 255, 0.24)"
  },
  {
    id: "editorial-light",
    label: "数字刊物 · 日间",
    paletteLabel: "数字刊物",
    modeLabel: "日间模式",
    fontScale: 1.12,
    isSerif: true,
    panelBg: "linear-gradient(155deg, #FAF7F2 0%, #F5F0E8 100%)",
    cardBg: "#F3EDE2",
    textPrimary: "#2A2521",
    textSecondary: "#6F665C",
    accent: "#B85435",
    accentSoft: "rgba(184, 84, 53, 0.12)",
    border: "#E4DCCB",
    shadow: "-28px 44px 100px -24px rgba(68, 46, 24, 0.26), 0 0 52px -14px rgba(184, 84, 53, 0.20)"
  },
  {
    id: "editorial-dark",
    label: "数字刊物 · 夜间",
    paletteLabel: "数字刊物",
    modeLabel: "夜间模式",
    fontScale: 1.18,
    isSerif: true,
    panelBg: "linear-gradient(155deg, #171513 0%, #211E1B 100%)",
    cardBg: "#211E1B",
    textPrimary: "#ECE6DF",
    textSecondary: "#9E9489",
    accent: "#E07A5F",
    accentSoft: "rgba(224, 122, 95, 0.16)",
    border: "#3A322C",
    shadow: "-28px 44px 104px -22px rgba(12, 10, 9, 0.62), 0 0 64px -12px rgba(224, 122, 95, 0.24)"
  }
] as const;

export function appearanceThemeIndexAtFrame(frame: number): number {
  if (frame < APPEARANCE_TIMELINE.flymeDarkFrom) return 0;
  if (frame < APPEARANCE_TIMELINE.editorialLightFrom) return 1;
  if (frame < APPEARANCE_TIMELINE.editorialDarkFrom) return 2;
  return 3;
}

const APPEARANCE_CHAPTERS = [
  {
    timestamp: "0:00",
    title: "机器幻觉的成因：大模型的评分机制与语言本质",
    summary: "通过考试猜题的类比，解释大模型训练机制中“答错不扣分、答对得非零分、不答得零分”的逻辑，说明模型宁可“蒙”也不空着；同时指出对话模型只模仿语言规律，追求“说得像人”而非“事实正确”。"
  },
  {
    timestamp: "2:32",
    title: "幻觉无法彻底避免：商业价值与数据局限",
    summary: "分析若模型过度谨慎只会回答“不知道”则失去商业价值。即使给出大量精确数据，也无法推测无关联的事实，因此幻觉无法彻底杜绝，只能通过横向比对和多重查证来降低。"
  },
  {
    timestamp: "4:27",
    title: "人机协作国际象棋实验：适配重于强弱",
    summary: "介绍一项“强AI与弱搭档”协作的下象棋实验。结果显示懂得为同伴留后路、注重协作的组合击败了单纯追求最强算力的组合，证明协作中强弱并非决定因素。"
  }
] as const;

const APPEARANCE_QUOTES = [
  {
    timestamp: "2:10",
    content: "他只要去答这个题目，得的就不是零分，但是他如果不答一定是零分。我们训练大模型的时候就是这样训练的，那么在这种情况下，他一定会去蒙。"
  },
  {
    timestamp: "2:59",
    content: "它模仿的只是语言规律。对于它来说，只要这句话说得像个人说的自然语言就成了，而不在乎它是不是事实，它并不知道什么是事实。"
  }
] as const;

const AppearanceIcon = ({name, size = 20}: {name: "play" | "share" | "copy" | "theme" | "settings" | "close"; size?: number}) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={name === "play" ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {name === "play" ? <path d="M8.8 5.5v13l11-6.5z" /> : null}
    {name === "share" ? (
      <>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
      </>
    ) : null}
    {name === "copy" ? (
      <>
        <rect x="9" y="9" width="10" height="10" rx="2" />
        <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" />
      </>
    ) : null}
    {name === "theme" ? (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 4v16" />
        <path d="M12 4a8 8 0 0 1 0 16" fill="currentColor" stroke="none" />
      </>
    ) : null}
    {name === "settings" ? (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
      </>
    ) : null}
    {name === "close" ? <path d="M18 6 6 18M6 6l12 12" /> : null}
  </svg>
);

export const AppearanceScene = () => {
  const frame = useCurrentFrame();
  const {blur, focusScale} = usePanelHandoffFocus(APPEARANCE_TIMELINE.duration, APPEARANCE_HANDOFF);
  const themeIndex = appearanceThemeIndexAtFrame(frame);
  const theme = THEME_CONFIGS[themeIndex]; const switchStart = [APPEARANCE_TIMELINE.flymeDarkFrom, APPEARANCE_TIMELINE.editorialLightFrom, APPEARANCE_TIMELINE.editorialDarkFrom].filter((f) => frame >= f).pop(); const switchElapsed = switchStart !== undefined ? frame - switchStart : 99; const switchScale = switchElapsed <= 6 ? interpolate(switchElapsed, [0, 2, 6], [0.988, 1.012, 1], {...CLAMP, easing: SMOOTH}) : 1; const switchFlash = switchElapsed <= 7 ? interpolate(switchElapsed, [0, 2, 7], [0, 0.22, 0], CLAMP) : 0;

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
          top: 500,
          width: 740,
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 18,
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
                padding: "20px 26px",
                borderRadius: 22,
                background: active ? "#111827" : "rgba(255, 255, 255, 0.86)",
                color: active ? "#FFFFFF" : COLORS.foreground,
                boxShadow: active
                  ? "0 20px 42px -14px rgba(17, 24, 39, 0.32), 0 0 0 2px rgba(232, 93, 135, 0.55)"
                  : ELEVATION.cardSoft,
                scale: active ? 1.02 : 1
              }}
            >
              <span style={{fontSize: 24, fontWeight: 740}}>{item.label}</span>
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

      <div
        style={{
          position: "absolute",
          left: 916,
          top: 116,
          width: 908,
          transformOrigin: "0 0",
          scale: undefined,
          filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined
        }}
      >
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            boxSizing: "border-box",
            width: 908,
            height: 820,
            borderRadius: 30,
            overflow: "hidden",
            background: theme.panelBg,
            boxShadow: theme.shadow,
            border: `1.5px solid ${switchFlash > 0.02 ? theme.accent : theme.border}`,
            padding: "24px 30px 28px",
            transform: microPerspective(-6, focusScale * switchScale),
            color: theme.textPrimary,
            fontFamily: FONT_FAMILY
          }}
        >
          <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexShrink: 0}}>
            <span style={{fontSize: 17, fontWeight: 650, color: theme.textSecondary}}>UP主：复旦赵斌</span>
            <div style={{display: "flex", alignItems: "center", gap: 18, color: theme.textSecondary}}>
              <AppearanceIcon name="theme" size={19} />
              <AppearanceIcon name="settings" size={19} />
              <AppearanceIcon name="close" size={19} />
            </div>
          </div>

          <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginBottom: 24, flexShrink: 0}}>
            {["字幕", "概览", "AI 对话"].map((tab) => {
              const active = tab === "概览";
              return (
                <span
                  key={tab}
                  style={{
                    minWidth: 108,
                    padding: "10px 24px",
                    borderRadius: 12,
                    background: active ? theme.cardBg : "transparent",
                    boxShadow: active ? "0 2px 8px rgba(15, 23, 42, 0.10)" : "none",
                    color: active ? theme.accent : theme.textSecondary,
                    fontSize: 18,
                    fontWeight: active ? 740 : 580,
                    textAlign: "center"
                  }}
                >
                  {tab}
                </span>
              );
            })}
          </div>

          <div style={{minHeight: 0, overflow: "hidden"}}>
            <div style={{display: "flex", alignItems: "center", gap: 10, marginBottom: 12}}>
              <span style={{fontSize: 20, fontWeight: 760, fontFamily: theme.isSerif ? SERIF_FONT_FAMILY : FONT_FAMILY}}>章节</span>
              <span style={{padding: "2px 7px", borderRadius: 5, background: theme.accentSoft, color: theme.accent, fontSize: 13, fontWeight: 700}}>
                AI 生成
              </span>
            </div>

            <div style={{display: "grid", gap: 12}}>
              {APPEARANCE_CHAPTERS.map((chapter) => (
                <div
                  key={chapter.timestamp}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    gap: 14,
                    padding: "15px 17px",
                    borderRadius: 16,
                    background: theme.cardBg,
                    border: `1px solid ${theme.border}`
                  }}
                >
                  <span
                    style={{
                      alignSelf: "start",
                      padding: "3px 9px",
                      borderRadius: 999,
                      background: theme.accentSoft,
                      color: theme.accent,
                      fontFamily: BRAND_FONT_FAMILY,
                      fontSize: 15,
                      fontWeight: 760,
                      fontVariantNumeric: "tabular-nums"
                    }}
                  >
                    {chapter.timestamp}
                  </span>
                  <div>
                    <div
                      style={{
                        fontSize: Math.round(18 * theme.fontScale),
                        fontWeight: theme.isSerif ? 600 : 730,
                        lineHeight: 1.32,
                        fontFamily: theme.isSerif ? SERIF_FONT_FAMILY : FONT_FAMILY
                      }}
                    >
                      {chapter.title}
                    </div>
                    <div
                      style={{
                        marginTop: 7,
                        color: theme.textSecondary,
                        fontSize: Math.round(14 * theme.fontScale),
                        lineHeight: 1.48
                      }}
                    >
                      {chapter.summary}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{display: "flex", alignItems: "center", gap: 10, marginTop: 18, marginBottom: 12}}>
              <span style={{fontSize: 20, fontWeight: 760, fontFamily: theme.isSerif ? SERIF_FONT_FAMILY : FONT_FAMILY}}>金句</span>
              <span style={{padding: "2px 7px", borderRadius: 5, background: theme.accentSoft, color: theme.accent, fontSize: 13, fontWeight: 700}}>
                AI 精选
              </span>
            </div>

            <div style={{display: "grid", gap: 12}}>
              {APPEARANCE_QUOTES.map((quote) => (
                <div
                  key={quote.timestamp}
                  style={{padding: "14px 18px 11px", borderRadius: 16, background: theme.cardBg, border: `1px solid ${theme.border}`}}
                >
                  <div
                    style={{
                      fontSize: Math.round(17 * theme.fontScale),
                      lineHeight: 1.5,
                      fontFamily: theme.isSerif ? SERIF_FONT_FAMILY : FONT_FAMILY
                    }}
                  >
                    「{quote.content}」
                  </div>
                  <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 9, color: theme.textSecondary}}>
                    <div style={{display: "flex", alignItems: "center", gap: 8}}>
                      <AppearanceIcon name="play" size={16} />
                      <span
                        style={{
                          padding: "3px 9px",
                          borderRadius: 999,
                          background: theme.accentSoft,
                          color: theme.accent,
                          fontFamily: BRAND_FONT_FAMILY,
                          fontSize: 15,
                          fontWeight: 760
                        }}
                      >
                        {quote.timestamp}
                      </span>
                    </div>
                    <div style={{display: "flex", alignItems: "center", gap: 15}}>
                      <AppearanceIcon name="share" size={17} />
                      <AppearanceIcon name="copy" size={17} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
