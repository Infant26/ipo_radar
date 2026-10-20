"use client";

import { useEffect, useRef } from "react";
import { animate, motion, useReducedMotion } from "motion/react";

/** Ease-out-expo: fast start, soft landing. Used for every entrance on the page. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
/** Spring with no overshoot, for things that move between positions. */
export const SPRING = { type: "spring", stiffness: 420, damping: 40, mass: 0.9 } as const;

/**
 * Number that animates from `from` (default 0) to `value`. Writes straight to
 * the DOM node so it never re-renders React on each frame.
 */
export function CountUp({
  value,
  from,
  format,
  duration = 0.9,
  className,
}: {
  value: number;
  from?: number;
  format: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const start = from ?? 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce || start === value) {
      el.textContent = format(value);
      return;
    }
    const controls = animate(start, value, {
      duration,
      ease: EASE_OUT,
      onUpdate: (v) => (el.textContent = format(v)),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, start, reduce]);

  return (
    <span ref={ref} className={className}>
      {format(reduce ? value : start)}
    </span>
  );
}

/** Circular gauge for a 0–100 score; the arc draws in on mount and when the score changes. */
export function Ring({
  value,
  size = 40,
  stroke = 4,
  color,
  track = "var(--ring-track)",
  delay = 0,
  children,
  label,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  color: string;
  track?: string;
  delay?: number;
  children?: React.ReactNode;
  label?: string;
}) {
  const reduce = useReducedMotion();
  const r = (size - stroke) / 2;
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <span className="ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        {value !== null && (
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="100 100"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            initial={reduce ? false : { strokeDashoffset: 100 }}
            animate={{ strokeDashoffset: 100 - v }}
            transition={{ duration: 1.1, delay, ease: EASE_OUT }}
          />
        )}
      </svg>
      {children !== undefined && <span className="ring-val">{children}</span>}
    </span>
  );
}

/** Segmented control with a selection pill that slides between options. */
export function Seg<T extends string>({
  id,
  value,
  options,
  onChange,
  label,
  size = "md",
  accent,
}: {
  id: string;
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  size?: "md" | "sm";
  /** CSS colour for the pill; defaults to the panel colour */
  accent?: string;
}) {
  return (
    <div className={`seg ${size}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            className={on ? "on" : ""}
            aria-pressed={on}
            onClick={() => onChange(o.value)}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                className="seg-pill"
                style={accent ? { background: accent } : undefined}
                transition={SPRING}
              />
            )}
            <span className="seg-text">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
