'use client';

import { type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { IconButton } from '@/components/ui';
import { X } from '@/components/icons';
import { useJourneyLayer } from '@/components/journey';
import styles from './community-editor.module.css';

/** The writing surface is a page; only its focused tools appear as sheets. */
export function CommunityEditorPage({
  title,
  onClose,
  busy = false,
  action,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const close = useJourneyLayer(true, () => !busy && onClose());
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.backdrop} />
        <Dialog.Content
          className={styles.page}
          data-community-editor
          aria-describedby={undefined}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => busy && event.preventDefault()}
        >
          <header className={styles.header}>
            <IconButton label="글쓰기 닫기" disabled={busy} onClick={close}>
              <X size={22} />
            </IconButton>
            <Dialog.Title>{title}</Dialog.Title>
            <div className={styles.headerAction}>{action}</div>
          </header>
          <div className={styles.body}>{children}</div>
          {footer && <footer className={styles.footer}>{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
