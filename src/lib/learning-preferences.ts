import type { ExplanationDepth } from './explanation-types';
export function readExplanationDepth(userId: string): ExplanationDepth {
  try {
    return window.localStorage.getItem(`memoryz:explanation-depth:${userId}`) === 'FULL'
      ? 'FULL'
      : 'SHORT';
  } catch {
    return 'SHORT';
  }
}
export function saveExplanationDepth(userId: string, depth: ExplanationDepth): boolean {
  try {
    window.localStorage.setItem(`memoryz:explanation-depth:${userId}`, depth);
    return true;
  } catch {
    return false;
  }
}
