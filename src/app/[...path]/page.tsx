// The shared root layout owns the client shell and reads window.location. The static export writes
// out/<screen>.html per known top-level screen so a direct visit is a real document; deeper paths
// (/subjects/<id>, /flashcards?card=…) are answered with the shell by the Go server's fallback.
export const screens = [
  'study',
  'subjects',
  'quiz',
  'essay',
  'flashcards',
  'wrong-notes',
  'create-card',
  'completed-subjects',
  'community',
  'messages',
  'boards',
  'planner',
  'parent',
  'parent-boards',
  'cheer',
  'admin',
  'search',
  'notifications',
  'profile',
];
export function generateStaticParams() {
  return screens.map((screen) => ({ path: [screen] }));
}
export default function Page() {
  return null;
}
