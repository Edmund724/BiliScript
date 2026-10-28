import {Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {PROVIDER_LOGOS} from "../provider-logos.mjs";
import {PROVIDER_TIMELINE} from "../timeline.mjs";
import {COLORS, FONT_FAMILY, ProductFrame, entranceOpacity} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const ENTRANCE = Easing.bezier(0.16, 1, 0.3, 1);
const MOVE_EASING = Easing.bezier(0.22, 1, 0.36, 1);
const TITLE_DELAY = 3;
const {
  dialogShot,
  countAt,
  countHoldFrames,
  countMoveFrames,
  shotsExitAt,
  shotsExitDuration,
  wallAt,
  cardStagger,
  collapseAt,
  collapseDuration,
  wallExitAt,
  wallExitDuration
} = PROVIDER_TIMELINE;

const ContinuousClaim = () => {
  const frame = useCurrentFrame();
  const moveStart = countAt + countHoldFrames;
  const moveEnd = moveStart + countMoveFrames;
  const enterOpacity = interpolate(frame, [countAt, countAt + 6], [0, 1], CLAMP);
  const exitOpacity = interpolate(frame, [wallExitAt, wallExitAt + wallExitDuration], [1, 0], CLAMP);
  const enterRise = interpolate(frame, [countAt, countAt + 8], [24, 0], {...CLAMP, easing: ENTRANCE});
  const moveProgress = interpolate(frame, [moveStart, moveEnd], [0, 1], {...CLAMP, easing: MOVE_EASING});
  const collapseProgress = interpolate(frame, [collapseAt, collapseAt + collapseDuration], [0, 1], {...CLAMP, easing: ENTRANCE});

  const x = interpolate(moveProgress, [0, 1], [104, 576], CLAMP);
  const y = interpolate(moveProgress, [0, 1], [352, 62], CLAMP) + enterRise + collapseProgress * 96;
  const scale = interpolate(moveProgress, [0, 1], [1, 0.64], CLAMP) * interpolate(collapseProgress, [0, 1], [1, 0.35], CLAMP);

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        transformOrigin: "left top",
        opacity: enterOpacity * exitOpacity,
        translate: `${x}px ${y}px`,
        scale
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 28,
          padding: "18px 34px 18px 28px",
          borderRadius: 32,
          background: "rgba(255, 255, 255, 0.92)",
          border: "1px solid rgba(83, 110, 134, 0.14)",
          boxShadow: "0 22px 48px -28px rgba(31, 47, 61, 0.22)"
        }}
      >
        <div
          style={{
            color: COLORS.pink,
            fontFamily: 'Bahnschrift, "Aptos Display", sans-serif',
            fontSize: 168,
            fontWeight: 600,
            lineHeight: 0.92,
            letterSpacing: -6
          }}
        >
          {PROVIDER_LOGOS.length}
        </div>
        <div style={{color: COLORS.foreground, fontSize: 48, fontWeight: 600, lineHeight: 1.24, letterSpacing: -1}}>
          个 AI 平台预设
          <div style={{color: COLORS.muted, fontSize: 30, fontWeight: 500, marginTop: 8, letterSpacing: 0}}>
            另支持自定义端点 · OpenAI 兼容接口
          </div>
        </div>
      </div>
    </div>
  );
};

const ProviderCard = ({logo, index}: {logo: (typeof PROVIDER_LOGOS)[number]; index: number}) => {
  const frame = useCurrentFrame();
  const start = wallAt + index * cardStagger;
  const col = index % 7;
  const row = Math.floor(index / 7);
  const cardCenterX = 104 + col * (224 + 24) + 112;
  const cardCenterY = 276 + row * (226 + 32) + 113;
  const collapseProgress = interpolate(frame, [collapseAt, collapseAt + collapseDuration], [0, 1], {...CLAMP, easing: ENTRANCE});
  const enterRise = interpolate(frame, [start, start + 8], [28, 0], {...CLAMP, easing: ENTRANCE});
  const enterScale = interpolate(frame, [start, start + 8], [0.92, 1], {...CLAMP, easing: ENTRANCE});
  const convergeX = (960 - cardCenterX) * collapseProgress;
  const convergeY = (540 - cardCenterY) * collapseProgress;

  return (
    <div
      style={{
        width: 224,
        height: 226,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        borderRadius: 28,
        border: "1px solid rgba(83, 110, 134, 0.16)",
        background: "rgba(255, 255, 255, 0.96)",
        boxShadow: "0 20px 44px -24px rgba(43, 70, 93, 0.24)",
        opacity: interpolate(frame, [start, start + 5], [0, 1], CLAMP),
        translate: `${convergeX}px ${enterRise + convergeY}px`,
        scale: enterScale * (1 - 0.78 * collapseProgress)
      }}
    >
      <div
        style={{
          width: 96,
          height: 82,
          borderRadius: 22,
          background: "rgba(244, 241, 246, 0.72)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <Img src={staticFile(`media/providers/${logo.file}`)} style={{width: 68, height: 68, objectFit: "contain"}} />
      </div>
      <div
        style={{
          color: COLORS.foreground,
          fontSize: logo.id === "amd" ? 22 : 24,
          fontWeight: 600,
          lineHeight: 1.2,
          whiteSpace: "nowrap",
          textAlign: "center"
        }}
      >
        {logo.name}
      </div>
    </div>
  );
};

const LogoWall = () => {
  const frame = useCurrentFrame();
  const wallOpacity = interpolate(frame, [wallAt, wallAt + 3, wallExitAt, wallExitAt + wallExitDuration], [0, 1, 1, 0], CLAMP);
  const footerOpacity =
    interpolate(frame, [wallAt + 20, wallAt + 30], [0, 1], CLAMP) *
    interpolate(frame, [collapseAt - 2, collapseAt + 4], [1, 0], CLAMP);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: wallOpacity
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 104,
          right: 104,
          top: 276,
          height: 484,
          display: "grid",
          gridTemplateColumns: "repeat(7, 224px)",
          justifyContent: "space-between",
          rowGap: 32
        }}
      >
        {PROVIDER_LOGOS.map((logo, index) => (
          <ProviderCard key={logo.id} logo={logo} index={index} />
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 104,
          right: 104,
          top: 806,
          display: "flex",
          justifyContent: "center",
          gap: 18,
          opacity: footerOpacity
        }}
      >
        {["内置 14 家主流平台预设", "支持 OpenAI / Anthropic 兼容格式", "支持本地 Ollama · 自定义 Base URL"].map((text, idx) => (
          <div
            key={text}
            style={{
              padding: "12px 24px",
              borderRadius: 999,
              background: idx === 0 ? "rgba(232, 93, 135, 0.12)" : "rgba(255, 255, 255, 0.9)",
              border: `1px solid ${idx === 0 ? "rgba(232, 93, 135, 0.34)" : "rgba(83, 110, 134, 0.16)"}`,
              color: idx === 0 ? COLORS.pink : COLORS.foreground,
              fontSize: 22,
              fontWeight: 600
            }}
          >
            {text}
          </div>
        ))}
      </div>
    </div>
  );
};

export const ProviderScene = () => {
  const frame = useCurrentFrame();
  const introTitleOpacity =
    entranceOpacity(frame, TITLE_DELAY) * interpolate(frame, [0, countAt - 4, countAt + 2], [1, 1, 0], CLAMP);
  const modalOpacity =
    entranceOpacity(frame) * interpolate(frame, [shotsExitAt, shotsExitAt + shotsExitDuration], [1, 0], CLAMP);
  const modalScale = interpolate(frame, [shotsExitAt, shotsExitAt + shotsExitDuration], [1, 0.94], {
    ...CLAMP,
    easing: ENTRANCE
  });
  const modalTranslateX = interpolate(frame, [shotsExitAt, shotsExitAt + shotsExitDuration], [0, 48], {
    ...CLAMP,
    easing: ENTRANCE
  });

  return (
    <div style={{position: "absolute", inset: 0, fontFamily: FONT_FAMILY}}>
      <div
        style={{
          position: "absolute",
          left: 104,
          top: 164,
          width: 580,
          opacity: introTitleOpacity
        }}
      >
        <div
          style={{
            color: COLORS.foreground,
            fontSize: 64,
            fontWeight: 600,
            lineHeight: 1.2,
            letterSpacing: -2
          }}
        >
          选择平台，
          <br />
          从预设开始。
        </div>
        <div
          style={{
            marginTop: 22,
            color: COLORS.muted,
            fontSize: 26,
            fontWeight: 500,
            lineHeight: 1.45
          }}
        >
          一键填入官方端点与推荐模型，无需手写接口地址。
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: modalOpacity,
          translate: `${modalTranslateX}px 0px`,
          scale: modalScale
        }}
      >
        <Sequence from={dialogShot.from} durationInFrames={shotsExitAt + shotsExitDuration}>
          <ProductFrame
            source="ai-providers.mp4"
            crop={{x: 1396, y: 298, width: 478, height: 432}}
            width={1080}
            variant="bleed"
            startFrom={dialogShot.source}
            playbackRate={dialogShot.playbackRate}
            duration={dialogShot.duration}
            animate={false}
            tilt={0}
            style={{left: 740, top: 84, borderRadius: 28, border: "1px solid rgba(83, 110, 134, 0.16)"}}
          />
        </Sequence>
      </div>

      <LogoWall />
      <ContinuousClaim />
    </div>
  );
};
