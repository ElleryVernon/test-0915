'use client';

// Shared controls that replace the OS-native pickers: an option sheet (instead of <select>), a
// segmented choice, a checkbox, a numeric stepper and a slider. All are keyboard and screen-reader
// operable (roles, aria-* and focus return) and styled by globals.css (.choice-*).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Minus, Plus } from '@/components/icons';
import { clampStep, sliderKey, sliderPercent } from '@/lib/ui-logic';
import { Sheet } from '@/components/ui';

export type Option<T extends string = string> = {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
  icon?: ReactNode;
};

/**
 * A radio list drawn as rows (icon · label · description · radio dot). Used inline in a sheet or a
 * screen when the choices are few, and inside OptionField's sheet for longer lists. `collapse`
 * shows that many rows first with a "더 보기" row for the rest.
 */
export function OptionList<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
  collapse,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  name?: string;
  collapse?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = collapse && !expanded && options.length > collapse ? options.length - collapse : 0;
  const visible = hidden ? options.slice(0, collapse) : options;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="option-list"
      data-choice="list"
      data-choice-list={name ?? label}
      data-choice-value={value}
    >
      {visible.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          className="option-row"
          onClick={() => onChange(option.value)}
        >
          {option.icon && <span className="option-row-icon">{option.icon}</span>}
          <span className="option-row-copy">
            <span className="option-row-label">{option.label}</span>
            {option.description && (
              <span className="option-row-description">{option.description}</span>
            )}
          </span>
          <span className="option-radio" aria-hidden="true" />
        </button>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="option-row option-row-more"
          data-choice-more
          onClick={() => setExpanded(true)}
        >
          {hidden}개 더 보기
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** A field that opens a sheet of options; the current label is shown in the field. */
export function OptionField<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = '선택해 주세요',
  title,
  disabled = false,
  compact = false,
  className = '',
  name,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  /** A small inline trigger (list sorters) instead of a full-width field. */
  compact?: boolean;
  className?: string;
  /** Marks the trigger for tests and audits. */
  name?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);
  const close = () => {
    setOpen(false);
    // Focus returns to the control that opened the sheet.
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={compact ? `${label}: ${current?.label ?? placeholder}` : undefined}
        disabled={disabled}
        data-choice="option"
        data-choice-name={name ?? label}
        data-choice-value={value}
        className={`${compact ? 'choice-compact' : 'field choice-field'} ${className}`}
        onClick={() => setOpen(true)}
      >
        <span className={current ? 'choice-field-value' : 'choice-field-placeholder'}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={compact ? 14 : 18} aria-hidden="true" />
      </button>
      <Sheet open={open} onClose={close} title={title ?? label}>
        <OptionList
          label={title ?? label}
          name={name ?? label}
          value={value}
          options={options}
          onChange={(next) => {
            onChange(next);
            close();
          }}
        />
      </Sheet>
    </>
  );
}

/** Two to four choices shown side by side (sort orders, small enums). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  name?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="segmented"
      data-choice="segmented"
      data-choice-name={name ?? label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          className={option.value === value ? 'is-active' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A checkbox drawn by the app; the label is the click target. */
export function Checkbox({
  checked,
  onChange,
  children,
  disabled = false,
  name,
  className = '',
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  name?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-labelledby={id}
      disabled={disabled}
      data-choice="checkbox"
      data-choice-name={name}
      className={`choice-checkbox ${className}`}
      onClick={() => onChange(!checked)}
    >
      <span className="choice-checkbox-box" aria-hidden="true">
        {checked && <Check size={14} />}
      </span>
      <span id={id} className="choice-checkbox-label">
        {children}
      </span>
    </button>
  );
}

/** A binary setting. The whole row is one keyboard-operable target, with a trailing switch. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  name,
  className = '',
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  name?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-label`}
      aria-describedby={description ? `${id}-description` : undefined}
      disabled={disabled}
      data-choice="switch"
      data-choice-name={name ?? label}
      className={`choice-switch ${className}`}
      onClick={() => onChange(!checked)}
    >
      <span className="choice-switch-copy">
        <span id={`${id}-label`} className="choice-switch-label">
          {label}
        </span>
        {description && (
          <span id={`${id}-description`} className="choice-switch-description">
            {description}
          </span>
        )}
      </span>
      <span className="choice-switch-track" aria-hidden="true">
        <span className="choice-switch-thumb" />
      </span>
    </button>
  );
}

/** A number with − and + buttons (moving by `step`) and a typed value (any amount within [min, max]). */
export function Stepper({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  unit = '',
  name,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  unit?: string;
  name?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  // Buttons move on the step grid; a typed amount is taken as it is, only kept inside the range.
  const commit = (next: number) => onChange(clampStep(next, { min, max, step }));
  const type = (next: number) =>
    onChange(Number.isFinite(next) ? Math.min(max, Math.max(min, Math.round(next))) : min);
  return (
    <div
      className="choice-stepper"
      role="group"
      aria-label={label}
      data-choice="stepper"
      data-choice-name={name ?? label}
    >
      <button
        type="button"
        aria-label={`${label} 줄이기`}
        disabled={value <= min}
        onClick={() => commit(value - step)}
      >
        <Minus size={18} />
      </button>
      <input
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.-]/g, ''))}
        onBlur={() => type(Number(draft))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') type(Number(draft));
          if (e.key === 'ArrowUp') commit(value + step);
          if (e.key === 'ArrowDown') commit(value - step);
        }}
      />
      {unit && <span className="choice-stepper-unit">{unit}</span>}
      <button
        type="button"
        aria-label={`${label} 늘리기`}
        disabled={value >= max}
        onClick={() => commit(value + step)}
      >
        <Plus size={18} />
      </button>
    </div>
  );
}

/** A slider drawn by the app: drag or tap the track, arrow keys step, Home/End jump. */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v: number) => String(v),
  name,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  name?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const percent = sliderPercent(value, min, max);
  const fromPointer = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onChange(clampStep(min + ratio * (max - min), { min, max, step }));
  };
  return (
    <div
      ref={track}
      className="choice-slider"
      data-choice="slider"
      data-choice-name={name ?? label}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        fromPointer(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) fromPointer(e.clientX);
      }}
    >
      <div className="choice-slider-fill" style={{ width: `${percent}%` }} aria-hidden="true" />
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        className="choice-slider-thumb"
        style={{ left: `${percent}%` }}
        onKeyDown={(e) => {
          const next = sliderKey(value, e.key, { min, max, step });
          if (next !== value) {
            e.preventDefault();
            onChange(next);
          }
        }}
      />
    </div>
  );
}

/** Inline validation text next to a field (forms use noValidate and show this instead of the bubble). */
export function FieldMessage({ message, id }: { message: string; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="choice-field-message" data-field-message>
      {message}
    </p>
  );
}
