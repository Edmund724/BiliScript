import {AbsoluteFill, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  APPEARANCE_SHOTS,
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_PLAYER_VERIFY_TO,
  CHAT_SHOTS,
  CHAT_TIMESTAMP_CLICK_FRAME,
  PANEL_FOCUS_HANDOFFS
} from "../timeline.mjs";
import {COLORS, Crop, FONT_FAMILY, PANEL_CROPS, ProductFrame, SceneTitle} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat")!;
const APPEARANCE_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "appearance")!;

const CHAT_BODY_CROP: Crop = {x: 1365, y: 64, width: 540, height: 590};
const CHAT_INPUT_CROP: Crop = {x: 1365, y: 984, width: 540, height: 96};
const PLAYER_CROP: Crop = {x: 54, y: 171, width: 1272, height: 764};

const CHAT_CLICK_TARGET = {x: 1588, y: 392};

const shotOffset = (shots: ReadonlyArray<{duration: number}>, index: number) =>
  shots.slice(0, index).reduce((total, previous) => total + previous.duration, 0);

const ChatTimestampPointer = () => {
  const frame = useCurrentFrame();
  const moveStart = CHAT_TIMESTAMP_CLICK_FRAME - 20;
  const clickAt = CHAT_TIMESTAMP_CLICK_FRAME;
  const moveEnd = CHAT_PLAYER_VERIFY_FROM - 2;
  if (frame < moveStart || frame > moveEnd) return null;

  const pointerOpacity =
    interpolate(frame, [moveStart, moveStart + 5], [0, 1], CLAMP) *
    interpolate(frame, [moveEnd - 6, moveEnd], [1, 0], CLAMP);

  const rippleOpacity = interpolate(frame, [clickAt - 1, clickAt + 1, clickAt + 14], [0, 0.85, 0], CLAMP);
  const rippleScale = interpolate(frame, [clickAt - 1, clickAt + 14], [0.4, 1.85], {...CLAMP, easing: SMOOTH});
  const highlightOpacity = interpolate(frame, [moveStart + 8, clickAt, moveEnd - 4, moveEnd], [0, 1, 1, 0], CLAMP);

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: CHAT_CLICK_TARGET.x - 86,
          top: CHAT_CLICK_TARGET.y - 18,
          width: 172,
          height: 36,
          borderRadius: 12,
          border: `2px solid ${COLORS.pink}`,
          background: frame >= clickAt ? "rgba(232, 93, 135, 0.16)" : "rgba(232, 93, 135, 0.08)",
          boxShadow: "0 10px 28px -12px rgba(232, 93, 135, 0.45)",
          opacity: highlightOpacity,
          pointerEvents: "none"
        }}
      />
      <div
        style={{
          position: "absolute",
          left: CHAT_CLICK_TARGET.x - 28,
          top: CHAT_CLICK_TARGET.y - 28,
          width: 56,
          height: 56,
          borderRadius: "50%",
          border: `3px solid ${COLORS.pink}`,
          opacity: rippleOpacity,
          scale: rippleScale,
          pointerEvents: "none"
        }}
      />
      <svg
        viewBox="0 0 30 38"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 34,
          height: 43,
          filter: "drop-shadow(0 4px 8px rgba(36, 52, 71, 0.35))",
          opacity: pointerOpacity,
          translate: interpolate(
            frame,
            [moveStart, clickAt - 2],
            ["1440px 760px", `${CHAT_CLICK_TARGET.x}px ${CHAT_CLICK_TARGET.y}px`],
            {...CLAMP, easing: SMOOTH}
          ),
          scale: interpolate(frame, [clickAt - 2, clickAt, clickAt + 4], [1, 0.82, 1], CLAMP),
          pointerEvents: "none"
        }}
      >
        <path d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z" fill="white" stroke={COLORS.foreground} strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </>
  );
};

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
      <SceneTitle title={"看完还有问题？\n接着问。"} style={{left: 116, top: 184, width: 740}} />
      <div
        style={{
          position: "absolute",
          left: 116,
          top: 428,
          width: 740,
          padding: "24px 28px",
          borderRadius: 24,
          background: "rgba(255, 255, 255, 0.94)",
          border: "1px solid rgba(83, 110, 134, 0.16)",
          boxShadow: "0 20px 48px -28px rgba(43, 70, 93, 0.22)",
          display: "flex",
          flexDirection: "column",
          gap: 14
        }}
      >
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
          <span style={{color: COLORS.muted, fontSize: 20, fontWeight: 600}}>点击回答内时间戳 · 直接回到原片对应时刻</span>
          <span
            style={{
              padding: "4px 14px",
              borderRadius: 999,
              background: frame >= CHAT_TIMESTAMP_CLICK_FRAME ? COLORS.pink : "rgba(232, 93, 135, 0.12)",
              color: frame >= CHAT_TIMESTAMP_CLICK_FRAME ? "#FFFFFF" : COLORS.pink,
              fontSize: 20,
              fontWeight: 600
            }}
          >
            04:44–05:15
          </span>
        </div>
        <div style={{color: COLORS.foreground, fontSize: 26, fontWeight: 600, lineHeight: 1.38}}>
          1. 人与 AI 的关系是「协作」，而非「替代」
        </div>
      </div>
      <ProductFrame
        source="chat.mp4"
        crop={CHAT_INPUT_CROP}
        width={740}
        startFrom={0}
        playbackRate={1}
        duration={180}
        animate={false}
        tilt={0}
        style={{left: 116, top: 648}}
      />
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
        top: 112,
        width: 1080,
        height: playerHeight,
        opacity: progress,
        scale: interpolate(progress, [0, 1], [0.95, 1]),
        translate: `${(1 - progress) * -28}px 0px`,
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
          border: `3px solid ${COLORS.pink}`,
          boxShadow: "0 32px 80px -28px rgba(36, 52, 71, 0.38)",
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
        <div
          style={{
            position: "absolute",
            left: 24,
            top: 22,
            padding: "10px 20px",
            borderRadius: 999,
            background: "rgba(15, 23, 42, 0.88)",
            border: `1.5px solid ${COLORS.pink}`,
            color: "#FFFFFF",
            fontSize: 22,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 12
          }}
        >
          <span style={{width: 10, height: 10, borderRadius: "50%", background: COLORS.pink, display: "inline-block"}} />
          <span>已跳回原片 04:44 · 正在播放对应段落</span>
        </div>
        <div
          style={{
            position: "absolute",
            left: 48,
            right: 48,
            bottom: 28,
            padding: "12px 24px",
            borderRadius: 16,
            background: "rgba(15, 23, 42, 0.86)",
            border: "1px solid rgba(255, 255, 255, 0.18)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            color: "#FFFFFF"
          }}
        >
          <span style={{fontSize: 24, fontWeight: 600}}>字幕核对：「人与 AI 协作配合，而非单纯替代」</span>
          <span style={{color: COLORS.pink, fontSize: 22, fontWeight: 700}}>04:44 / 08:12</span>
        </div>
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
      <ChatLeftContext />
      {CHAT_SHOTS.map((shot, index) => (
        <Sequence key={shot.startFrom} from={shotOffset(CHAT_SHOTS, index)} durationInFrames={shot.duration}>
          <div
            style={{
              position: "absolute",
              left: panelLeft,
              top: 52,
              transformOrigin: "0 0",
              scale: panelScale
            }}
          >
            <ProductFrame
              source="chat.mp4"
              crop={CHAT_BODY_CROP}
              width={880}
              startFrom={shot.startFrom}
              playbackRate={shot.playbackRate}
              duration={shot.duration}
              animate={index === 0}
              tilt={0}
              focus={
                index === 0
                  ? {direction: "in", frames: CHAT_HANDOFF.enterFrames, maxBlur: CHAT_HANDOFF.maxBlur}
                  : index === CHAT_SHOTS.length - 1
                    ? {direction: "out", frames: APPEARANCE_HANDOFF.exitFrames, maxBlur: APPEARANCE_HANDOFF.maxBlur}
                    : undefined
              }
              style={{left: 0, top: 0}}
            />
          </div>
        </Sequence>
      ))}
      <ChatTimestampPointer />
      <ChatReturnVerification />
    </AbsoluteFill>
  );
};

export const AppearanceScene = () => {
  const frame = useCurrentFrame();
  const darkWipe = interpolate(frame, [19, 23], [0, 100], {...CLAMP, easing: SMOOTH});
  const editorialWipe = interpolate(frame, [55, 59], [0, 100], {...CLAMP, easing: SMOOTH});
  const isDark = frame >= 21;
  const isEditorial = frame >= 57;

  const titleColor = isDark ? "#F8FAFC" : COLORS.foreground;
  const mutedColor = isDark ? "rgba(248, 250, 252, 0.72)" : COLORS.muted;
  const activeStep = isEditorial ? 2 : isDark ? 1 : 0;
  const badges = [
    {label: "浅色纸白", dot: "#E85D87"},
    {label: "深色模式", dot: "#38BDF8"},
    {label: "数字刊物", dot: "#E08B5B"}
  ];

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY, overflow: "hidden", background: COLORS.background}}>
      {/* Full-Canvas Dark Mode Wipe at 17.70s (frame 21) */}
      <AbsoluteFill
        style={{
          background: "linear-gradient(140deg, #10151C 0%, #161D26 55%, #1D2633 100%)",
          clipPath: `polygon(0% 0%, ${darkWipe * 1.35}% 0%, ${Math.max(0, darkWipe * 1.35 - 35)}% 100%, 0% 100%)`
        }}
      />
      {/* Full-Canvas Editorial Warm Palette Wipe at 18.90s (frame 57) */}
      <AbsoluteFill
        style={{
          background: "linear-gradient(140deg, #1A1412 0%, #241B17 55%, #2D211B 100%)",
          clipPath: `polygon(0% 0%, ${editorialWipe * 1.35}% 0%, ${Math.max(0, editorialWipe * 1.35 - 35)}% 100%, 0% 100%)`
        }}
      />

      {/* Top Dedicated Header Bar — strictly above all interactive UI controls */}
      <div
        style={{
          position: "absolute",
          left: 104,
          right: 104,
          top: 38,
          height: 104,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          zIndex: 10
        }}
      >
        <div style={{display: "flex", alignItems: "baseline", gap: 22}}>
          <div style={{color: titleColor, fontSize: 56, fontWeight: 600, letterSpacing: -1.8, lineHeight: 1.15}}>
            {frame < APPEARANCE_SHOTS[0].duration ? "深色模式，完整切换。" : "阅读色板，随你偏好。"}
          </div>
          <div style={{color: mutedColor, fontSize: 24, fontWeight: 500}}>
            {isEditorial ? "当前色板：数字刊物" : isDark ? "当前外观：深色夜读" : "当前外观：浅色飞魅"}
          </div>
        </div>
        <div style={{display: "flex", alignItems: "center", gap: 14}}>
          {badges.map((badge, index) => {
            const active = index === activeStep;
            return (
              <div
                key={badge.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 20px",
                  borderRadius: 999,
                  background: active
                    ? isDark
                      ? "rgba(255, 255, 255, 0.16)"
                      : "rgba(36, 52, 71, 0.08)"
                    : isDark
                      ? "rgba(255, 255, 255, 0.06)"
                      : "rgba(255, 255, 255, 0.72)",
                  border: active ? `2px solid ${badge.dot}` : "1px solid rgba(148, 163, 184, 0.25)",
                  color: titleColor,
                  fontSize: 22,
                  fontWeight: active ? 600 : 500
                }}
              >
                <span style={{width: 12, height: 12, borderRadius: "50%", background: badge.dot, display: "inline-block"}} />
                <span>{badge.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Full-Bleed Center Stage (>72% screen area, bottom-bleed showcase) */}
      <ProductFrame
        source="appearance.mp4"
        crop={{x: PANEL_CROPS.appearance.x, y: PANEL_CROPS.appearance.y, width: PANEL_CROPS.appearance.width, height: 580}}
        width={860}
        startFrom={0}
        playbackRate={2}
        duration={90}
        animate={false}
        tilt={0}
        variant="bleed"
        focus={{direction: "in", frames: APPEARANCE_HANDOFF.enterFrames, maxBlur: APPEARANCE_HANDOFF.maxBlur}}
        style={{
          left: 104,
          top: 164,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          border: isDark ? "1px solid rgba(255, 255, 255, 0.16)" : "1px solid rgba(83, 110, 134, 0.18)"
        }}
      />

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
            tilt={0}
            variant="bleed"
            focus={index === 0 ? {direction: "in", frames: APPEARANCE_HANDOFF.enterFrames, maxBlur: APPEARANCE_HANDOFF.maxBlur} : undefined}
            style={{
              left: 996,
              top: 164,
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              border: isDark ? "1px solid rgba(255, 255, 255, 0.16)" : "1px solid rgba(83, 110, 134, 0.18)"
            }}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
