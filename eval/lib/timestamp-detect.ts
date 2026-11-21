export interface TimestampDetection {
  hasResponseStructure: boolean;
  hasInline: boolean;
  matchedPatterns: string[];
}

export function detectTimestamps(
  response: { text: string; segments?: unknown },
  inlinePatterns: RegExp[]
): TimestampDetection {
  const hasResponseStructure = Array.isArray(response.segments) && response.segments.length > 0;

  const matchedPatterns: string[] = [];
  for (const pattern of inlinePatterns) {
    if (!pattern.test(response.text)) continue;
    if (!matchedPatterns.includes(pattern.source)) {
      matchedPatterns.push(pattern.source);
    }
  }

  return {
    hasResponseStructure,
    hasInline: matchedPatterns.length > 0,
    matchedPatterns
  };
}
