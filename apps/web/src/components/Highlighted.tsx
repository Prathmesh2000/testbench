/**
 * Splits search-engine highlight text, where matches are wrapped in <mark>…</mark>, into plain and
 * matched pieces. The text is user-written case content, so it is never injected as HTML.
 */
export function splitMarks(text: string): { text: string; match: boolean }[] {
  return text
    .split(/(<mark>.*?<\/mark>)/g)
    .filter(Boolean)
    .map((part) => (part.startsWith('<mark>') ? { text: part.slice(6, -7), match: true } : { text: part, match: false }));
}

export function Highlighted({ text }: { text: string }) {
  return (
    <>
      {splitMarks(text).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}
