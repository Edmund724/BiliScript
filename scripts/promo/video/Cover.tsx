import {AbsoluteFill} from "remotion";
import {Backdrop, Brand, COLORS, FONT_FAMILY, PANEL_CROPS, ProductFrame} from "./design";

export const Cover = () => (
  <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
    <Backdrop />
    <Brand size={112} iconSize={76} style={{position: "absolute", left: 160, top: 302}} />
    <div style={{position: "absolute", left: 166, top: 484, width: 720, color: COLORS.foreground, fontSize: 42, lineHeight: 1.34, letterSpacing: -1.2}}>
      在 B 站，读视频。
    </div>
    <ProductFrame crop={PANEL_CROPS.overview} width={560} animate={false} style={{left: 1180, top: 48}} />
  </AbsoluteFill>
);
