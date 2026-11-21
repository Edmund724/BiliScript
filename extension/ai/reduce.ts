import { REDUCE_GROUP_INPUT_CHARS, REDUCE_TRIGGER_CHARS } from "./budgeter.js";
import { makeAbortedError } from "../shared/error-helpers.js";
import { runMapBounded } from "./pool.js";
import type { BudgetPlan } from "./types.js";

export const REDUCE_CONCURRENCY = 2;

function sumChars(list: unknown[]): number {
  return (Array.isArray(list) ? list : []).reduce<number>(
    (acc, s) => acc + String(s == null ? "" : s).length,
    0
  );
}

export function shouldReduce(plan: BudgetPlan | null | undefined): boolean {
  if (!plan) {
    return false;
  }
  return Number(plan.totalChars) > REDUCE_TRIGGER_CHARS || plan.needsReduce === true;
}

interface BuildReduceGroupsOptions {
  groupInputChars?: number | string;
}

export function buildReduceGroups(summaries: unknown[], { groupInputChars = REDUCE_GROUP_INPUT_CHARS }: BuildReduceGroupsOptions = {}): unknown[][] {
  const list = Array.isArray(summaries) ? summaries : [];
  const maxChars = Number(groupInputChars) > 0 ? Number(groupInputChars) : REDUCE_GROUP_INPUT_CHARS;
  const groups: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;
  for (const summary of list) {
    const chars = String(summary == null ? "" : summary).length;
    if (current.length > 0 && size + chars > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(summary);
    size += chars;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

interface BuildReducePromptInput {
  title: string;
  groupIndex: number;
  groupCount: number;
  group: unknown[];
}

export function buildReducePrompt({ title, groupIndex, groupCount, group }: BuildReducePromptInput): string {
  const material = (Array.isArray(group) ? group : [])
    .map((s) => String(s == null ? "" : s))
    .join("\n\n");
  return `视频标题：${title}
这是长视频合并材料的第 ${groupIndex}/${groupCount} 批。

请合并以下连续片段笔记，去除重复但保留观点、依据、例子、时间点和前后关系。
不要评价，不补充外部知识，只输出供最终成稿使用的连续材料。

片段笔记：
${material}`;
}

interface RunPromptsInput {
  prompt?: string;
  messages?: unknown[];
}

interface ReduceSummariesInput {
  summaries: unknown[];
  title: string;
  runPrompts: (input: RunPromptsInput) => Promise<unknown>;
  signal?: AbortSignal | null;
  onProgress?: (notice: string) => void;
  groupInputChars?: number | string;
}

interface ReduceSummariesResult {
  merged: string[];
  levels: number;
}

export async function reduceSummaries({
  summaries,
  title,
  runPrompts,
  signal,
  onProgress,
  groupInputChars = REDUCE_GROUP_INPUT_CHARS
}: ReduceSummariesInput): Promise<ReduceSummariesResult> {
  const maxChars = Number(groupInputChars) > 0 ? Number(groupInputChars) : REDUCE_GROUP_INPUT_CHARS;
  let merged: string[] = Array.isArray(summaries) ? summaries.map((s) => String(s == null ? "" : s)) : [];
  let levels = 0;

  while (sumChars(merged) > maxChars) {
    if (signal?.aborted) {
      throw makeAbortedError();
    }
    const groups = buildReduceGroups(merged, { groupInputChars: maxChars });
    if (groups.length >= merged.length) {
      break;
    }
    levels += 1;
    merged = await runMapBounded({
      items: groups,
      worker: async (group, index) => {
        const text = await runPrompts({
          prompt: buildReducePrompt({
            title,
            groupIndex: index + 1,
            groupCount: groups.length,
            group
          })
        });
        const trimmed = String(text || "").trim();
        return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
      },
      concurrency: REDUCE_CONCURRENCY,
      signal,
      onItemDone: (_result, index) => {
        if (typeof onProgress === "function") {
          onProgress(`正在归并第 ${levels} 层 ${index + 1}/${groups.length} 组`);
        }
      }
    });
    if (signal?.aborted) {
      throw makeAbortedError();
    }
  }

  return { merged, levels };
}
