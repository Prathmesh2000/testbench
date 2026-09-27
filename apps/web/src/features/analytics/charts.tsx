import type { ResultCounts } from '@tb/contracts';
import { useEffect, useRef, useState } from 'react';
import { fmt } from '@/lib/format';
import { linePath, niceTicks, passRateTicks } from './analytics-utils';
import s from './analytics.module.css';

type Day = { day: string } & ResultCounts;

const H = 190;
const M = { top: 8, right: 8, bottom: 20, left: 38 };
const PH = H - M.top - M.bottom;

const total = (d: ResultCounts) => d.passed + d.failed + d.blocked + d.skipped;
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Tracks the rendered width so charts draw in real pixels. A scaled viewBox would also scale the
 * axis text, making the two Overview charts (different panel widths) use different font sizes.
 */
function useWidth() {
  const ref = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(200, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Shared frame: horizontal grid lines with y labels, and day labels spaced to fit the width. */
function Axes({ days, width, ticks, y, unit = '' }: { days: Day[]; width: number; ticks: number[]; y(v: number): number; unit?: string }) {
  const slot = (width - M.left - M.right) / Math.max(1, days.length);
  const every = Math.max(1, Math.ceil(48 / slot));
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line className={s.gl} x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />
          <text className={s.ax} x={M.left - 6} y={y(t) + 3} textAnchor="end">{fmt(t)}{unit}</text>
        </g>
      ))}
      {days.map((d, i) => (i % every === 0 ? (
        <text key={d.day} className={s.ax} x={M.left + slot * (i + 0.5)} y={H - 5} textAnchor="middle">{dayLabel(d.day)}</text>
      ) : null))}
    </>
  );
}

/** Daily pass rate as a line (gaps on days with no executions) against a dashed target line. */
export function PassRateChart({ days, target = 95 }: { days: Day[]; target?: number }) {
  const [ref, width] = useWidth();
  const rates = days.map((d) => (total(d) ? (d.passed / total(d)) * 100 : null));
  const ticks = passRateTicks(rates, target);
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const y = (v: number) => M.top + PH - ((v - lo) / (hi - lo)) * PH;
  const x = (i: number) => M.left + ((width - M.left - M.right) / Math.max(1, days.length)) * (i + 0.5);
  const known = rates.filter((r): r is number => r !== null);
  const summary = known.length
    ? `Daily pass rate over ${days.length} days, from ${Math.min(...known).toFixed(1)}% to ${Math.max(...known).toFixed(1)}%, against a ${target}% target`
    : `No executions in the last ${days.length} days`;

  return (
    <svg ref={ref} className={s.chart} width="100%" height={H} role="img" aria-label={summary}>
      <Axes days={days} width={width} ticks={ticks} y={y} unit="%" />
      <line className={s.tgt} x1={M.left} x2={width - M.right} y1={y(target)} y2={y(target)} />
      <path className={s.ln} d={linePath(rates, x, y)} />
      {/* Dots make single-day segments visible; the line alone would draw nothing for them. */}
      {rates.map((r, i) => r !== null && (
        <circle key={days[i]!.day} className={s.pt} cx={x(i)} cy={y(r)} r={2.5}>
          <title>{`${dayLabel(days[i]!.day)}: ${r.toFixed(1)}% of ${fmt(total(days[i]!))}`}</title>
        </circle>
      ))}
      {!known.length && <text className={s.ax} x={width / 2} y={M.top + PH / 2} textAnchor="middle">No executions yet</text>}
    </svg>
  );
}

const STACK = [
  ['passed', s.fPassed],
  ['failed', s.fFailed],
  ['blocked', s.fBlocked],
  ['skipped', s.fSkipped],
] as const;

/** Executions per day, stacked passed → failed → blocked → skipped from the baseline up. */
export function ExecutionsChart({ days }: { days: Day[] }) {
  const [ref, width] = useWidth();
  const ticks = niceTicks(0, Math.max(0, ...days.map(total)));
  const hi = ticks[ticks.length - 1]!;
  const y = (v: number) => M.top + PH - (v / hi) * PH;
  const slot = (width - M.left - M.right) / Math.max(1, days.length);
  const sum = (k: keyof ResultCounts) => days.reduce((n, d) => n + d[k], 0);
  const summary = `${fmt(days.reduce((n, d) => n + total(d), 0))} executions over ${days.length} days: ${fmt(sum('passed'))} passed, ${fmt(sum('failed'))} failed, ${fmt(sum('blocked'))} blocked, ${fmt(sum('skipped'))} skipped`;

  return (
    <svg ref={ref} className={s.chart} width="100%" height={H} role="img" aria-label={summary}>
      <Axes days={days} width={width} ticks={ticks} y={y} />
      {days.map((d, i) => {
        let base = 0;
        return (
          <g key={d.day} className={s.bar}>
            <title>{`${dayLabel(d.day)}: ${d.passed} passed, ${d.failed} failed, ${d.blocked} blocked, ${d.skipped} skipped`}</title>
            {STACK.map(([k, cls]) => {
              const from = base;
              base += d[k];
              return d[k] ? <rect key={k} className={cls} x={M.left + slot * i + slot * 0.15} width={slot * 0.7} y={y(base)} height={y(from) - y(base)} /> : null;
            })}
          </g>
        );
      })}
    </svg>
  );
}
