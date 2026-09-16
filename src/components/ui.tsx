'use client';
import { useLayoutEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, ArrowLeft, X, ChevronRight, Inbox } from '@/components/icons';
import { useJourneyLayer } from './journey';
import * as Dialog from '@radix-ui/react-dialog';

export function Button({
  variant = 'primary',
  size = 'default',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline';
  size?: 'default' | 'compact';
}) {
  return (
    <button
      className={`btn btn-${variant}${size === 'compact' ? ' btn-compact' : ''} ${className}`}
      {...props}
    >
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
    <button type="button" aria-label={label} className={`icon-button ${className}`} {...props}>
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
  description,
  children,
  fullScreen = false,
  adaptiveHeight = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  fullScreen?: boolean;
  adaptiveHeight?: boolean;
}) {
  const close = useJourneyLayer(open, onClose);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!surface || !adaptiveHeight || fullScreen) return;
    const body = surface.querySelector<HTMLElement>('.sheet-body');
    const content = surface.querySelector<HTMLElement>('.sheet-body-content');
    const heading = surface.querySelector<HTMLElement>('.sheet-heading');
    const handle = surface.querySelector<HTMLElement>('.sheet-handle');
    if (!body || !content || !heading || !handle) return;
    const outerHeight = (node: HTMLElement) => {
      const style = getComputedStyle(node);
      return (
        node.getBoundingClientRect().height +
        parseFloat(style.marginTop) +
        parseFloat(style.marginBottom)
      );
    };
    const measure = () => {
      const style = getComputedStyle(surface);
      const bodyStyle = getComputedStyle(body);
      // Measure natural content, not the clipped scroll viewport; CSS caps the sheet.
      setHeight(
        Math.ceil(
          parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom) +
            outerHeight(handle) +
            outerHeight(heading) +
            outerHeight(content) +
            parseFloat(bodyStyle.paddingTop) +
            parseFloat(bodyStyle.paddingBottom),
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    [content, heading, handle].forEach((node) => observer.observe(node));
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [surface, adaptiveHeight, fullScreen]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content
          ref={setSurface}
          style={adaptiveHeight && !fullScreen && surface ? { height } : undefined}
          onEscapeKeyDown={(event) => {
            // Collapse a date field before dismissing its containing form.
            const target = event.target;
            if (!(target instanceof Element)) return;
            const expandedDate = Array.from(
              target
                .closest('.sheet-content')
                ?.querySelectorAll<HTMLButtonElement>(
                  '[data-inline-date-trigger][aria-expanded="true"]',
                ) ?? [],
            ).find((button) => !button.closest('[hidden]'));
            if (expandedDate) {
              event.preventDefault();
              expandedDate.click();
              expandedDate.focus();
            }
          }}
          className={`sheet-content${fullScreen ? ' sheet-content-full' : ''}${adaptiveHeight && !fullScreen ? ' sheet-content-adaptive' : ''}`}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="sheet-handle" />
          <div className="sheet-heading">
            {description ? (
              <div className="sheet-heading-copy">
                <Dialog.Title>{title}</Dialog.Title>
                <Dialog.Description asChild>
                  <div>{description}</div>
                </Dialog.Description>
              </div>
            ) : (
              <Dialog.Title>{title}</Dialog.Title>
            )}
            <Dialog.Close asChild>
              <IconButton label="닫기" data-close-sheet>
                <X size={22} />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="sheet-body">
            {adaptiveHeight && !fullScreen ? (
              <div className="sheet-body-content">{children}</div>
            ) : (
              children
            )}
          </div>
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
  chevron = true,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  onClick?: () => void;
  extra?: ReactNode;
  /** A row whose trailing chip already names the action drops the chevron. */
  chevron?: boolean;
}) {
  const Element = onClick ? 'button' : 'div';
  return (
    <Element className={`list-row${icon ? '' : ' list-row-plain'}`} onClick={onClick}>
      {icon && <span className="row-icon">{icon}</span>}
      <span className="row-copy">
        <span>{title}</span>
        {description && <small>{description}</small>}
      </span>
      <span className="row-trailing">
        {extra}
        {onClick && chevron && <ChevronRight size={16} className="text-disabled shrink-0" />}
      </span>
    </Element>
  );
}
export function ErrorNote({ error }: { error?: string }) {
  return error ? (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-2xl bg-surface p-4 text-[14px] font-medium leading-relaxed"
    >
      <AlertCircle size={18} className="mt-0.5 shrink-0" />
      <span>{error}</span>
    </div>
  ) : null;
}
