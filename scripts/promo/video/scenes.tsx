import {AbsoluteFill, Easing, OffthreadVideo, interpolate, staticFile, useCurrentFrame} from "remotion";
import {voiceDuckEmphasisAtFrame} from "../audio.mjs";
import {
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
  EditorialHeaderBand,
  FONT_FAMILY,
  MIST_GLASS,
  ReadingHeaderActions,
  VideoReferenceCard,
  entranceOpacity,
  microPerspective
} from "./design";
import {REVIEW_STORYLINE_TITLE} from "./SubtitleScene";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const WEBSEARCH_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "websearch")!;
const CHAT_FROM = SCENES.find((scene) => scene.id === "chat")!.from;
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
  const voiceEmphasis = voiceDuckEmphasisAtFrame(CHAT_FROM + frame);
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
        scale: 1 + 0.035 * voiceEmphasis,
        transformOrigin: "42% 55%",
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
  enterHandoff?: {enterFrames: number; maxBlur: number},
  exitHandoff?: {exitFrames: number; maxBlur: number}
) => {
  const frame = useCurrentFrame();
  const enterBlur = enterHandoff
    ? interpolate(frame, [0, enterHandoff.enterFrames], [enterHandoff.maxBlur, 0], {...CLAMP, easing: SMOOTH})
    : 0;
  const exitBlur = exitHandoff
    ? interpolate(frame, [totalDuration - exitHandoff.exitFrames, totalDuration], [0, exitHandoff.maxBlur], {
        ...CLAMP,
        easing: SMOOTH
      })
    : 0;
  const blur = Math.max(enterBlur, exitBlur);
  const focusScale =
    (enterHandoff ? interpolate(frame, [0, enterHandoff.enterFrames], [0.97, 1], {...CLAMP, easing: SMOOTH}) : 1) *
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
  const {blur, focusScale} = usePanelHandoffFocus(CHAT_DURATION);

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
  const interactionZoom = interpolate(
    frame,
    [clickAt - 10, clickAt + 3, clickAt + 10, CHAT_PUSH_IN_FROM - 3],
    [1, 1.25, 1.25, 1],
    {...CLAMP, easing: SMOOTH}
  );

  const panelZoom = panelScale * focusScale;

  return (
    <div
      style={{
        position: "absolute",
        left: panelLeft,
        top: 300,
        width: 880,
        zIndex: 8,
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
          transform: microPerspective(-6, interactionZoom),
          transformOrigin: "55% 42%",
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
          <ReadingHeaderActions iconSize={22} />
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
                      border: "3px solid rgba(0, 140, 255, 0.88)",
                      background: "rgba(0, 140, 255, 0.14)",
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
  const voiceEmphasis = voiceDuckEmphasisAtFrame(CHAT_FROM + frame);
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
      <EditorialHeaderBand
        kicker={REVIEW_STORYLINE_TITLE}
        title="有疑问直接问视频，点时间戳直达原话。"
        titleNode={
          <>
            有疑问<span style={{color: COLORS.pink}}>直接问视频</span>，点<span style={{color: COLORS.pink}}>时间戳</span>直达原话。
          </>
        }
        titleSize={52}
        delay={-12}
        opacity={1 - Math.min(1, verifyBlend * 3)}
      />
      <ChatVerifyWindow progress={verifyBlend} />
      <ChatReferenceBar opacity={1 - Math.min(1, verifyBlend * 4)} />
      <ChatHeroPanel panelLeft={panelLeft} panelScale={panelScale} />
      <BottomLectureCaption
        timestamp="04:44"
        speaker="赵老师原声"
        quote={CHAT_VERIFY_QUOTE}
        active={voiceEmphasis > 0.01}
        emphasis={voiceEmphasis}
        from={CHAT_PLAYER_VERIFY_FROM}
        duration={CHAT_PLAYER_VERIFY_TO - CHAT_PLAYER_VERIFY_FROM + 6}
      />
    </AbsoluteFill>
  );
};

/* ==========================================================================
   Scene 2: SubtoolsScene (11.0s–14.5s, 105 frames)
   一气呵成：左侧保留无原生字幕 B 站视频小窗（傅里叶变换），右侧展示免费语音转写 -> 一键复制导出字幕
   ========================================================================== */

const SUBTOOLS_ASR_HEADLINE_LINES: HeadlinePart[][] = [
  [{text: "视频没开字幕？"}],
  [{text: "免费转写", accent: true}, {text: "，一键复制导出。"}]
];

export const SUBTOOLS_ROWS = [
  {
    timestamp: "02:53",
    source: "任何一个周期信号，都可以拆解成正弦波的叠加。",
    active: false
  },
  {
    timestamp: "03:00",
    source: "严格来说要满足狄利克雷条件，工程信号基本都满足。",
    active: true
  },
  {
    timestamp: "03:06",
    source: "抓出基频与奇次谐波，方波在频域里就一目了然。",
    active: false
  }
] as const;

const SUBTOOLS_EXPORT_BUTTONS = ["复制字幕", "导出字幕"] as const;

export const SubtoolsScene = () => {
  const frame = useCurrentFrame();
  const {blur, focusScale} = usePanelHandoffFocus(SUBTOOLS_TIMELINE.duration, undefined, WEBSEARCH_HANDOFF);
  const settledAt = SUBTOOLS_TIMELINE.settledAt;
  const sublineAt = SUBTOOLS_TIMELINE.exportAt;
  const clickAt = SUBTOOLS_TIMELINE.exportClickAt;
  const isExported = frame >= clickAt;
  const showCheck = frame >= clickAt + 2;

  const sublineReveal = interpolate(frame, [sublineAt, sublineAt + 8], [0, 1], {...CLAMP, easing: SMOOTH});
  const asrStatusIn = interpolate(frame, [6, settledAt], [0, 1], CLAMP);

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
  const interactionZoom = interpolate(
    frame,
    [clickAt - 10, clickAt + 3, clickAt + 11, clickAt + 24],
    [1, 1.22, 1.22, 1],
    {...CLAMP, easing: SMOOTH}
  );
  const rippleOpacity = interpolate(frame, [clickAt - 1, clickAt + 1, clickAt + 13], [0, 0.9, 0], CLAMP);
  const rippleScale = interpolate(frame, [clickAt - 1, clickAt + 13], [0.5, 1.9], {...CLAMP, easing: SMOOTH});

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <BrandWhisper />
      <SectionHeadline
        lines={SUBTOOLS_ASR_HEADLINE_LINES}
        subtext={frame >= sublineAt ? "一键复制 · 导出 SRT / Markdown / TXT" : "免费语音识别 · 已转写 286 条中文字幕"}
        subtextOpacity={frame >= sublineAt ? sublineReveal : 1}
      />

      {/* Left Bilibili Video Mini-Window */}
      <VideoReferenceCard
        variant="window"
        source="subtools-fourier.mp4"
        width={760}
        height={428}
        headerText="正在播放：《一听就懂的傅里叶变换》03:00"
        badgeText="无原生 CC 字幕"
        playbackRate={1}
        delay={4}
        crop={{x: 0, y: -71, width: 1920, height: 1080}}
        style={{position: "absolute", left: 96, top: 388}}
      />

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
            transform: microPerspective(-5, focusScale * interactionZoom),
            transformOrigin: "82% 32%",
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
            <span style={{fontSize: 22, fontWeight: 620, color: MIST_GLASS.muted}}>UP主：隔壁的程序员老王</span>
            <ReadingHeaderActions iconSize={22} />
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
              <span style={{opacity: statusSlideProgress, translate: `0px ${(1 - statusSlideProgress) * 4}px`, color: MIST_GLASS.accent}}>
                ✓ 字幕已复制到剪贴板（支持导出 SRT / Markdown / TXT）。
              </span>
            ) : (
              <span style={{opacity: asrStatusIn}}>语音识别完成，已生成 286 条中文字幕。</span>
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

              {/* .biliscript-reading-track-picker */}
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
                <span>语音识别（中文）</span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={MIST_GLASS.faint} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* #biliscript-reading-copy-subtitle-btn */}
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
                <span
                  style={{
                    position: "absolute",
                    inset: -8,
                    borderRadius: 999,
                    border: "2.5px solid rgba(0, 140, 255, 0.88)",
                    background: "rgba(0, 140, 255, 0.12)",
                    boxShadow: "0 0 26px rgba(0, 140, 255, 0.48)",
                    opacity: rippleOpacity,
                    scale: rippleScale,
                    pointerEvents: "none"
                  }}
                />
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

              {/* #biliscript-reading-export-subtitle-btn */}
              <div
                aria-label={SUBTOOLS_EXPORT_BUTTONS[1]}
                style={{
                  position: "relative",
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
                <span
                  style={{
                    position: "absolute",
                    inset: -8,
                    borderRadius: 999,
                    border: "2.5px solid rgba(0, 140, 255, 0.72)",
                    boxShadow: "0 0 24px rgba(0, 140, 255, 0.42)",
                    opacity: rippleOpacity * 0.82,
                    scale: rippleScale,
                    pointerEvents: "none"
                  }}
                />
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
                  <path d="M12 3v12" />
                  <path d="m7 10 5 5 5-5" />
                </svg>
              </div>
            </div>

            {/* .biliscript-reading-subtitle */}
            <div style={{display: "flex", flexDirection: "column", gap: 10, padding: "6px 4px 4px"}}>
              {SUBTOOLS_ROWS.map((row, idx) => {
                const rowAppear = interpolate(frame, [4 + idx * 5, 14 + idx * 5], [0, 1], {...CLAMP, easing: SMOOTH});
                return (
                  <div
                    key={row.timestamp}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "82px minmax(0, 1fr)",
                      gap: 14,
                      alignItems: "center",
                      padding: "16px 18px",
                      borderRadius: 22,
                      background: row.active ? MIST_GLASS.cardElevated : "transparent",
                      boxShadow: row.active ? MIST_GLASS.tabActiveShadow : "none",
                      opacity: rowAppear,
                      translate: `0px ${(1 - rowAppear) * 10}px`
                    }}
                  >
                    <span
                      style={{
                        justifySelf: "start",
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

                    <div style={{minWidth: 0, lineHeight: 1.48}}>
                      <div style={{fontSize: 23, fontWeight: row.active ? 700 : 560, color: MIST_GLASS.text}}>
                        {row.source}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ==========================================================================
   Scene 3: WebSearchScene (14.5s–18.0s, 105 frames)
   主标题：视频里提的新概念？AI 联网搜背景，附来源链接
   左侧保留 B 站原视频小窗（03:00 提到狄利克雷条件），右侧精简文字 + 放大来源标签
   ========================================================================== */

export const WEBSEARCH_HEADLINE = "视频里提的新概念？\nAI 联网搜背景，附来源链接。";
export const WEBSEARCH_SUBHEADLINE = "遇到陌生术语不用切出 B 站，检索公开网页补充背景。";
export const WEBSEARCH_QUESTION = "03:00 提到的「狄利克雷条件」是什么？工程信号为什么满足？";
export const WEBSEARCH_CONCLUSION = "已附 3 条来源链接：Wikipedia · MathWorld · 信号与系统";

const WEBSEARCH_HEADLINE_LINES: HeadlinePart[][] = [
  [{text: "视频里提的"}, {text: "新概念", accent: true}, {text: "？"}],
  [{text: "AI 联网搜背景", accent: true}, {text: "，附来源链接。"}]
];

export const WebSearchScene = () => {
  const frame = useCurrentFrame();
  const {blur, focusScale} = usePanelHandoffFocus(WEBSEARCH_TIMELINE.duration, WEBSEARCH_HANDOFF);
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

      {/* Left Bilibili Video Mini-Window */}
      <VideoReferenceCard
        variant="window"
        source="subtools-fourier.mp4"
        width={760}
        height={428}
        headerText="正在播放：《一听就懂的傅里叶变换》03:00"
        badgeText="联网检索 · 概念背景"
        startFrom={75}
        playbackRate={1}
        delay={0}
        crop={{x: 0, y: -71, width: 1920, height: 1080}}
        style={{position: "absolute", left: 96, top: 388}}
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

          {/* Search Summary + Concept Explanation Card */}
          <div
            style={{
              padding: "26px 30px",
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
                padding: "10px 22px",
                borderRadius: 999,
                background: "rgba(16, 185, 129, 0.14)",
                color: "#047857",
                fontSize: 25,
                fontWeight: 780,
                marginBottom: 18
              }}
            >
              ✓ {WEBSEARCH_CONCLUSION}
            </div>
            <div style={{fontSize: 26, fontWeight: 680, lineHeight: 1.52, color: "#1E293B"}}>
              <strong>狄利克雷条件：</strong>单周期内绝对可积、极值与间断点有限。真实物理信号能量有限且无无穷震荡，天然满足展开条件。
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
