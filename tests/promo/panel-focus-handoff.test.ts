import {describe, expect, it} from "vitest";
import {AUDIO} from "../../scripts/promo/audio.mjs";
import {PANEL_FOCUS_HANDOFFS, SCENES} from "../../scripts/promo/timeline.mjs";

describe("面板失焦接续", () => {
  it("在金句到对话、对话到外观之间保留六帧退场、干净切点和七帧合焦", () => {
    expect(PANEL_FOCUS_HANDOFFS).toEqual([
      {from: "overview", to: "chat", at: 390, exitFrames: 6, enterFrames: 7, maxBlur: 12},
      {from: "chat", to: "appearance", at: 570, exitFrames: 6, enterFrames: 7, maxBlur: 12}
    ]);
    for (const handoff of PANEL_FOCUS_HANDOFFS) {
      const outgoing = SCENES.find((scene) => scene.id === handoff.from)!;
      const incoming = SCENES.find((scene) => scene.id === handoff.to)!;
      expect(outgoing.from + outgoing.duration).toBe(handoff.at);
      expect(incoming.from).toBe(handoff.at);
    }
  });

  it("让退场声与合焦声分别落在转场两端", () => {
    const cues = AUDIO.cues.map((cue) => [cue.id, cue.frame, cue.src]);
    for (const handoff of PANEL_FOCUS_HANDOFFS) {
      expect(cues).toContainEqual([`${handoff.from}-defocus`, handoff.at - handoff.exitFrames, "media/sfx/click.wav"]);
      expect(cues).toContainEqual([`${handoff.to}-focus`, handoff.at + handoff.enterFrames, "media/sfx/whoosh.wav"]);
    }
    expect(cues).not.toContainEqual(["chat-cut", 390, "media/sfx/whoosh.wav"]);
    expect(cues).not.toContainEqual(["appearance-cut", 570, "media/sfx/whoosh.wav"]);
  });
});
