// Pure helpers for the Analytics screen: chart axes, line paths, CSV export and duration labels.

/**
 * Evenly spaced "nice" axis ticks (steps of 1, 2 or 5 × 10ⁿ) covering [lo, hi]. An empty range
 * (e.g. every day had zero executions) still gets a usable 0…count axis instead of dividing by zero.
 */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (hi <= lo) hi = lo + count;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  // Rounding keeps float drift (0.1 + 0.2) out of the labels.
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return ticks;
}

/** Y-axis ticks for a pass-rate chart: ends at 100 and starts just below the lowest value or the target. */
export function passRateTicks(values: (number | null)[], target: number): number[] {
  const min = Math.min(target, ...values.filter((v): v is number => v !== null));
  return niceTicks(Math.max(0, min - 5), 100);
}

/** SVG path through the points, broken into separate segments wherever a value is missing. */
export function linePath(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${round(x(i))},${round(y(v))}`;
    pen = true;
  });
  return d;
}

const round = (n: number) => Math.round(n * 10) / 10;

type Cell = string | number | null | undefined;

/** RFC 4180 CSV. CRLF line endings so Excel opens it cleanly. */
export function toCsv(header: string[], rows: Cell[][]): string {
  const cell = (c: Cell) => {
    const s = c === null || c === undefined ? '' : String(c);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

/** "45m", "5h", "1d 6h" — used for the mean time to retest. */
export function hoursLabel(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  const h = Math.round(hours);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Percentage of `part` in `whole` for bar widths; 0 when there is nothing to divide. */
export const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
