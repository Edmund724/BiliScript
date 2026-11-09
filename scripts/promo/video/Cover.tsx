import {AbsoluteFill, Sequence} from "remotion";
import {OUTRO_TIMELINE} from "../outro-timeline.mjs";
import {Backdrop, COLORS} from "./design";
import {OutroScene} from "./OutroScene";

export const Cover = () => (
  <AbsoluteFill style={{background: COLORS.background}}>
    <Backdrop />
    <Sequence from={1 - OUTRO_TIMELINE.duration}>
      <OutroScene />
    </Sequence>
  </AbsoluteFill>
);
