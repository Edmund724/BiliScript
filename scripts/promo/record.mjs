import {updateRecordedPanelCrop} from "./panel-crops.mjs";
import {writeRecordingEvidence} from "./recorder.mjs";

const loaders = {
  hero: () => import("./record-hero.mjs"),
  subtitle: () => import("./record-subtitle-seek-03.mjs"),
  overview: () => import("./record-overview-04.mjs"),
  chat: () => import("./record-chat.mjs"),
  providers: () => import("./record-providers-06.mjs")
};

const scene = process.argv[2];
if (!Object.hasOwn(loaders, scene)) {
  throw new Error(`用法：node scripts/promo/record.mjs <${Object.keys(loaders).join("|")}>`);
}

const {record} = await loaders[scene]();
const result = await record();
const panelCrop = await updateRecordedPanelCrop(scene, result.recordings);
if (panelCrop) result.outputs.push(panelCrop);
const evidence = await writeRecordingEvidence(scene, result);
console.log(`镜头 ${scene} 已输出：\n${result.outputs.join("\n")}\n录制证据：${evidence}`);
