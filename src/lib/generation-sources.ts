/** A canonical source set makes ordering changes idempotent and keeps legacy tasks recoverable. */
export function generationSourcePayload(
  ids: string[],
  subjectId: string,
  topic = '',
): Record<string, unknown> {
  const materialIds = [...new Set(ids)].sort();
  if (materialIds.length === 1 && !topic.trim()) return { materialId: materialIds[0] };
  return { materialIds, subjectId, topic: topic.trim() };
}
export function generatedMaterialId(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const item = result.find(
    (item) => item && typeof item === 'object' && typeof item.materialId === 'string',
  );
  return item?.materialId || null;
}
