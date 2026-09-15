'use client';
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { ArrowLeft, X, ChevronRight, Inbox, CalendarDays, Clock } from '@/components/icons';
import * as Dialog from '@radix-ui/react-dialog';

export function DateTimeField({
  type,
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { type: 'date' | 'time' }) {
  const Icon = type === 'date' ? CalendarDays : Clock;
  return (
    <span className={`date-time-field ${className}`}>
      <input {...props} type={type} className="field" />
      <Icon size={20} className="date-time-field-icon" />
    </span>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return (
    <button className={`btn btn-${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function IconButton({
  label,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button aria-label={label} title={label} className={`icon-button ${className}`} {...props}>
      {children}
    </button>
  );
}
export function ScreenHeader({
  title,
  back,
  action,
}: {
  title: string;
  back?: () => void;
  action?: ReactNode;
}) {
  return (
    <header className="screen-header">
      {back && (
        <IconButton label="뒤로 가기" onClick={back}>
          <ArrowLeft size={23} />
        </IconButton>
      )}
      {title && <h1>{title}</h1>}
      <div className="header-actions">{action}</div>
    </header>
  );
}
export function Sheet({
  open,
  onClose,
  title,
  children,
  fullScreen = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  fullScreen?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content
          className={`sheet-content${fullScreen ? ' sheet-content-full' : ''}`}
          aria-describedby={undefined}
        >
          <div className="sheet-handle" />
          <div className="sheet-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="닫기">
                <X size={22} />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="sheet-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Inbox size={30} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {action}
    </div>
  );
}
export function ListRow({
  icon,
  title,
  description,
  onClick,
  extra,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  onClick?: () => void;
  extra?: ReactNode;
}) {
  return (
    <button className={`list-row${icon ? '' : ' list-row-plain'}`} onClick={onClick}>
      {icon && <span className="row-icon">{icon}</span>}
      <span className="row-copy">
        <span>{title}</span>
        {description && <small>{description}</small>}
      </span>
      <span className="row-trailing">
        {extra}
        <ChevronRight size={16} className="text-disabled shrink-0" />
      </span>
    </button>
  );
}
