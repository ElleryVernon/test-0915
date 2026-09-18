'use client';

import { useEffect, useRef, type ReactNode } from 'react';
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
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) heading.current?.focus({ preventScroll: true });
  }, [open, title]);
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
