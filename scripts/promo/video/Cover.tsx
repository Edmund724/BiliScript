import {AbsoluteFill} from "remotion";
import {Backdrop, Brand, BRAND_FONT_FAMILY, COLORS, ELEVATION, FONT_FAMILY, PANEL_CROPS, ProductFrame} from "./design";

export const Cover = () => (
  <AbsoluteFill style={{fontFamily: FONT_FAMILY, perspective: 1600}}>
    <Backdrop />
    <Brand size={88} iconSize={68} style={{position: "absolute", left: 108, top: 136}} />
    <div
      style={{
        position: "absolute",
        left: 112,
        top: 274,
        width: 860,
        color: COLORS.foreground,
        fontSize: 64,
        fontWeight: 600,
        lineHeight: 1.16,
        letterSpacing: -2.2
      }}
    >
      在 B 站，读下一条视频。
    </div>
    <div
      style={{
        position: "absolute",
        left: 114,
        top: 374,
        width: 620,
        color: COLORS.muted,
        fontSize: 25,
        lineHeight: 1.5,
        letterSpacing: -0.3
      }}
    >
      字幕检索 · 章节金句 · 视频追问 · 14 个 AI 平台预设
    </div>

    <div
      style={{
        position: "absolute",
        left: 112,
        top: 492,
        width: 790,
        padding: "36px 42px",
        borderRadius: 32,
        background: "rgba(255, 255, 255, 0.96)",
        boxShadow: ELEVATION.heroFloat,
        transform: "perspective(1600px) rotateX(4deg) rotateY(-8deg)"
      }}
    >
      <div style={{display: "flex", alignItems: "center", gap: 16, marginBottom: 20}}>
        <span
          style={{
            background: COLORS.pink,
            color: "#FFFFFF",
            fontFamily: BRAND_FONT_FAMILY,
            fontSize: 20,
            fontWeight: 600,
            padding: "5px 16px",
            borderRadius: 999
          }}
        >
          06:36
        </span>
        <span style={{fontSize: 30, fontWeight: 600, color: COLORS.foreground, letterSpacing: -0.7}}>
          AI 并非越强越好，适配才是关键
        </span>
      </div>
      <div style={{fontSize: 29, fontWeight: 600, lineHeight: 1.46, letterSpacing: -0.6, color: COLORS.inkSoft, marginBottom: 24}}>
        “只有<span style={{color: COLORS.pink}}>相互之间接得上</span>、能够在很大程度上对齐的才是最好的，不一定是最强的。”
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 18,
          borderTop: "1px solid rgba(17, 24, 39, 0.06)",
          color: COLORS.muted,
          fontSize: 20
        }}
      >
        <span>复旦赵斌 ·《AI 并非越强越好，适配才是关键》</span>
        <span
          style={{
            color: COLORS.blue,
            fontWeight: 600,
            background: "rgba(38, 121, 184, 0.08)",
            padding: "6px 16px",
            borderRadius: 999
          }}
        >
          48:16 公开课 ↗
        </span>
      </div>
    </div>

    <ProductFrame crop={PANEL_CROPS.overview} width={580} animate={false} tilt={-8} style={{left: 1156, top: 48}} />
  </AbsoluteFill>
);
