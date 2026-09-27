// Stroke icons on a 16px grid, matching the canvas. Colour follows `currentColor`.

const PATHS = {
  home: 'M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5h-3v-4H6v4H3a.5.5 0 0 1-.5-.5z',
  cases: 'M6.5 4h7M6.5 8h7M6.5 12h7M2.5 4l1 1 1.5-2M2.5 8l1 1 1.5-2M2.5 12l1 1 1.5-2',
  runs: 'M2.5 4h7M2.5 8h5M2.5 12h4M10.5 9l4 2.5-4 2.5z',
  play: 'M4.5 2.5v11l9-5.5z',
  bug: 'M5.5 7a2.5 2.5 0 0 1 5 0v3a2.5 2.5 0 0 1-5 0zM8 7.5v5M2.5 8.5h3M10.5 8.5h3M3 5l2.5 1.5M13 5l-2.5 1.5M3 13l2.5-1.5M13 13l-2.5-1.5M6.5 4.5l-.8-2M9.5 4.5l.8-2',
  search: 'M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM14 14l-3-3',
  chart: 'M3 13.5V8M8 13.5V3M13 13.5V9.5M1.5 13.5h13',
  doc: 'M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M6 8h5M6 11h5',
  board: 'M2 3h12v10H2zM2 6h12M6 6v7',
  calendar: 'M2 3.5h12v10H2zM2 7h12M5 2v3M11 2v3',
  bell: 'M4 11V7.5a4 4 0 0 1 8 0V11l1.5 1.5h-11zM6.5 14h3',
  gear: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  shield: 'M8 1.5 13.5 3.5v4c0 3.5-2.5 5.8-5.5 7-3-1.2-5.5-3.5-5.5-7v-4z',
  sun: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1',
  moon: 'M13.5 9.5A6 6 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z',
  rows: 'M2 3.5h12M2 8h12M2 12.5h12',
  plus: 'M8 3v10M3 8h10',
  chevDown: 'M4 6l4 4 4-4',
  chevRight: 'M6 4l4 4-4 4',
  chevLeft: 'M10 4 6 8l4 4',
  check: 'M3 8.5 6.5 12 13 4.5',
  x: 'M4 4l8 8M12 4l-8 8',
  blocked: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM3.8 3.8l8.4 8.4',
  skip: 'M3.5 3.5 10 8l-6.5 4.5zM12.5 3.5v9',
  circle: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  clock: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 4.5V8l2.5 1.5',
  link: 'M7 9a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7M9 7a2.8 2.8 0 0 0-4 0L3 9a2.8 2.8 0 0 0 4 4l.7-.7',
  keyboard: 'M1.5 4h13v8h-13zM4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6',
  menu: 'M2 4h12M2 8h12M2 12h12',
  paperclip: 'M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3L6.5 11a1.2 1.2 0 0 1-1.7-1.7L10 4',
  refresh: 'M13.5 7.5A5.5 5.5 0 0 0 3.5 5M2.5 2.5v3h3M2.5 8.5A5.5 5.5 0 0 0 12.5 11M13.5 13.5v-3h-3',
  flag: 'M3.5 14.5v-12M3.5 2.5h8l-1.5 3 1.5 3h-8',
  alert: 'M8 1.5 15 14H1zM8 6v4M8 12h.01',
  info: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 7.5v4M8 5h.01',
  filter: 'M2 3h12L9.5 8.5v4.5l-3 1.5v-6z',
  columns: 'M2 3h12v10H2zM6 3v10M10 3v10',
  group: 'M2 3h5v3H2zM2 10h5v3H2zM9 4.5h5M9 11.5h5',
  signout: 'M6 14H3V2h3M10.5 11 13.5 8l-3-3M13.5 8H6',
  pause: 'M5 3v10M11 3v10',
  arrowRight: 'M3 8h10M9 4l4 4-4 4',
  edit: 'M11 2.5 13.5 5 6 12.5H3.5V10z',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5V5H5M8 5v3l2 1.5',
  tree: 'M3 2.5h4v3H3zM9 10.5h4v3H9zM9 2.5h4v3H9zM5 5.5v6.5h4M7 4h2',
  plug: 'M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`i ${className}`} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
