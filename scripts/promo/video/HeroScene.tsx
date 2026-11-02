import {AbsoluteFill, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {HERO_TIMELINE} from "../timeline.mjs";
import {COLORS, FONT_FAMILY, MIST_GLASS, ReadingHeaderActions} from "./design";

const PANEL = {x: 1365, y: 64, width: 540, height: 1016};
const PANEL_SLIDE_FRAMES = 13;
const PANEL_BACKDROP = {x: 1320, y: 64, width: 600, height: 1016};
const PANEL_BACKDROP_SOURCE_FRAME = 32;
const ICON = {x: 1359, y: 563, size: 36};
const CAMERA = {originX: 1470 / 1920, originY: 0.5, zoom: 2.05, drift: 0.04};

export const HERO_SOURCE = {
  recording: "media/hero-hook.mp4",
  panelFrame: 43,
  promptFrame: 60,
  answerFrame: 309,
  answerPlaybackRate: 0.7
};

export const HERO_PAIN_LINES = ["48 分钟硬核长视频，", "没时间从头看？"] as const;
export const HERO_SOLUTION_LINES = ["点一下，", "3 秒变成结构化文章。"] as const;
export const HERO_FEATURE_LINE = "TL;DR · 分节要点 · 时间戳";
const TLDR_PREFIX =
  "这期视频从“机器幻觉为什么无法根除”讲起：UP 主认为大模型天生被训练成“必须作答”，而对话模型只模仿语言规律、不区分“语句通顺”与“事实正确”，因此幻觉不可避免。由此引出核心结论：";
const TLDR_BOLD = "选 AI 不是越强越好，能和你“接得上、对得齐”的才最好";
const TLDR_SUFFIX = "——人和 AI 是协作而非替代，AI 是放大器而非创造器。";

const THEME_BULLETS = [
  {
    startFrame: 90,
    endFrame: 100,
    lead: "机器幻觉的根源是“训练目标”，并非技术缺陷：",
    body: "模型被激励去“蒙一个答案”，因为不答必然是零分。"
  },
  {
    startFrame: 100,
    endFrame: 110,
    lead: "对话式模型模仿的只有语言规律：",
    body: "只要话说得像人说的，它就“成了”，它并不知道什么是事实。"
  },
  {
    startFrame: 114,
    endFrame: 122,
    lead: "幻觉无法避免：",
    body: "哪怕喂精确数据也一样（例子：知道全班 49 人生日，也推不出第 50 人）。"
  },
  {
    startFrame: 122,
    endFrame: 129,
    lead: "AI 与人是协作关系：",
    body: "在协作场景下，最强 AI 不一定带来最大优势，“会配合”的 AI 表现更优。"
  }
] as const;

const fadeIn = (frame: number, from: number, length = 12) =>
  interpolate(frame, [from, from + length], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });

const COPY_LINE_STYLE = {
  fontSize: 64,
  lineHeight: 1.16,
  fontWeight: 700,
  letterSpacing: -2.2,
  whiteSpace: "nowrap"
} as const;

const HeroCopy = () => {
  const frame = useCurrentFrame();
  const painOut = HERO_TIMELINE.clickAt - 2;
  const solutionAt = HERO_TIMELINE.clickAt + 6;
  const painLine1 = fadeIn(frame, HERO_TIMELINE.firstLineAt) * (1 - fadeIn(frame, painOut, 8));
  const painLine2 = fadeIn(frame, HERO_TIMELINE.firstLineAt + 10) * (1 - fadeIn(frame, painOut, 8));
  const solution1 = fadeIn(frame, solutionAt);
  const solution2 = fadeIn(frame, solutionAt + 6);
  const feature = fadeIn(frame, HERO_TIMELINE.pageTurnAt + 8);
  const underline = interpolate(frame, [solutionAt + 14, solutionAt + 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const lineStyle = (opacity: number) => ({
    ...COPY_LINE_STYLE,
    opacity,
    translate: `0px ${((1 - opacity) * 22).toFixed(1)}px`
  });

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 250,
          width: 780,
          height: 370,
          background:
            "radial-gradient(ellipse 68% 62% at 28% 46%, rgba(8, 16, 30, 0.38) 0%, rgba(8, 16, 30, 0.16) 52%, rgba(8, 16, 30, 0) 74%)",
          opacity: Math.max(painLine1, solution1),
          pointerEvents: "none",
          zIndex: 24
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 350,
          width: 600,
          zIndex: 30,
          pointerEvents: "none",
          color: "#FFFFFF",
          textShadow: "0 2px 26px rgba(6, 12, 24, 0.62), 0 1px 3px rgba(6, 12, 24, 0.72)"
        }}
      >
        <div style={{position: "relative", height: 150}}>
          <div style={{position: "absolute", left: 0, top: 0}}>
            <div style={lineStyle(painLine1)}>{HERO_PAIN_LINES[0]}</div>
            <div style={lineStyle(painLine2)}>{HERO_PAIN_LINES[1]}</div>
          </div>
          <div style={{position: "absolute", left: 0, top: 0}}>
            <div style={lineStyle(solution1)}>{HERO_SOLUTION_LINES[0]}</div>
            <div style={lineStyle(solution2)}>
              <span style={{position: "relative", display: "inline-block"}}>
                {HERO_SOLUTION_LINES[1]}
                <span
                  style={{
                    position: "absolute",
                    left: -2,
                    right: -2,
                    bottom: -1,
                    height: 4,
                    borderRadius: 2,
                    background: "linear-gradient(96deg, rgba(255, 212, 59, 0.95) 0%, rgba(251, 114, 153, 0.95) 100%)",
                    boxShadow: "0 0 14px rgba(232, 93, 135, 0.55)",
                    transformOrigin: "0% 50%",
                    transform: `scaleX(${underline.toFixed(3)})`
                  }}
                />
              </span>
            </div>
          </div>
        </div>
        <div
          style={{
            marginTop: 22,
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 26,
            lineHeight: 1.4,
            fontWeight: 500,
            letterSpacing: 0.4,
            color: "rgba(255, 255, 255, 0.94)",
            opacity: feature,
            translate: `0px ${((1 - feature) * 14).toFixed(1)}px`
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#FFA7C2",
              boxShadow: "0 0 12px rgba(255, 167, 194, 0.95)"
            }}
          />
          {HERO_FEATURE_LINE}
        </div>
      </div>
    </>
  );
};

const DurationBadge = () => {
  const frame = useCurrentFrame();
  const appear = fadeIn(frame, 0, 8) * (1 - fadeIn(frame, HERO_TIMELINE.clickAt - 2, 8));
  if (appear <= 0.01) return null;
  const pulse = 0.5 + 0.5 * Math.sin(frame / 3);
  return (
    <div
      style={{
        position: "absolute",
        left: 1228,
        top: 886,
        padding: "8px 18px",
        borderRadius: 12,
        background: "rgba(12, 18, 32, 0.82)",
        border: "2px solid rgba(255, 212, 59, 0.95)",
        boxShadow: `0 0 ${18 + pulse * 14}px rgba(255, 212, 59, ${0.45 + pulse * 0.2})`,
        color: "#FFFFFF",
        fontFamily: FONT_FAMILY,
        fontSize: 34,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
        opacity: appear,
        scale: 0.9 + appear * 0.1,
        zIndex: 20
      }}
    >
      48:16
    </div>
  );
};
const MoreIcon = ({size}: {size: number}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    style={{display: "block", flexShrink: 0}}
  >
    <circle cx="12" cy="5" r="1.4" fill="currentColor" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    <circle cx="12" cy="19" r="1.4" fill="currentColor" />
  </svg>
);

const HeroReadingPanel = ({cameraScale = 1, sceneFrame}: {cameraScale?: number; sceneFrame: number}) => {
  const localFrame = useCurrentFrame();
  const px = (value: number) => value * cameraScale;
  const scaledWidth = 1920 * cameraScale;
  const scaledHeight = 1080 * cameraScale;
  const isSliding = localFrame < PANEL_SLIDE_FRAMES;

  const translateX = interpolate(localFrame, [0, 7], [PANEL.width, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0, 0, 0.2, 1)
  });
  const scaleProgress = interpolate(localFrame, [0, PANEL_SLIDE_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.3, 1.2, 0.4, 1)
  });
  const scaleX = 0.92 + 0.08 * scaleProgress;
  const scaleY = 0.98 + 0.02 * scaleProgress;
  const opacity = interpolate(localFrame, [0, 5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0, 0, 0.2, 1)
  });

  const totalTldrLen = TLDR_PREFIX.length + TLDR_BOLD.length + TLDR_SUFFIX.length;
  const tldrRevealed = Math.round(
    interpolate(sceneFrame, [HERO_TIMELINE.answerAt, HERO_TIMELINE.answerAt + 24, HERO_TIMELINE.answerAt + 34], [8, TLDR_PREFIX.length + 4, totalTldrLen], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
  );

  const prefixText = TLDR_PREFIX.slice(0, Math.min(TLDR_PREFIX.length, tldrRevealed));
  const boldRevealed = Math.max(0, Math.min(TLDR_BOLD.length, tldrRevealed - TLDR_PREFIX.length));
  const boldText = TLDR_BOLD.slice(0, boldRevealed);
  const boldComplete = boldRevealed >= TLDR_BOLD.length;
  const suffixRevealed = Math.max(0, tldrRevealed - TLDR_PREFIX.length - TLDR_BOLD.length);
  const suffixText = TLDR_SUFFIX.slice(0, suffixRevealed);

  return (
    <div
      style={{
        position: "absolute",
        left: px(PANEL_BACKDROP.x),
        top: px(PANEL_BACKDROP.y),
        width: px(PANEL_BACKDROP.width),
        height: px(PANEL_BACKDROP.height),
        overflow: "hidden",
        zIndex: 8,
        pointerEvents: "none"
      }}
    >
      {isSliding ? (
        <OffthreadVideo
          muted
          src={staticFile(HERO_SOURCE.recording)}
          trimBefore={PANEL_BACKDROP_SOURCE_FRAME}
          playbackRate={1}
          style={{
            position: "absolute",
            left: -px(PANEL_BACKDROP.x),
            top: -px(PANEL_BACKDROP.y),
            width: scaledWidth,
            height: scaledHeight,
            maxWidth: "none"
          }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            left: px(1353 - PANEL_BACKDROP.x),
            top: 0,
            width: px(1920 - 1353),
            height: px(PANEL_BACKDROP.height),
            background: "#FFFFFF"
          }}
        />
      )}

      {/* 右侧浏览器滚动条矢量重绘 */}
      <div
        style={{
          position: "absolute",
          left: px(1905 - PANEL_BACKDROP.x),
          top: 0,
          width: px(15),
          height: px(PANEL_BACKDROP.height),
          background: "#F8F9FA",
          borderLeft: `${px(1)}px solid rgba(15, 23, 42, 0.06)`
        }}
      >
        <div
          style={{
            position: "absolute",
            left: px(3),
            top: px(2),
            width: px(8),
            height: px(736),
            borderRadius: px(99),
            background: "#7F7F7F"
          }}
        />
      </div>

      {/* 矢量文摘面板 (#biliscript-reading-view) */}
      <div
        style={{
          position: "absolute",
          left: px(PANEL.x - PANEL_BACKDROP.x),
          top: px(PANEL.y - PANEL_BACKDROP.y),
          width: px(PANEL.width),
          height: px(PANEL.height),
          borderRadius: px(28),
          overflow: "hidden",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(180deg, #EAF2FA 0%, #F2F3F5 210px, #F2F3F5 790px, #E9F1FA 100%)",
          border: `${px(1)}px solid #DCDFE5`,
          boxShadow: `0 ${px(20)}px ${px(48)}px -${px(8)}px rgba(15, 23, 42, 0.14), 0 ${px(4)}px ${px(14)}px -${px(2)}px rgba(15, 23, 42, 0.06)`,
          transformOrigin: "100% 50%",
          translate: isSliding ? `${(translateX * cameraScale).toFixed(2)}px 0px` : undefined,
          scale: isSliding ? `${scaleX.toFixed(4)} ${scaleY.toFixed(4)}` : undefined,
          opacity: isSliding ? opacity : 1,
          fontFamily: FONT_FAMILY,
          color: MIST_GLASS.text
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: MIST_GLASS.blobs,
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
            padding: `${px(14)}px ${px(16)}px ${px(10)}px`,
            flexShrink: 0
          }}
        >
          <span style={{fontSize: px(15.5), lineHeight: 1.45, color: MIST_GLASS.muted, fontWeight: 450}}>
            UP主：复旦赵斌
          </span>
          <ReadingHeaderActions iconSize={px(18)} />
        </div>

        {/* Row 3: .biliscript-reading-tabs-row */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            padding: `${px(2)}px ${px(38)}px ${px(6)}px ${px(22)}px`,
            flexShrink: 0
          }}
        >
          <div
            style={{
              flex: 1,
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              alignItems: "center",
              padding: px(4),
              gap: px(4)
            }}
          >
            {["字幕", "概览", "AI 对话"].map((tab, index) => {
              const active = index === 2;
              return (
                <div
                  key={tab}
                  style={{
                    padding: `${px(7)}px ${px(12)}px`,
                    borderRadius: px(20),
                    background: active ? MIST_GLASS.cardElevated : "transparent",
                    boxShadow: active
                      ? `0 ${px(2)}px ${px(8)}px rgba(23, 24, 26, 0.08), inset 0 ${px(1)}px 0 rgba(255, 255, 255, 0.92)`
                      : "none",
                    color: active ? MIST_GLASS.accent : MIST_GLASS.muted,
                    fontSize: px(13.8),
                    fontWeight: 650,
                    textAlign: "center",
                    whiteSpace: "nowrap"
                  }}
                >
                  {tab}
                </div>
              );
            })}
          </div>
          <div
            style={{
              position: "absolute",
              right: px(10),
              top: "50%",
              translate: "0 -50%",
              color: MIST_GLASS.text,
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            <MoreIcon size={px(18)} />
          </div>
        </div>

        {/* Row 4: .biliscript-reading-chat */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: `${px(10)}px ${px(20)}px ${px(14)}px`
          }}
        >
          {/* .chat-messages */}
          <div style={{display: "flex", flexDirection: "column", gap: px(12), minHeight: 0, overflow: "hidden"}}>
            <div style={{display: "flex", flexDirection: "column", paddingLeft: px(2)}}>
                {/* 1. TL;DR */}
                <div
                  style={{
                    fontSize: px(17.5),
                    fontWeight: 740,
                    lineHeight: 1.38,
                    color: MIST_GLASS.text,
                    marginBottom: px(6)
                  }}
                >
                  1. TL;DR
                </div>
                <div
                  style={{
                    fontSize: px(15),
                    lineHeight: 1.62,
                    color: MIST_GLASS.text,
                    letterSpacing: -0.1,
                    marginBottom: px(14)
                  }}
                >
                  <span>{prefixText}</span>
                  {boldRevealed > 0 && (
                    boldComplete ? (
                      <strong style={{fontWeight: 740}}>{boldText}</strong>
                    ) : (
                      <span>{`**${boldText}`}</span>
                    )
                  )}
                  {suffixRevealed > 0 && <span>{suffixText}</span>}
                </div>

                {/* 2. 主题与核心观点 */}
                {sceneFrame >= 88 && (
                  <>
                    <div
                      style={{
                        fontSize: px(17.5),
                        fontWeight: 740,
                        lineHeight: 1.38,
                        color: MIST_GLASS.text,
                        marginBottom: px(6)
                      }}
                    >
                      2. 主题与核心观点
                    </div>
                    <div style={{display: "flex", flexDirection: "column", gap: px(6)}}>
                      {THEME_BULLETS.map((bullet, index) => {
                        if (sceneFrame < bullet.startFrame) return null;
                        const fullText = `${bullet.lead}${bullet.body}`;
                        const chars = Math.round(
                          interpolate(sceneFrame, [bullet.startFrame, bullet.endFrame], [6, fullText.length], {
                            extrapolateLeft: "clamp",
                            extrapolateRight: "clamp"
                          })
                        );
                        const leadSlice = bullet.lead.slice(0, Math.min(bullet.lead.length, chars));
                        const bodySlice = chars > bullet.lead.length ? bullet.body.slice(0, chars - bullet.lead.length) : "";
                        return (
                          <div
                            key={index}
                            style={{
                              display: "grid",
                              gridTemplateColumns: `${px(14)}px minmax(0, 1fr)`,
                              fontSize: px(15),
                              lineHeight: 1.6,
                              color: MIST_GLASS.text,
                              letterSpacing: -0.1
                            }}
                          >
                            <span style={{fontWeight: 700}}>•</span>
                            <div>
                              <strong style={{fontWeight: 740}}>{leadSlice}</strong>
                              <span>{bodySlice}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
          </div>

          {/* .chat-footer (.chat-input-card) */}
          <div
            style={{
              padding: `${px(10)}px ${px(12)}px ${px(8)}px`,
              borderRadius: px(22),
              background: MIST_GLASS.cardElevated,
              border: `${px(1)}px solid rgba(0, 140, 255, 0.14)`,
              boxShadow: `inset 0 ${px(1)}px 0 0 rgba(255, 255, 255, 0.95), 0 ${px(6)}px ${px(20)}px -${px(4)}px rgba(15, 23, 42, 0.05)`,
              display: "flex",
              flexDirection: "column",
              gap: px(8),
              flexShrink: 0
            }}
          >
            <div style={{fontSize: px(13.8), color: MIST_GLASS.faint, padding: `0 ${px(2)}px`}}>
              回车发送，Shift+Enter 换行
            </div>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: px(8)}}>
              <div
                style={{
                  width: px(28),
                  height: px(28),
                  borderRadius: px(999),
                  border: `${px(1)}px solid #DCDFE5`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: MIST_GLASS.muted
                }}
              >
                <svg
                  width={px(15)}
                  height={px(15)}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
                </svg>
              </div>
              <div style={{display: "flex", alignItems: "center", gap: px(8), marginLeft: "auto"}}>
                <span style={{fontSize: px(12.5), color: MIST_GLASS.text, fontWeight: 550, whiteSpace: "nowrap"}}>
                  ModelScope-DeepSeek-V4.1-Flash-...
                </span>
                <span style={{fontSize: px(12.5), color: MIST_GLASS.muted, whiteSpace: "nowrap"}}>Default ⌄</span>
                <div
                  style={{
                    width: px(28),
                    height: px(28),
                    borderRadius: px(999),
                    background: MIST_GLASS.accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center"
                  }}
                >
                  <div
                    style={{
                      width: px(9),
                      height: px(9),
                      borderRadius: px(2),
                      background: "#FFFFFF"
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const IconOrbit = () => {
  const frame = useCurrentFrame();
  if (frame < HERO_TIMELINE.iconAt || frame >= HERO_SOURCE.panelFrame + 6) return null;

  const appear = interpolate(frame, [HERO_TIMELINE.iconAt, HERO_TIMELINE.iconAt + 7], [0.35, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const fade = interpolate(frame, [HERO_SOURCE.panelFrame + 1, HERO_SOURCE.panelFrame + 6], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const hover = interpolate(frame, [33, 36], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const pulse = frame >= HERO_TIMELINE.clickAt
    ? interpolate(frame, [HERO_TIMELINE.clickAt, HERO_TIMELINE.clickAt + 3, HERO_TIMELINE.clickAt + 12], [0, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic)
      })
    : 0;
  const center = {x: ICON.x + ICON.size / 2, y: ICON.y + ICON.size / 2};

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: center.x,
          top: center.y,
          width: 92,
          height: 92,
          translate: "-50% -50%",
          borderRadius: "50%",
          border: "2px solid rgba(232, 93, 135, 0.92)",
          boxShadow: `0 0 26px rgba(232, 93, 135, ${(0.42 + hover * 0.2).toFixed(2)}), inset 0 0 22px rgba(232, 93, 135, 0.28)`,
          opacity: appear * fade,
          scale: 0.84 + appear * 0.16 + hover * 0.03,
          zIndex: 18
        }}
      />
      <div
        style={{
          position: "absolute",
          left: center.x,
          top: center.y,
          width: 40,
          height: 40,
          translate: "-50% -50%",
          borderRadius: "50%",
          border: "2px solid rgba(232, 93, 135, 0.9)",
          opacity: pulse * 0.9,
          scale: 0.7 + pulse * 2.1,
          zIndex: 19
        }}
      />
      <div
        style={{
          position: "absolute",
          left: center.x,
          top: center.y,
          width: 56,
          height: 56,
          translate: "-50% -50%",
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255, 255, 255, 0.82) 0%, rgba(255, 203, 219, 0.42) 52%, rgba(232, 93, 135, 0) 72%)",
          opacity: pulse * 0.8,
          zIndex: 17
        }}
      />
    </>
  );
};

const CURSOR_PATH = [
  {frame: 0, x: 2006, y: 792},
  {frame: 10, x: 1852, y: 726},
  {frame: 20, x: 1638, y: 626},
  {frame: 29, x: 1468, y: 590},
  {frame: 35, x: 1392, y: 584},
  {frame: HERO_TIMELINE.clickAt, x: 1377, y: 581}
] as const;

const Cursor = () => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, CURSOR_PATH.map((point) => point.frame), CURSOR_PATH.map((point) => point.x), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const y = interpolate(frame, CURSOR_PATH.map((point) => point.frame), CURSOR_PATH.map((point) => point.y), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const opacity = interpolate(frame, [0, 3, 42, 49], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const press = interpolate(frame, [HERO_TIMELINE.clickAt - 2, HERO_TIMELINE.clickAt, HERO_TIMELINE.clickAt + 3], [1, 0.82, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  if (opacity <= 0.01) return null;

  return (
    <svg
      viewBox="0 0 30 38"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 34,
        height: 43,
        translate: `${x}px ${y}px`,
        filter: "drop-shadow(0 4px 9px rgba(8, 15, 30, 0.42))",
        opacity,
        scale: press,
        zIndex: 22
      }}
    >
      <path d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z" fill="white" stroke={COLORS.foreground} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
};

const HeroVideo = ({cameraScale, sceneFrame}: {cameraScale: number; sceneFrame: number}) => {
  const scaledWidth = 1920 * cameraScale;
  const scaledHeight = 1080 * cameraScale;
  return (
    <>
      <Sequence from={0} durationInFrames={HERO_SOURCE.panelFrame}>
        <OffthreadVideo
          muted
          src={staticFile(HERO_SOURCE.recording)}
          playbackRate={1}
          style={{position: "absolute", left: 0, top: 0, width: scaledWidth, height: scaledHeight, maxWidth: "none"}}
        />
      </Sequence>
      <Sequence from={HERO_SOURCE.panelFrame} durationInFrames={HERO_TIMELINE.answerAt - HERO_SOURCE.panelFrame} premountFor={12}>
        <OffthreadVideo
          muted
          src={staticFile(HERO_SOURCE.recording)}
          trimBefore={HERO_SOURCE.promptFrame}
          playbackRate={1}
          style={{position: "absolute", left: 0, top: 0, width: scaledWidth, height: scaledHeight, maxWidth: "none"}}
        />
      </Sequence>
      <Sequence from={HERO_TIMELINE.answerAt} premountFor={24}>
        <OffthreadVideo
          muted
          src={staticFile(HERO_SOURCE.recording)}
          trimBefore={HERO_SOURCE.answerFrame}
          playbackRate={HERO_SOURCE.answerPlaybackRate}
          style={{position: "absolute", left: 0, top: 0, width: scaledWidth, height: scaledHeight, maxWidth: "none"}}
        />
      </Sequence>
      <Sequence from={HERO_SOURCE.panelFrame} premountFor={12}>
        <HeroReadingPanel cameraScale={cameraScale} sceneFrame={sceneFrame} />
      </Sequence>
    </>
  );
};

export const HeroScene = () => {
  const frame = useCurrentFrame();
  const pan = interpolate(frame, [HERO_TIMELINE.pushInFrom, HERO_TIMELINE.pushInFrom + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const zoom = interpolate(frame, [HERO_TIMELINE.pushInFrom, HERO_TIMELINE.pushInTo], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic)
  });
  const settle = interpolate(frame, [HERO_TIMELINE.pushInTo, HERO_TIMELINE.holdAt], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const cameraScale = 1 + zoom * (CAMERA.zoom - 1) + settle * CAMERA.drift;
  const focusX = 960 + (CAMERA.originX * 1920 - 960) * pan;
  const focusY = 540 + (CAMERA.originY * 1080 - 540) * pan;
  const cameraLeft = 960 - focusX * cameraScale;
  const cameraTop = 540 - focusY * cameraScale;

  return (
    <AbsoluteFill style={{background: COLORS.background, fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      <div
        style={{
          position: "absolute",
          left: cameraLeft,
          top: cameraTop,
          width: 1920 * cameraScale,
          height: 1080 * cameraScale
        }}
      >
        <HeroVideo cameraScale={cameraScale} sceneFrame={frame} />
      </div>
      <IconOrbit />
      <Cursor />
      <DurationBadge />
      <HeroCopy />
    </AbsoluteFill>
  );
};
