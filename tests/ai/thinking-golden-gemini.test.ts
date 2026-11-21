import { channelHarness, type ByClassCase } from "./thinking-golden-classes.js";
import { registerByClassDefenses, registerByClassGolden } from "./thinking-golden-defenses.js";

const HARNESS = channelHarness("gemini");

const CASES: readonly ByClassCase[] = [
  { valuesetId: "b:128-32768", presetId: "gemini", model: "gemini-2.5-pro", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "low-high", presetId: "gemini", model: "gemini-3-pro-image", available: ["low", "high"], fields: [{"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":false}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}] },
  { valuesetId: "low-medium-high", presetId: "gemini", model: "gemini-3.1-pro-preview", available: ["low", "medium", "high"], fields: [{"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":false}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"MEDIUM","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}] },
  { valuesetId: "minimal-high", presetId: "gemini", model: "gemini-3.1-flash-image", available: ["minimal", "high"], fields: [{"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":false}}, {"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}] },
  { valuesetId: "minimal-low-medium-high", presetId: "gemini", model: "gemini-3-flash-preview", available: ["minimal", "low", "medium", "high"], fields: [{"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":false}}, {"thinkingConfig":{"thinkingLevel":"MINIMAL","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"LOW","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"MEDIUM","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}, {"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":true}}] },
  { valuesetId: "toggle", presetId: "gemini", model: "gemma-4-26b-a4b-it", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:0-24576", presetId: "gemini", model: "gemini-2.5-flash", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
  { valuesetId: "toggle+b:512-24576", presetId: "gemini", model: "gemini-2.5-flash-lite", available: [], fields: [{}, {}, {}, {}, {}, {}, {}] },
];

registerByClassGolden(HARNESS, CASES);
registerByClassDefenses(HARNESS, CASES);
