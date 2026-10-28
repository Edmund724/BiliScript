import {Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {PROVIDER_LOGOS} from "../provider-logos.mjs";
import {PROVIDER_TIMELINE} from "../timeline.mjs";
import {BRAND_FONT_FAMILY, BrandWhisper, COLORS, ELEVATION, FONT_FAMILY, ProductFrame, entranceOpacity} from "./design";

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

  const x = interpolate(moveProgress, [0, 1], [96, 576], CLAMP);
  const y = interpolate(moveProgress, [0, 1], [396, 54], CLAMP) + enterRise + collapseProgress * 96;
  const scale = interpolate(moveProgress, [0, 1], [1, 0.68], CLAMP) * interpolate(collapseProgress, [0, 1], [1, 0.35], CLAMP);

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
          gap: 22,
          padding: "18px 32px 18px 28px",
          borderRadius: 32,
          background: "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(24px)",
          boxShadow: ELEVATION.heroFloat
        }}
      >
        <div
          style={{
            color: COLORS.pink,
            fontFamily: BRAND_FONT_FAMILY,
            fontSize: 144,
            fontWeight: 600,
            lineHeight: 0.92,
            letterSpacing: -5
          }}
        >
          {PROVIDER_LOGOS.length}
        </div>
        <div style={{color: COLORS.foreground, fontSize: 42, fontWeight: 600, lineHeight: 1.24, letterSpacing: -1}}>
          个 AI 平台预设
          <div style={{color: COLORS.muted, fontSize: 24, fontWeight: 500, marginTop: 8, letterSpacing: 0}}>
            另支持自定义端点 · OpenAI 兼容接口
          </div>
        </div>
      </div>
    </div>
  );
};

const REPRESENTATIVE_HIGHLIGHTS: Record<
  string,
  {accent: string; softBg: string; border: string; badge?: string; activateOffset: number}
> = {
  deepseek: {
    accent: "#E85D87",
    softBg: "rgba(232, 93, 135, 0.12)",
    border: "rgba(232, 93, 135, 0.45)",
    badge: "主流直连",
    activateOffset: 24
  },
  qwen: {
    accent: "#E85D87",
    softBg: "rgba(232, 93, 135, 0.10)",
    border: "rgba(232, 93, 135, 0.32)",
    activateOffset: 26
  },
  modelscope: {
    accent: "#0D9488",
    softBg: "rgba(13, 148, 136, 0.13)",
    border: "rgba(13, 148, 136, 0.48)",
    badge: "每日免费额度",
    activateOffset: 40
  },
  amd: {
    accent: "#0D9488",
    softBg: "rgba(13, 148, 136, 0.10)",
    border: "rgba(13, 148, 136, 0.30)",
    activateOffset: 43
  },
  sensenova: {
    accent: "#0D9488",
    softBg: "rgba(13, 148, 136, 0.10)",
    border: "rgba(13, 148, 136, 0.30)",
    activateOffset: 46
  },
  ollama: {
    accent: "#2679B8",
    softBg: "rgba(38, 121, 184, 0.13)",
    border: "rgba(38, 121, 184, 0.48)",
    badge: "本地免 Key",
    activateOffset: 49
  }
};

const BENEFIT_ANCHORS = [
  {
    tag: "零门槛体验",
    text: "ModelScope 等平台享每日免费额度",
    accent: "#0D9488",
    bg: "rgba(13, 148, 136, 0.11)",
    border: "rgba(13, 148, 136, 0.30)",
    enterOffset: 30
  },
  {
    tag: "免填 Key",
    text: "支持本地 Ollama",
    accent: "#2679B8",
    bg: "rgba(38, 121, 184, 0.11)",
    border: "rgba(38, 121, 184, 0.30)",
    enterOffset: 36
  },
  {
    tag: "省心配置",
    text: "主流大模型一键直连",
    accent: "#E85D87",
    bg: "rgba(232, 93, 135, 0.12)",
    border: "rgba(232, 93, 135, 0.32)",
    enterOffset: 42
  }
] as const;

const ProviderCard = ({logo, index}: {logo: (typeof PROVIDER_LOGOS)[number]; index: number}) => {
  const frame = useCurrentFrame();
  const col = index % 7;
  const row = Math.floor(index / 7);
  const start = wallAt + index * cardStagger;
  const cardCenterX = 104 + col * (224 + 24) + 112;
  const cardCenterY = 276 + row * (226 + 32) + 113;
  const collapseProgress = interpolate(frame, [collapseAt, collapseAt + collapseDuration], [0, 1], {...CLAMP, easing: ENTRANCE});

  // 琴键/多米诺弹起波浪（Domino / Piano Key Wave）
  const local = frame - start;
  const enterOpacity = interpolate(local, [0, 3], [0, 1], CLAMP);
  const keyLiftY = interpolate(local, [0, 3, 7, 13], [36, -16, 3, 0], {...CLAMP, easing: ENTRANCE});
  const keyScale = interpolate(local, [0, 3, 7, 13], [0.84, 1.07, 0.99, 1], {...CLAMP, easing: ENTRANCE});
  const keyRotateX = interpolate(local, [0, 3, 8, 14], [-22, 7, -1.5, 0], {...CLAMP, easing: ENTRANCE});
  const keyRotateZ = interpolate(local, [0, 3, 8, 14], [row === 0 ? -4 : 4, row === 0 ? 1.5 : -1.5, 0, 0], {...CLAMP, easing: ENTRANCE});
  const rippleHighlight = interpolate(local, [0, 2.5, 10], [0, 1, 0], CLAMP);

  // 矩阵成型后的典型代表高亮锚定
  const rep = REPRESENTATIVE_HIGHLIGHTS[logo.id];
  const repStart = rep ? wallAt + rep.activateOffset : 999;
  const repHighlight = rep
    ? interpolate(frame, [repStart, repStart + 9], [0, 1], {...CLAMP, easing: ENTRANCE}) *
      interpolate(frame, [collapseAt - 4, collapseAt + 2], [1, 0], CLAMP)
    : 0;
  const repLiftY = repHighlight * -7;
  const repScale = 1 + repHighlight * (rep?.badge ? 0.036 : 0.018);

  // 后续卡弹起时传导的微弱琴键共振波纹
  const wavePhase = (frame - wallAt) * 0.36 - (col * 0.55 + row * 0.85);
  const waveActive = frame >= start + 13 && frame < collapseAt ? Math.sin(wavePhase) * Math.exp(-Math.max(0, frame - (start + 13)) * 0.045) : 0;
  const secondaryWaveY = waveActive * -4.5;

  const convergeX = (960 - cardCenterX) * collapseProgress;
  const convergeY = (540 - cardCenterY) * collapseProgress;
  const finalScale = keyScale * repScale * (1 - 0.78 * collapseProgress);

  return (
    <div
      style={{
        position: "relative",
        width: 224,
        height: 226,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        borderRadius: 30,
        background:
          rippleHighlight > 0.02
            ? `linear-gradient(165deg, rgba(255, 255, 255, 0.99) 0%, rgba(250, 244, 248, 0.96) 100%)`
            : repHighlight > 0.02
              ? "rgba(255, 255, 255, 0.99)"
              : "rgba(255, 255, 255, 0.92)",
        backdropFilter: "blur(20px)",
        boxShadow:
          rippleHighlight > 0.02
            ? `0 32px 68px -20px rgba(232, 93, 135, ${(0.28 * rippleHighlight).toFixed(2)}), 0 0 0 2px rgba(232, 93, 135, ${(0.42 * rippleHighlight).toFixed(2)}), ${ELEVATION.cardSoft}`
            : repHighlight > 0.02 && rep
              ? `0 28px 60px -18px ${rep.softBg}, 0 0 0 ${rep.badge ? 2.2 : 1.5}px ${rep.border}, ${ELEVATION.cardSoft}`
              : ELEVATION.cardSoft,
        opacity: enterOpacity,
        transformOrigin: "50% 85%",
        transform: `perspective(1200px) translate3d(${convergeX.toFixed(2)}px, ${(keyLiftY + repLiftY + secondaryWaveY + convergeY).toFixed(2)}px, 0px) rotateX(${(keyRotateX * (1 - collapseProgress)).toFixed(2)}deg) rotateZ(${(keyRotateZ * (1 - collapseProgress)).toFixed(2)}deg) scale(${finalScale.toFixed(3)})`
      }}
    >
      {rep?.badge && repHighlight > 0.02 ? (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            padding: "4px 11px",
            borderRadius: 999,
            background: rep.softBg,
            boxShadow: `0 0 0 1px ${rep.border}`,
            color: rep.accent,
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: -0.2,
            opacity: repHighlight,
            scale: 0.88 + repHighlight * 0.12
          }}
        >
          {rep.badge}
        </div>
      ) : null}
      <div
        style={{
          width: 96,
          height: 82,
          borderRadius: 22,
          background:
            rippleHighlight > 0.05
              ? "rgba(232, 93, 135, 0.10)"
              : repHighlight > 0.05 && rep
                ? rep.softBg
                : "rgba(244, 245, 248, 0.85)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          scale: 1 + rippleHighlight * 0.06 + repHighlight * 0.04
        }}
      >
        <Img src={staticFile(`media/providers/${logo.file}`)} style={{width: 68, height: 68, objectFit: "contain"}} />
      </div>
      <div
        style={{
          color: COLORS.foreground,
          fontSize: logo.id === "amd" ? 21 : 24,
          fontWeight: repHighlight > 0.2 ? 700 : 600,
          lineHeight: 1.2,
          whiteSpace: "nowrap",
          textAlign: "center",
          letterSpacing: -0.3
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
  const footerExitOpacity = interpolate(frame, [collapseAt - 2, collapseAt + 4], [1, 0], CLAMP);

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
          top: 266,
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
          left: 84,
          right: 84,
          top: 796,
          display: "flex",
          justifyContent: "center",
          gap: 20,
          opacity: footerExitOpacity
        }}
      >
        {BENEFIT_ANCHORS.map((item) => {
          const itemStart = wallAt + item.enterOffset;
          const itemEnter = interpolate(frame, [itemStart, itemStart + 10], [0, 1], {...CLAMP, easing: ENTRANCE});
          return (
            <div
              key={item.text}
              style={{
                padding: "13px 26px 13px 18px",
                borderRadius: 999,
                background: "rgba(255, 255, 255, 0.95)",
                backdropFilter: "blur(20px)",
                boxShadow: `0 18px 38px -16px rgba(17, 24, 39, 0.14), 0 0 0 1.5px ${item.border}`,
                display: "flex",
                alignItems: "center",
                gap: 12,
                opacity: itemEnter,
                translate: `0px ${((1 - itemEnter) * 18).toFixed(1)}px`,
                scale: 0.94 + itemEnter * 0.06
              }}
            >
              <span
                style={{
                  padding: "4px 12px",
                  borderRadius: 999,
                  background: item.bg,
                  color: item.accent,
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: -0.2
                }}
              >
                {item.tag}
              </span>
              <span
                style={{
                  color: COLORS.foreground,
                  fontSize: 23,
                  fontWeight: 650,
                  letterSpacing: -0.4,
                  whiteSpace: "nowrap"
                }}
              >
                {item.text}
              </span>
            </div>
          );
        })}
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
      <BrandWhisper opacity={introTitleOpacity} />
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 156,
          width: 600,
          opacity: introTitleOpacity
        }}
      >
        <div
          style={{
            color: COLORS.foreground,
            fontSize: 68,
            fontWeight: 600,
            lineHeight: 1.16,
            letterSpacing: -2.4
          }}
        >
          选择平台，
          <br />
          从预设开始。
        </div>
        <div
          style={{
            marginTop: 20,
            color: COLORS.muted,
            fontSize: 25,
            fontWeight: 400,
            lineHeight: 1.5
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
            width={976}
            startFrom={dialogShot.source + 6}
            playbackRate={dialogShot.playbackRate}
            duration={dialogShot.duration}
            animate={false}
            tilt={-7}
            style={{left: 848, top: 88}}
          />
        </Sequence>
      </div>

      <LogoWall />
      <ContinuousClaim />
    </div>
  );
};
