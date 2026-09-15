'use client';
import type { ReactNode } from 'react';
import { ArrowLeft, X } from '@/components/icons';
import { IconButton } from '@/components/ui';

/** Study-tab header: the shared 64px header geometry with a close button and a two-line centered title. */
export function StudyHeader({
  title,
  subtitle,
  back,
  close,
  action,
  large = false,
}: {
  title?: string;
  subtitle?: string;
  back?: () => void;
  close?: () => void;
  action?: ReactNode;
  large?: boolean;
}) {
  return (
    <header
      className={`screen-header study-header${subtitle ? ' study-header-center' : ''}${large ? ' study-header-large' : ''}`}
    >
      {back && (
        <IconButton label="뒤로 가기" onClick={back}>
          <ArrowLeft size={22} />
        </IconButton>
      )}
      {close && (
        <IconButton label="닫기" onClick={close}>
          <X size={22} />
        </IconButton>
      )}
      {title &&
        (subtitle ? (
          <div className="study-header-title">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
        ) : (
          <h1>{title}</h1>
        ))}
      <div className="header-actions">{action}</div>
    </header>
  );
}
