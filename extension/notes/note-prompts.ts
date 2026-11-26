import type { NotePromptPreset } from "../core/defaults.js";
import { normalizeSiteId, type SiteId } from "../shared/site.js";

export interface NotePromptPresetOption {
  readonly value: NotePromptPreset;
  readonly label: string;
}

export const NOTE_PROMPT_PRESET_OPTIONS: readonly NotePromptPresetOption[] = [
  { value: "general", label: "通用结构化" },
  { value: "tutorial", label: "教程实操" },
  { value: "course", label: "课程学习" },
  { value: "opinion", label: "观点提炼" },
  { value: "custom", label: "自定义" }
];

const PRESET_LABEL_MAP: Readonly<Record<NotePromptPreset, string>> = {
  general: "通用结构化",
  tutorial: "教程实操",
  course: "课程学习",
  opinion: "观点提炼",
  custom: "自定义"
};

export interface BuildVideoNotePromptInput {
  preset: NotePromptPreset | unknown;
  customPrompt?: unknown;
  site: SiteId | unknown;
  supportsHotComments: boolean;
  includeKeyframes: boolean;
}

function normalizePreset(value: unknown): NotePromptPreset {
  const raw = String(value ?? "").trim();
  if (raw === "tutorial" || raw === "course" || raw === "opinion" || raw === "custom") {
    return raw;
  }
  return "general";
}

export function getNotePromptPresetLabel(preset: NotePromptPreset | unknown): string {
  return PRESET_LABEL_MAP[normalizePreset(preset)];
}

function buildPresetBody(
  preset: Exclude<NotePromptPreset, "custom">,
  creatorLabel: string
): string[] {
  switch (preset) {
    case "tutorial":
      return [
        "请按以下结构整理为可直接照做的教程实操笔记：",
        "1. **目标产物与前置环境**：明确最终可复现的结果、适用平台/版本及前置条件。",
        "2. **依赖与配置清单**：列出工具、包版本、环境变量或关键配置项。",
        "3. **分步操作流程**：按步骤写出操作细节，完整保留命令、代码片段、关键参数值，并在每步关键节点附 `[MM:SS]` 时间戳。",
        "4. **常见报错与排错避坑**：汇总视频提到的易错点、限制条件及排查方案。"
      ];
    case "course":
      return [
        "请按以下结构整理为系统化的课程学习讲义：",
        "1. **知识地图**：梳理核心模块之间的依赖与演进关系，结构复杂时使用 Mermaid 图表呈现。",
        "2. **核心概念与术语定义**：准确提炼定义、符号含义与直观解释。",
        "3. **模块化推导讲义**：分模块还原推导过程、例题与关键结论，公式使用 LaTeX 语法保留，并在关键节点附 `[MM:SS]` 时间戳。",
        "4. **易混点辨析与自测复盘**：对比易混淆概念，并在末尾给出 3 道检验理解的自测复盘题（附简明要点提示）。"
      ];
    case "opinion":
      return [
        "请按以下结构整理为高信息密度的观点提炼笔记：",
        `1. **核心论点**：提炼${creatorLabel}最核心的立场与主张。`,
        "2. **论证链条拆解**：逐条拆解分论点，对应记录案例、数据支撑、反例与 `[MM:SS]` 时间戳。",
        "3. **隐含前提与适用边界**：指出论证依赖的前提条件、局限性及可能不成立的场景。"
      ];
    case "general":
    default:
      return [
        "请按以下结构整理为清晰易读的视频笔记：",
        "1. **一句话主旨**：用一句话概括视频的核心价值与结论。",
        "2. **逻辑脉络大纲**：按内容演进梳理主干结构。",
        "3. **分节详述**：围绕各主题展开关键细节，在重要节点以 `[MM:SS]` 标注时间戳锚点。",
        "4. **关键数据、结论与可执行启发**：汇总可复用的数字、结论及行动建议。"
      ];
  }
}

export function buildVideoNotePrompt(input: BuildVideoNotePromptInput): string {
  const site = normalizeSiteId(input.site);
  const platformVideo = site === "youtube" ? "YouTube 视频" : "B 站视频";
  const creatorLabel = site === "youtube" ? "频道作者" : "UP 主";
  const requestedPreset = normalizePreset(input.preset);
  const customText = String(input.customPrompt ?? "").replace(/\r\n?/g, "\n").trim();

  const lines: string[] = [
    `请基于当前${platformVideo}的字幕与内容，撰写一份可直接归档的 Markdown 视频笔记（无需寒暄或复述要求，直接输出正文）。`
  ];

  if (requestedPreset === "custom" && customText) {
    lines.push("", "## 自定义笔记要求", customText);
  } else {
    const effectivePreset: Exclude<NotePromptPreset, "custom"> =
      requestedPreset === "custom" ? "general" : requestedPreset;
    lines.push("", "## 笔记结构", ...buildPresetBody(effectivePreset, creatorLabel));
  }

  const rules: string[] = [
    `- 忠实于原片内容，转述观点时使用「${creatorLabel}提到/认为」等归属表述，过滤口播广告与无意义寒暄。`,
    "- 关键时间锚点统一使用普通文本 `[MM:SS]`（超过 1 小时用 `[HH:MM:SS]`），不要用反引号包裹，便于自动转为可跳转深链。"
  ];

  if (site === "bilibili" && input.supportsHotComments === true) {
    rules.push(
      "- 若上下文包含高价值评论纠错或事实补充，可择优吸收并显式注明为评论补充，避免与 UP 主原片观点混淆。"
    );
  }

  if (input.includeKeyframes === true) {
    rules.push(
      "- 仅在涉及架构图、PPT 页面、板书推导、代码演示或关键对比画面处，独立成行插入 `{{frame:MM:SS | 画面简述}}`（全文最多 6 处，纯口播或过渡画面不插图）。"
    );
  }

  lines.push("", "## 写作与格式约束", ...rules);
  return lines.join("\n");
}
