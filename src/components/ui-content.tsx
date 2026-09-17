'use client';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from './icons';
import styles from './ui-content.module.css';

/** A readable content surface with a clearly separate, keyboard-operable disclosure row. */
export function Disclosure({
  title,
  meta,
  children,
  className = '',
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`${styles.disclosure} ${className}`} data-surface="muted">
      <summary>
        <span>{title}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
        <ChevronDown size={18} aria-hidden="true" />
      </summary>
      <div className={styles.content}>{children}</div>
    </details>
  );
}

/** Flat actions are grouped by purpose; only the main task needs a filled button. */
export function ActionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className={styles.group} aria-label={label}>
      <h3>{label}</h3>
      <div>{children}</div>
    </section>
  );
}
export function ActionRow({
  icon,
  children,
  danger = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      className={`${styles.action} ${danger ? styles.danger : ''} ${className}`}
      {...props}
    >
      {icon}
      <span>{children}</span>
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  );
}
