import {AbsoluteFill, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  APPEARANCE_SHOTS,
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_PLAYER_VERIFY_TO,
  CHAT_SHOTS,
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
  VoiceWaveBar
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat")!;
const APPEARANCE_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "appearance")!;

const CHAT_BODY_CROP: Crop = {x: 1365, y: 64, width: 540, height: 590};
const CHAT_INPUT_CROP: Crop = {x: 1387, y: 960, width: 495, height: 99};
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
          borderRadius: 999,
          background: frame >= clickAt ? "rgba(232, 93, 135, 0.20)" : "rgba(232, 93, 135, 0.10)",
          boxShadow: "0 12px 32px -8px rgba(232, 93, 135, 0.45), 0 0 0 1px rgba(232, 93, 135, 0.34)",
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
          background: "rgba(232, 93, 135, 0.24)",
          boxShadow: "0 0 32px rgba(232, 93, 135, 0.55)",
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
          filter: "drop-shadow(0 4px 8px rgba(17, 24, 39, 0.35))",
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
      <SceneTitle
        title={"看完还有问题？\n接着问。"}
        subtitle="围绕视频上下文深入追问，点击回答内时间戳回到原片那一秒。"
        style={{left: 96, top: 152, width: 760}}
      />
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 436,
          width: 760,
          padding: "28px 34px",
          borderRadius: 28,
          background: "rgba(255, 255, 255, 0.96)",
          boxShadow: ELEVATION.heroFloat,
          transform: "perspective(1600px) rotateX(4deg) rotateY(-8deg)",
          display: "flex",
          flexDirection: "column",
          gap: 14
        }}
      >
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
          <span style={{color: COLORS.muted, fontSize: 20, fontWeight: 500}}>点击回答内时间戳 · 原片同步合焦发声</span>
          <span
            style={{
              padding: "5px 16px",
              borderRadius: 999,
              fontFamily: BRAND_FONT_FAMILY,
              background: frame >= CHAT_TIMESTAMP_CLICK_FRAME ? COLORS.pink : "rgba(38, 121, 184, 0.10)",
              color: frame >= CHAT_TIMESTAMP_CLICK_FRAME ? "#FFFFFF" : COLORS.blue,
              fontSize: 20,
              fontWeight: 600
            }}
          >
            04:44 – 05:15 ↗
          </span>
        </div>
        <div style={{color: COLORS.foreground, fontSize: 27, fontWeight: 600, lineHeight: 1.38, letterSpacing: -0.5}}>
          1. 人与 AI 的关系是<span style={{color: COLORS.pink}}>「协作」</span>，而非<span style={{color: COLORS.pink}}>「替代」</span>
        </div>
      </div>
      <ProductFrame
        source="chat.mp4"
        crop={CHAT_INPUT_CROP}
        width={760}
        startFrom={0}
        playbackRate={1}
        duration={180}
        animate={false}
        tilt={-6}
        style={{left: 96, top: 656}}
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
              tilt={-6}
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
