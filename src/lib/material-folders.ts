import type { Material, Subject } from './contracts';
import { materialChoices, type MaterialSort } from './study-library';

export const UNFILED_MATERIALS = '__unfiled__';
export interface MaterialFolder {
  id: string;
  name: string;
  semester: string;
  count: number;
  usableCount: number;
}

/** Subjects already own materials, so folders share that source of truth across devices. */
export function materialFolders(materials: Material[], subjects: Subject[]): MaterialFolder[] {
  const known = new Set(subjects.map((s) => s.id));
  const groups = new Map<string, Material[]>();
  for (const material of materials) {
    const key = known.has(material.subjectId) ? material.subjectId : UNFILED_MATERIALS;
    const group = groups.get(key) || [];
    group.push(material);
    groups.set(key, group);
  }
  const folders = [...subjects]
    .sort(
      (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }) || a.id.localeCompare(b.id),
    )
    .map((subject) => ({
      id: subject.id,
      name: subject.name,
      semester: subject.semester,
      count: groups.get(subject.id)?.length || 0,
      usableCount: groups.get(subject.id)?.filter((m) => m.contentLength >= 20).length || 0,
    }));
  const unfiled = groups.get(UNFILED_MATERIALS);
  if (unfiled?.length) {
    folders.push({
      id: UNFILED_MATERIALS,
      name: '과목 미지정',
      semester: '',
      count: unfiled.length,
      usableCount: unfiled.filter((m) => m.contentLength >= 20).length,
    });
  }
  return folders;
}

export function folderForMaterial(material: Material | undefined, subjects: Subject[]) {
  if (!material) return '';
  return subjects.some((s) => s.id === material.subjectId) ? material.subjectId : UNFILED_MATERIALS;
}

/** Search stays in the visible folder; at the root it searches all subjects and materials. */
export function folderMaterials(
  materials: Material[],
  subjects: Subject[],
  folderId: string,
  query: string,
  sort: MaterialSort,
) {
  const names = new Set(subjects.map((s) => s.id));
  const scoped =
    folderId === UNFILED_MATERIALS ? materials.filter((m) => !names.has(m.subjectId)) : materials;
  return materialChoices(
    scoped,
    subjects,
    query,
    folderId === UNFILED_MATERIALS ? '' : folderId,
    sort,
  );
}

export const MAX_GENERATION_SOURCES = 5;

/** Folder navigation and filtering must never reset an explicit selection. */
export function toggleMaterialSelection(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((value) => value !== id);
  return ids.length < MAX_GENERATION_SOURCES ? [...ids, id] : ids;
}

export function selectedMaterials(materials: Material[], ids: string[]): Material[] {
  return [...new Set(ids)].flatMap((id) => {
    const material = materials.find((item) => item.id === id);
    return material ? [material] : [];
  });
}
