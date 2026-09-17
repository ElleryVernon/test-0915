import type { Material, Subject } from './contracts';

export type MaterialSort = 'recent' | 'name';
const titleOrder = (a: Material, b: Material) =>
  a.title.localeCompare(b.title, 'ko', { numeric: true }) || a.id.localeCompare(b.id);
export function sortedMaterials(materials: Material[], sort: MaterialSort = 'recent') {
  return [...materials].sort((a, b) =>
    sort === 'name'
      ? titleOrder(a, b)
      : (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || titleOrder(a, b),
  );
}
export function generationDefault(materials: Material[], initial: string) {
  return (
    materials.find((m) => m.id === initial)?.id ||
    ''
  );
}
export function materialChoices(
  materials: Material[],
  subjects: Subject[],
  query: string,
  subject: string,
  sort: MaterialSort,
) {
  const names = new Map(subjects.map((s) => [s.id, s.name]));
  const needle = query.trim().toLocaleLowerCase('ko');
  return sortedMaterials(
    materials.filter(
      (m) =>
        (!subject || m.subjectId === subject) &&
        (!needle ||
          `${m.title} ${names.get(m.subjectId) || ''}`.toLocaleLowerCase('ko').includes(needle)),
    ),
    sort,
  );
}
export function materialDate(material: Material) {
  const date = new Date(material.createdAt);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('ko-KR', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        timeZone: 'Asia/Seoul',
      });
}
