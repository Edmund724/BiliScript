export function filterAvailableModels(
  modelsApiResponse: unknown,
  wanted: string[]
): string[] {
  if (modelsApiResponse == null || typeof modelsApiResponse !== "object") return [];
  const data = (modelsApiResponse as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const availableIds = new Set(
    data
      .map((entry) => (entry != null && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string")
  );

  return wanted.filter((model) => availableIds.has(model));
}
