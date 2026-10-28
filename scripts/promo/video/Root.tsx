import {Composition} from "remotion";
import {PROMO_DURATION, PROMO_FPS, PROMO_HEIGHT, PROMO_WIDTH, SCENES} from "../timeline.mjs";
import {Cover} from "./Cover";
import {Promo, PromoScene} from "./Promo";

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="BiliScript"
        component={Promo}
        durationInFrames={PROMO_DURATION}
        fps={PROMO_FPS}
        width={PROMO_WIDTH}
        height={PROMO_HEIGHT}
      />
      <Composition
        id="Cover"
        component={Cover}
        durationInFrames={1}
        fps={PROMO_FPS}
        width={PROMO_WIDTH}
        height={PROMO_HEIGHT}
      />
      {SCENES.map((scene, index) => (
        <Composition
          key={scene.id}
          id={`Scene-${scene.id}`}
          component={PromoScene}
          defaultProps={{
            id: scene.id,
            duration: scene.duration,
            final: index === SCENES.length - 1
          }}
          durationInFrames={scene.duration}
          fps={PROMO_FPS}
          width={PROMO_WIDTH}
          height={PROMO_HEIGHT}
        />
      ))}
    </>
  );
};
