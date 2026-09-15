'use client';
import type { ScreenProps } from '@/lib/contracts';
import { CompletedSubjects, StudyHome, SubjectDetail } from './subjects';
import { Quiz, WrongNotes } from './quiz';
import { EssayScreen } from './essay';
import { Flashcards } from './cards';
import { CreateCard } from './create-card';

export default function StudyScreens(props: ScreenProps) {
  const pathname = props.path.split('?')[0];
  if (pathname.startsWith('/subjects/')) return <SubjectDetail {...props} />;
  if (pathname === '/quiz') return <Quiz {...props} />;
  if (pathname === '/essay') return <EssayScreen {...props} />;
  if (pathname === '/flashcards') return <Flashcards {...props} />;
  if (pathname === '/wrong-notes') return <WrongNotes {...props} />;
  if (pathname === '/create-card') return <CreateCard {...props} />;
  if (pathname === '/completed-subjects') return <CompletedSubjects {...props} />;
  return <StudyHome {...props} />;
}
