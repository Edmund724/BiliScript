import {Easing, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {PANEL_FOCUS_HANDOFFS} from "../timeline.mjs";
import {
  BRAND_FONT_FAMILY,
  BrandWhisper,
  COLORS,
  Crop,
  ELEVATION,
  MIST_GLASS,
  PaperGrainOverlay,
  ProductFrame,
  ReadingLampBeam,
  Reveal,
  SceneTitle,
  SpringLayout,
  VoiceWaveBar,
  microPerspective
} from "./design";

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat")!;

const CHAPTER_CROP: Crop = {x: 1365, y: 182, width: 540, height: 660};
const QUOTE_CROP: Crop = {x: 1365, y: 548, width: 540, height: 170};
const SHARE_CROP: Crop = {x: 1365, y: 288, width: 540, height: 564};
const PLAYER_CROP: Crop = {x: 54, y: 171, width: 1272, height: 764};
const CHAPTER_SOURCE_SECONDS = 5.6;
const QUOTE_SOURCE_SECONDS = 4.733333;
const QUOTE_LIFT_FRAMES = 16;

const SpatialChapterStack = () => {
  const frame = useCurrentFrame();
  const voiceActive = frame >= 5 && frame <= 49;

  return (
    <Reveal
      delay={2}
      distance={18}
      style={{
        position: "absolute",
        left: 96,
        top: 422,
        width: 810,
        transform: "perspective(1600px) rotateX(4deg) rotateY(-8deg)"
      }}
    >
      <div
        style={{
          position: "relative",
          padding: "22px 32px",
          borderRadius: 28,
          background: MIST_GLASS.surface,
          backdropFilter: "blur(24px) saturate(1.2)",
          WebkitBackdropFilter: "blur(24px) saturate(1.2)",
          boxShadow: MIST_GLASS.shellShadow,
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        {/* Flyme Blue-Mist Ambient Blobs */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 28,
            overflow: "hidden",
            pointerEvents: "none"
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: MIST_GLASS.blobs,
              filter: "blur(28px)"
            }}
          />
        </div>

        <div
          style={{
            position: "relative",
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "10px 16px",
            borderRadius: 16,
            background: MIST_GLASS.card,
            boxShadow: MIST_GLASS.cardShadow,
            color: MIST_GLASS.muted,
            fontSize: 21,
            fontWeight: 540,
            opacity: 0.78
          }}
        >
          <span
            style={{
              fontFamily: BRAND_FONT_FAMILY,
              fontSize: 18,
              fontWeight: 620,
              color: MIST_GLASS.timeColor,
              background: MIST_GLASS.timeBg,
              padding: "3px 12px",
              borderRadius: 999
            }}
          >
            00:00
          </span>
          <span>什么是机器幻觉（Hallucination）</span>
        </div>

        <div
          style={{
            position: "relative",
            zIndex: 2,
            margin: "4px -14px",
            padding: "24px 34px",
            borderRadius: 24,
            background: MIST_GLASS.cardElevated,
            boxShadow: MIST_GLASS.cardFloatShadow,
            overflow: "hidden"
          }}
        >
          <PaperGrainOverlay opacity={0.34} />
          <div style={{position: "relative", display: "flex", alignItems: "center", gap: 14, marginBottom: 12}}>
            <span
              style={{
                background: MIST_GLASS.timeBg,
                color: MIST_GLASS.timeColor,
                boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 0 0 1px rgba(46, 111, 194, 0.16)",
                fontFamily: BRAND_FONT_FAMILY,
                fontSize: 20,
                fontWeight: 700,
                padding: "4px 15px",
                borderRadius: 999
              }}
            >
              02:32
            </span>
            <span style={{fontSize: 28, fontWeight: 680, color: MIST_GLASS.text, letterSpacing: -0.6}}>
              AI 并非越强越好，适配才是关键
            </span>
          </div>
          <div style={{position: "relative", fontSize: 24, fontWeight: 580, lineHeight: 1.46, letterSpacing: -0.4, color: MIST_GLASS.text, marginBottom: 14}}>
            “训练大模型就像考试——他只要去答就不是零分，<span style={{color: COLORS.pink, fontWeight: 720}}>如果不答一定是零分</span>；人与 AI 的关系是<span style={{color: MIST_GLASS.timeColor, fontWeight: 700}}>「协作」</span>而非替代。”
          </div>
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: 12,
              borderTop: "1px solid rgba(15, 23, 42, 0.06)",
              color: MIST_GLASS.muted,
              fontSize: 19
            }}
          >
            <span>复旦大学 · 赵斌教授公开课</span>
            <span
              style={{
                color: MIST_GLASS.timeColor,
                fontFamily: BRAND_FONT_FAMILY,
                fontWeight: 650,
                background: MIST_GLASS.timeBg,
                padding: "5px 15px",
                borderRadius: 999
              }}
            >
              02:32 – 05:15 ↗
            </span>
          </div>
        </div>

        <div
          style={{
            position: "relative",
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "10px 16px",
            borderRadius: 16,
            background: MIST_GLASS.card,
            boxShadow: MIST_GLASS.cardShadow,
            color: MIST_GLASS.muted,
            fontSize: 21,
            fontWeight: 540,
            opacity: 0.78
          }}
        >
          <span
            style={{
              fontFamily: BRAND_FONT_FAMILY,
              fontSize: 18,
              fontWeight: 620,
              color: MIST_GLASS.timeColor,
              background: MIST_GLASS.timeBg,
              padding: "3px 12px",
              borderRadius: 999
            }}
          >
            04:27
          </span>
          <span>人机协作象棋实验与实证</span>
        </div>
      </div>

      <VoiceWaveBar
        timestamp="02:32 · 赵老师原声点题"
        quote="“如果他不答，一定是零分！”"
        active={voiceActive}
        style={{position: "relative", left: 0, bottom: "auto", marginTop: 14, width: "fit-content"}}
      />
    </Reveal>
  );
};

const PaletteSwatches = () => {
  const frame = useCurrentFrame();
  const activeIndex = frame >= 33 ? 2 : frame >= 21 ? 1 : 0;
  const palettes = [
    {name: "紫粉 · 橙金", dot: "#E85D87", glow: "rgba(232, 93, 135, 0.22)"},
    {name: "灰蓝 · 深棕", dot: "#7B6B5E", glow: "rgba(123, 107, 94, 0.22)"},
    {name: "雾蓝 · 深海", dot: "#3A6E8C", glow: "rgba(58, 110, 140, 0.22)"}
  ];
  const playerScale = 780 / PLAYER_CROP.width;
  const playerHeight = Math.round(PLAYER_CROP.height * playerScale * 0.78);

  return (
    <Reveal delay={6} distance={16} style={{position: "absolute", left: 96, top: 432, width: 780}}>
      <div style={{display: "flex", gap: 16, marginBottom: 28}}>
        {palettes.map((palette, idx) => {
          const active = idx === activeIndex;
          return (
            <div
              key={palette.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 24px",
                borderRadius: 999,
                background: active ? "rgba(255, 255, 255, 0.98)" : "rgba(255, 255, 255, 0.68)",
                backdropFilter: "blur(20px)",
                boxShadow: active
                  ? `0 18px 42px -16px rgba(17, 24, 39, 0.18), 0 0 24px ${palette.glow}, 0 0 0 1.5px ${palette.dot}`
                  : "0 10px 24px -14px rgba(17, 24, 39, 0.10), 0 0 0 1px rgba(17, 24, 39, 0.04)",
                scale: active ? 1.04 : 1
              }}
            >
              <span style={{width: 14, height: 14, borderRadius: "50%", background: palette.dot, display: "inline-block"}} />
              <span style={{color: COLORS.foreground, fontSize: 22, fontWeight: active ? 600 : 500}}>{palette.name}</span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "relative",
          width: 780,
          height: playerHeight,
          borderRadius: 26,
          overflow: "hidden",
          boxShadow: ELEVATION.videoPlane,
          transform: "perspective(1600px) rotateX(5deg) rotateY(-9deg)",
          background: "#0F172A"
        }}
      >
        <OffthreadVideo
          muted
          src={staticFile("media/subtitle-seek-03.mp4")}
          startFrom={84}
          playbackRate={0.2}
          style={{
            position: "absolute",
            left: -PLAYER_CROP.x * playerScale,
            top: -PLAYER_CROP.y * playerScale - 44,
            width: 1920 * playerScale,
            height: 1080 * playerScale,
            maxWidth: "none"
          }}
        />
        <VoiceWaveBar timestamp="02:32 · 原声金句" quote="“如果他不答，一定是零分”" active={false} />
      </div>
    </Reveal>
  );
};

const QuoteShareModalOverlay = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const activeIndex = frame >= 33 ? 2 : frame >= 21 ? 1 : 0;
  const modalOpacity = interpolate(frame, [10, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  if (modalOpacity <= 0.01) return null;

  const defocusProgress = interpolate(
    frame,
    [Math.max(0, duration - CHAT_HANDOFF.exitFrames), duration],
    [0, 1],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.4, 0, 1, 1)}
  );
  const blur = CHAT_HANDOFF.maxBlur * defocusProgress;
  const defocusOpacity = 1 - 0.88 * defocusProgress;

  const modalPalettes = [
    {name: "紫粉·橙金", dot: "#E87A90"},
    {name: "灰蓝·深棕", dot: "#7B6B5E"},
    {name: "雾蓝·深海", dot: "#3A6E8C"},
    {name: "雾蓝·墨绿", dot: "#2E5E4E"},
    {name: "薰衣草·深夜紫", dot: "#5B4B8A"},
    {name: "天灰·锈红", dot: "#8C4A3A"}
  ];

  const cardGradients = [
    "linear-gradient(135deg, #9C96C9 0%, #BA88A8 46%, #D98B5F 100%)",
    "linear-gradient(135deg, #8F9AA5 0%, #6D6059 52%, #8C5832 100%)",
    "linear-gradient(135deg, #6E8EA6 0%, #365B77 54%, #1B3952 100%)"
  ];

  const shutterEvents = [14, 21, 33];
  let shutterPulse = 0;
  for (const eventFrame of shutterEvents) {
    const dt = frame - eventFrame;
    if (dt >= 0 && dt <= 6) {
      shutterPulse = Math.max(shutterPulse, interpolate(dt, [0, 1, 6], [0.85, 1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}));
    }
  }
  const cardShutterScale = 1 + shutterPulse * 0.022;
  const pageFlipDeg = shutterPulse * 5.2;

  // 00:10 (local frame 42 = global frame 304 = 10.13s): Click "保存 PNG" -> Polaroid shutter flash + 3D parallax pop-up
  const saveClickAt = 42;
  const isSaved = frame >= saveClickAt;
  const savePopSpring = spring({
    frame: Math.max(0, frame - saveClickAt),
    fps,
    config: {damping: 12, stiffness: 165, mass: 0.72}
  });
  const savePopProgress = isSaved ? savePopSpring : 0;
  const saveShutterFlash = interpolate(
    frame,
    [saveClickAt - 1, saveClickAt, saveClickAt + 1, saveClickAt + 2, saveClickAt + 6],
    [0, 0.95, 0.58, 0.16, 0],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp"}
  );
  const polaroidSheenX = interpolate(
    frame,
    [saveClickAt, saveClickAt + 12],
    [-20, 118],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1)}
  );
  const polaroidSheenOpacity = interpolate(
    frame,
    [saveClickAt, saveClickAt + 2, saveClickAt + 12],
    [0, 0.92, 0],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp"}
  );

  // Pointer moving to click "↓ 保存 PNG"
  const showSaveCursor = frame >= 34 && frame <= 56;
  const saveCursorOpacity =
    interpolate(frame, [34, 38], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}) *
    interpolate(frame, [51, 56], [1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const saveCursorX = interpolate(frame, [34, saveClickAt - 1], [140, 26], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const saveCursorY = interpolate(frame, [34, saveClickAt - 1], [-85, 18], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const saveButtonScale = interpolate(
    frame,
    [saveClickAt - 2, saveClickAt, saveClickAt + 4],
    [1, 0.9, 1.04],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp"}
  );
  const saveRippleOpacity = interpolate(
    frame,
    [saveClickAt - 1, saveClickAt + 1, saveClickAt + 12],
    [0, 0.88, 0],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp"}
  );
  const saveRippleScale = interpolate(
    frame,
    [saveClickAt - 1, saveClickAt + 12],
    [0.5, 1.85],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1)}
  );

  const popScale = cardShutterScale * (1 + savePopProgress * 0.082);
  const popTranslateX = -savePopProgress * 18;
  const popTranslateY = -savePopProgress * 26;
  const popRotateY = -pageFlipDeg - savePopProgress * 9.5;
  const popRotateX = shutterPulse * 2.0 + savePopProgress * 6.8;
  const popRotateZ = -savePopProgress * 1.8;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 760,
        borderRadius: 28,
        padding: "28px 34px 26px",
        background: isSaved ? "rgba(255, 255, 255, 0.92)" : "#FFFFFF",
        boxShadow: "-28px 48px 110px -26px rgba(17, 24, 39, 0.24), 0 0 0 1px rgba(17, 24, 39, 0.06)",
        transformOrigin: "50% 50%",
        transform: microPerspective(-8),
        opacity: modalOpacity * defocusOpacity,
        filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined,
        boxSizing: "border-box"
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
          opacity: 1 - savePopProgress * 0.28
        }}
      >
        <span style={{fontSize: 24, fontWeight: 700, color: COLORS.foreground, letterSpacing: -0.4}}>分享金句卡片</span>
        <span style={{fontSize: 24, color: COLORS.muted, lineHeight: 1}}>×</span>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: 10,
          marginBottom: 14,
          opacity: 1 - savePopProgress * 0.32
        }}
      >
        {modalPalettes.map((item, idx) => {
          const active = idx === activeIndex;
          return (
            <div
              key={item.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 16px",
                borderRadius: 999,
                background: active ? "rgba(38, 121, 184, 0.12)" : "#F3F5F8",
                boxShadow: active ? "0 0 0 1.5px rgba(38, 121, 184, 0.48)" : "none",
                color: active ? "#1D63B8" : COLORS.inkSoft,
                fontSize: 16,
                fontWeight: active ? 600 : 500
              }}
            >
              <span style={{width: 10, height: 10, borderRadius: "50%", background: item.dot, display: "inline-block"}} />
              <span>{item.name}</span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 12,
          marginBottom: 20,
          opacity: 1 - savePopProgress * 0.32
        }}
      >
        {["无纹样", "射线", "等高线", "声波", "点阵", "透镜"].map((tab, idx) => {
          const active = idx === 1;
          return (
            <div
              key={tab}
              style={{
                padding: "5px 14px",
                borderRadius: 999,
                background: active ? "rgba(38, 121, 184, 0.12)" : "transparent",
                color: active ? "#1D63B8" : COLORS.muted,
                fontSize: 15,
                fontWeight: active ? 600 : 500
              }}
            >
              {tab}
            </div>
          );
        })}
      </div>

      {/* Polaroid Recess Shadow Slot left behind when the quote card pops up in 3D */}
      <div style={{position: "relative"}}>
        {savePopProgress > 0.02 && (
          <div
            style={{
              position: "absolute",
              inset: 8,
              borderRadius: 22,
              background: "rgba(15, 23, 42, 0.08)",
              boxShadow: "inset 0 8px 24px rgba(15, 23, 42, 0.16)",
              opacity: savePopProgress,
              pointerEvents: "none"
            }}
          />
        )}

        {/* Right Quote Card with Shutter Flash + Polaroid 3D Parallax Pop-up */}
        <div
          style={{
            position: "relative",
            borderRadius: 22,
            padding: "30px 38px 28px",
            background: cardGradients[activeIndex],
            overflow: "hidden",
            boxShadow: isSaved
              ? `-38px 56px 118px -18px rgba(15, 23, 42, ${(0.32 + savePopProgress * 0.26).toFixed(2)}), 0 22px 48px -12px rgba(27, 57, 82, ${(0.22 + savePopProgress * 0.24).toFixed(2)}), 0 0 0 ${Math.round(savePopProgress * 8)}px rgba(255, 253, 248, 0.98), 0 0 42px rgba(56, 189, 248, ${(savePopProgress * 0.32).toFixed(2)})`
              : "0 20px 44px -18px rgba(15, 23, 42, 0.32)",
            scale: popScale,
            translate: `${popTranslateX.toFixed(1)}px ${popTranslateY.toFixed(1)}px`,
            transformOrigin: "50% 50%",
            transform: `perspective(1200px) rotateY(${popRotateY.toFixed(2)}deg) rotateX(${popRotateX.toFixed(2)}deg) rotateZ(${popRotateZ.toFixed(2)}deg)`,
            zIndex: 12
          }}
        >
          <PaperGrainOverlay opacity={0.48} />
          <ReadingLampBeam intensity={0.76 + shutterPulse * 0.24 + savePopProgress * 0.18} warm={activeIndex !== 2} />
          {shutterPulse > 0.02 && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "linear-gradient(125deg, rgba(255, 255, 255, 0.52) 0%, rgba(255, 255, 255, 0.16) 48%, rgba(255, 255, 255, 0) 100%)",
                opacity: shutterPulse * 0.65,
                pointerEvents: "none"
              }}
            />
          )}
          {/* Polaroid Glossy Specular Parallax Sweep on Save */}
          {polaroidSheenOpacity > 0.01 && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: `linear-gradient(112deg, rgba(255, 255, 255, 0) ${polaroidSheenX - 26}%, rgba(255, 255, 255, 0.72) ${polaroidSheenX}%, rgba(186, 230, 253, 0.32) ${polaroidSheenX + 10}%, rgba(255, 255, 255, 0) ${polaroidSheenX + 28}%)`,
                opacity: polaroidSheenOpacity,
                pointerEvents: "none"
              }}
            />
          )}
          {/* Camera Shutter Flash Overlay at 00:10 */}
          {saveShutterFlash > 0.01 && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "radial-gradient(circle at 52% 45%, rgba(255, 255, 255, 0.98) 0%, rgba(240, 249, 255, 0.84) 48%, rgba(255, 255, 255, 0.55) 100%)",
                opacity: saveShutterFlash,
                pointerEvents: "none",
                zIndex: 20
              }}
            />
          )}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage:
                "repeating-conic-gradient(from -15deg at 105% -10%, rgba(255, 255, 255, 0.07) 0deg 2deg, transparent 2deg 7deg)",
              pointerEvents: "none"
            }}
          />
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12
            }}
          >
            <span
              style={{
                color: "rgba(255, 255, 255, 0.65)",
                fontFamily: "Georgia, serif",
                fontSize: 44,
                lineHeight: 0.9
              }}
            >
              “
            </span>
            {savePopProgress > 0.1 && (
              <span
                style={{
                  padding: "4px 12px",
                  borderRadius: 999,
                  background: "rgba(255, 255, 255, 0.94)",
                  color: "#0F172A",
                  fontSize: 14,
                  fontWeight: 700,
                  boxShadow: "0 8px 20px rgba(15, 23, 42, 0.25)",
                  opacity: savePopProgress
                }}
              >
                📸 已生成高清金句卡 · PNG
              </span>
            )}
          </div>
          <div
            style={{
              position: "relative",
              color: "#FFFFFF",
              fontFamily: '"Noto Serif SC", "Songti SC", "SimSun", serif',
              fontSize: 27,
              fontWeight: 500,
              lineHeight: 1.62,
              letterSpacing: 0.2,
              marginBottom: 28
            }}
          >
            他只要去答这个题目，得的就不是零分，但是他如果不答一定是零分。我们训练大模型的时候就是这样训练的，那么在这种情况下，他一定会去蒙。
          </div>
          <div
            style={{
              position: "relative",
              textAlign: "right",
              color: "rgba(255, 255, 255, 0.84)",
              fontSize: 16,
              fontWeight: 500
            }}
          >
            AI并非越强越好，适配才是关键
          </div>
        </div>
      </div>

      <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: 22, marginTop: 22}}>
        <div style={{color: COLORS.inkSoft, fontSize: 18, fontWeight: 500}}>⧉ 复制图片</div>
        <div
          style={{
            position: "relative",
            padding: "10px 26px",
            borderRadius: 999,
            background: isSaved ? "#10B981" : "#2B7FFF",
            color: "#FFFFFF",
            fontSize: 18,
            fontWeight: 600,
            boxShadow: isSaved
              ? "0 12px 26px -6px rgba(16, 185, 129, 0.58), 0 0 0 2px rgba(255, 255, 255, 0.85)"
              : "0 10px 22px -8px rgba(43, 127, 255, 0.55)",
            scale: saveButtonScale
          }}
        >
          {isSaved ? "✓ 已保存 PNG" : "↓ 保存 PNG"}
          {saveRippleOpacity > 0.01 && (
            <span
              style={{
                position: "absolute",
                inset: -6,
                borderRadius: 999,
                border: "2px solid rgba(56, 189, 248, 0.85)",
                boxShadow: "0 0 24px rgba(56, 189, 248, 0.65)",
                opacity: saveRippleOpacity,
                scale: saveRippleScale,
                pointerEvents: "none"
              }}
            />
          )}
          {showSaveCursor && (
            <svg
              viewBox="0 0 30 38"
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: 32,
                height: 40,
                filter: "drop-shadow(0 6px 12px rgba(15, 23, 42, 0.35))",
                opacity: saveCursorOpacity,
                translate: `${saveCursorX.toFixed(1)}px ${saveCursorY.toFixed(1)}px`,
                scale: interpolate(
                  frame,
                  [saveClickAt - 2, saveClickAt, saveClickAt + 3],
                  [1, 0.82, 1],
                  {extrapolateLeft: "clamp", extrapolateRight: "clamp"}
                ),
                pointerEvents: "none",
                zIndex: 25
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
      </div>
    </div>
  );
};

const QuoteCamera = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const easing = Easing.bezier(0.16, 1, 0.3, 1);
  const liftProgress = interpolate(frame, [0, QUOTE_LIFT_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing
  });
  const expandProgress = interpolate(frame, [0, 10, QUOTE_LIFT_FRAMES], [0, 0.15, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing
  });
  const mix = (from: number, to: number) => from + (to - from) * expandProgress;
  const mixLift = (from: number, to: number) => from + (to - from) * liftProgress;
  const crop: Crop = {
    x: mix(QUOTE_CROP.x, SHARE_CROP.x),
    y: mix(QUOTE_CROP.y, SHARE_CROP.y),
    width: mix(QUOTE_CROP.width, SHARE_CROP.width),
    height: mix(QUOTE_CROP.height, SHARE_CROP.height)
  };
  const baseVideoOpacity = interpolate(frame, [11, 16], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 1016,
        top: mixLift(340, 88),
        width: 760,
        transformOrigin: "50% 50%",
        scale: interpolate(frame, [0, QUOTE_LIFT_FRAMES, duration], [0.96, 1, 1.015], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp"
        })
      }}
    >
      {baseVideoOpacity > 0.01 && (
        <div style={{opacity: baseVideoOpacity}}>
          <ProductFrame
            source="overview-04-quote.mp4"
            crop={crop}
            width={760}
            startFrom={42}
            playbackRate={QUOTE_SOURCE_SECONDS / (Math.max(1, duration - 12) / fps)}
            duration={duration}
            animate={false}
            tilt={-8}
            focus={{direction: "out", frames: CHAT_HANDOFF.exitFrames, maxBlur: CHAT_HANDOFF.maxBlur}}
            style={{
              left: 0,
              top: 0,
              boxShadow: `-28px ${mixLift(24, 48)}px ${mixLift(64, 110)}px -26px rgba(17, 24, 39, ${mixLift(0.16, 0.24)}), 0 0 0 1px rgba(17, 24, 39, 0.05)`
            }}
          />
        </div>
      )}
      <QuoteShareModalOverlay duration={duration} />
    </div>
  );
};

export const OverviewScene = ({duration}: {duration: number}) => {
  const {fps} = useVideoConfig();
  const chapterDuration = Math.round(duration * 0.43);
  const quoteDuration = duration - chapterDuration;
  return (
    <>
      <BrandWhisper />
      <Sequence durationInFrames={chapterDuration}>
        <SpringLayout direction={-1}>
          <SceneTitle
            title={"48 分钟公开课，\nAI 为什么爱犯幻觉？"}
            subtitle="章节脉络 3 秒提炼核心论点，赵老师原声一句话点透本质。"
            size={64}
            style={{left: 96, top: 152, width: 780}}
          />
          <SpatialChapterStack />
          <ProductFrame
            source="overview-04-chapters.mp4"
            crop={CHAPTER_CROP}
            width={760}
            tilt={-8}
            playbackRate={CHAPTER_SOURCE_SECONDS / (chapterDuration / fps)}
            duration={chapterDuration}
            style={{left: 1016, top: 68}}
          />
        </SpringLayout>
      </Sequence>
      <Sequence from={chapterDuration} durationInFrames={quoteDuration}>
        <SpringLayout direction={1} fade={false}>
          <SceneTitle
            title={"一句话点透本质，\n直接存成金句卡。"}
            subtitle="纸感肌理与多款阅读色板，像摘录一本杂志一样收藏好观点。"
            size={68}
            style={{left: 96, top: 152, width: 760}}
          />
          <PaletteSwatches />
          <QuoteCamera duration={quoteDuration} />
        </SpringLayout>
      </Sequence>
    </>
  );
};
