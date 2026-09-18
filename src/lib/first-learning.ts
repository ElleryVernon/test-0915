import type { AppData } from './contracts';
import { studyOnboarding } from './study-onboarding';

/** Real content and saved learning events drive activation, never an onboarding-seen flag. */
export function firstLearning(data: AppData) {
  const material = data.materials.find((item) => item.extraction === 'sample');
  const card = data.cards.find(
    (item) => !item.deleted && item.materialId === material?.id && item.sourceKind === 'STARTER',
  );
  const question = data.questions.find((item) => item.id === card?.sourceQuestionId);
  const attempt = question
    ? data.attempts
        .filter((item) => item.questionId === question.id)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
    : undefined;
  const reviewed = (card?.reviewCount ?? 0) > 0;
  const complete = !!attempt && reviewed;
  const hasPersonalContent =
    data.materials.some((item) => item.extraction !== 'sample') ||
    data.questions.some((item) => item.materialId !== material?.id) ||
    data.essays.some((item) => item.materialId !== material?.id) ||
    data.cards.some((item) => !item.deleted && item.materialId !== material?.id);
  const showWelcome =
    !data.demo &&
    (studyOnboarding(data).phase === 'first-source' || (!!material && !hasPersonalContent));
  return { material, card, question, attempt, reviewed, complete, showWelcome };
}
