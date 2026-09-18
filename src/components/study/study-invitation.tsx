'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown } from '@/components/icons';
import type { ScreenProps } from '@/lib/contracts';
import { studyInvitation, studyResumeItems } from '@/lib/study-invitation';
import { readEssayDrafts } from '@/lib/study-drafts';
import { readStudySessions } from '@/lib/study-sessions';
import styles from './study-invitation.module.css';

/** A small stack of notes: decorative, never a fabricated learning milestone. */
function MemoryNotes() {
  return (
    <svg className={styles.art} viewBox="0 0 156 156" fill="none" aria-hidden="true">
      <ellipse cx="82" cy="137" rx="55" ry="7" fill="currentColor" opacity=".07" />
      <circle cx="86" cy="79" r="63" fill="currentColor" opacity=".08" />
      <g transform="rotate(14 88 82)">
        <rect x="48" y="24" width="82" height="108" rx="12" fill="currentColor" opacity=".38" />
      </g>
      <g transform="rotate(-10 74 87)">
        <rect x="30" y="32" width="84" height="106" rx="12" fill="#FFE3CB" />
        <rect x="30" y="27" width="84" height="106" rx="12" fill="white" />
        <path d="M87 27h13v30l-6.5-5-6.5 5V27Z" fill="currentColor" />
        <path
          d="M47 57h25M47 73h48M47 89h39M47 105h22"
          stroke="#DDD5CF"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M46 72h36"
          stroke="currentColor"
          strokeWidth="10"
          strokeLinecap="round"
          opacity=".35"
        />
      </g>
      <path
        d="M133 33v12M127 39h12M19 100v8M15 104h8"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function StudyInvitation({ props }: { props: ScreenProps }) {
  const [expanded, setExpanded] = useState(false);
  const [, refreshSavedWork] = useState(0);
  useEffect(() => {
    const refresh = () => refreshSavedWork((value) => value + 1);
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  const resumes = studyResumeItems(
    props.data,
    readEssayDrafts(props.data.profile.id),
    readStudySessions(props.data.profile.id),
  );
  const invitation = resumes[0] || studyInvitation(props.data);
  if (!invitation) return null;
  const multiple = resumes.length > 1;
  const heading = multiple ? ['하던 공부부터', '이어가 볼까요?'] : invitation.heading;
  const description = multiple
    ? '여러 개여도 괜찮아요. 지금 하고 싶은 것부터 골라요.'
    : invitation.description;
  return (
    <section
      className={styles.invitation}
      aria-labelledby="study-invitation-title"
      data-study-invitation={invitation.kind}
    >
      <div className={styles.intro}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>
            {resumes[0] && Date.now() - Date.parse(resumes[0].updatedAt) > 7 * 86400000
              ? '다시 시작해도 괜찮아요'
              : '오늘의 작은 공부'}
          </p>
          <h2 id="study-invitation-title">
            <span>{heading[0]}</span>
            <span>{heading[1]}</span>
          </h2>
        </div>
        <MemoryNotes />
      </div>
      <p className={styles.description}>{description}</p>
      <button
        type="button"
        className={styles.start}
        onClick={() => props.navigate(invitation.href)}
      >
        <span className={styles.context}>{invitation.context}</span>
        <span className={styles.prompt}>{invitation.prompt}</span>
        {resumes[0] && <span className={styles.progress}>{resumes[0].progress}</span>}
        <span className={styles.action}>
          <span>{invitation.action}</span>
          <ArrowRight size={19} aria-hidden="true" />
        </span>
      </button>
      {multiple && (
        <div className={styles.otherActivities}>
          <button
            type="button"
            className={styles.expand}
            aria-expanded={expanded}
            aria-controls="study-resume-list"
            onClick={() => setExpanded(!expanded)}
          >
            <span>다른 학습 {resumes.length - 1}개 이어가기</span>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
          {expanded && (
            <ul id="study-resume-list" className={styles.resumeList} aria-label="이어서 할 학습">
              {resumes.slice(1).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={styles.resumeRow}
                    onClick={() => props.navigate(item.href)}
                  >
                    <span>
                      <span className={styles.context}>{item.context}</span>
                      <span className={styles.resumeTitle}>{item.prompt}</span>
                      <span className={styles.progress}>{item.progress}</span>
                    </span>
                    <ArrowRight size={18} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
