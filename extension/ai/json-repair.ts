export function stripModelReasoningAndFences(rawText: unknown): string {
  let text = String(rawText ?? "").trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (/^<think>/i.test(text) && text.includes("{")) {
    const braceIdx = text.indexOf("{");
    if (braceIdx > 0) {
      text = text.slice(braceIdx);
    }
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1]?.includes("{")) {
    return fenced[1].trim();
  }
  return text;
}

export function repairTruncatedJson(text: unknown): string {
  const source = String(text ?? "");
  let inString = false;
  let danglingEscape = false;
  const stack: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        if (i + 1 >= source.length) {
          danglingEscape = true;
          break;
        }
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      stack.push(ch);
    } else if (ch === "]" || ch === "}") {
      stack.pop();
    }
  }
  let repaired = source;
  if (danglingEscape) repaired = repaired.slice(0, -1);
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length) {
    repaired += stack.pop() === "[" ? "]" : "}";
  }
  return repaired;
}

export function parseLooseJson(text: unknown): unknown {
  let cleaned = String(text ?? "").trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  const candidates: string[] = [];
  if (firstBrace === 0) {
    candidates.push(cleaned);
  }
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
    const noTrailingComma = candidate.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(noTrailingComma);
    } catch {}
    try {
      return JSON.parse(repairTruncatedJson(noTrailingComma));
    } catch {}
  }
  return JSON.parse(candidates[candidates.length - 1] ?? cleaned);
}
