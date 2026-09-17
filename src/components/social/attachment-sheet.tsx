'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, X } from '@/components/icons';
import { IconButton } from '@/components/ui';
import { useJourneyLayer } from '@/components/journey';
import styles from './attachment-sheet.module.css';

/** One short, focused tool layered above the page-shaped editor. */
export function AttachmentSheet({
  open,
  onClose,
  onBack,
  title,
  description,
  children,
  footer,
  backLabel = '이전 단계',
  closeLabel = '닫기',
  flush = false,
  history = true,
}: {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  backLabel?: string;
  closeLabel?: string;
  children: ReactNode;
  flush?: boolean;
  history?: boolean;
}) {
  const close = useJourneyLayer(open && history, onClose);
  const [viewport, setViewport] = useState<{ height: number; bottom: number }>();
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const visual = window.visualViewport;
    const measure = () =>
      setViewport({
        height: visual?.height ?? window.innerHeight,
        bottom: Math.max(
          0,
          window.innerHeight - (visual?.height ?? window.innerHeight) - (visual?.offsetTop ?? 0),
        ),
      });
    measure();
    visual?.addEventListener('resize', measure);
    visual?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      visual?.removeEventListener('resize', measure);
      visual?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [open]);
  useEffect(() => {
    if (open) heading.current?.focus({ preventScroll: true });
  }, [open, title]);
  const style = viewport
    ? ({
        '--attachment-height': `${viewport.height * 0.9}px`,
        bottom: viewport.bottom,
      } as CSSProperties)
    : undefined;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          style={style}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={(event) => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            event.preventDefault();
            heading.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current;
            requestAnimationFrame(() => {
              if (target?.isConnected) target.focus({ preventScroll: true });
            });
          }}
          onEscapeKeyDown={(event) => {
            if (onBack) {
              event.preventDefault();
              onBack();
            }
          }}
        >
          <div className={styles.heading}>
            {onBack && (
              <IconButton label={backLabel} onClick={onBack}>
                <ArrowLeft size={22} />
              </IconButton>
            )}
            <div className={styles.headingCopy}>
              <Dialog.Title ref={heading} tabIndex={-1}>
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description asChild>
                  <div className={styles.description}>{description}</div>
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton label={closeLabel}>
                <X size={22} />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className={`${styles.content} ${flush ? styles.flush : ''}`}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
