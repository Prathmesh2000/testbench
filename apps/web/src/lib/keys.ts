// Keyboard behaviour as pure functions, so the rules can be tested without a browser.

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** True when a keystroke belongs to a text field, where single-letter shortcuts must not fire. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false;
  const node = el as HTMLElement;
  return node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName);
}

export type GlobalAction =
  | { type: 'palette' }
  | { type: 'shortcuts' }
  | { type: 'search' }
  | { type: 'go'; to: string }
  | { type: 'pending-g' };

const GO_TARGETS: Record<string, string> = { h: '/', c: '/cases', r: '/runs', n: '/runs/new' };

/**
 * App-wide shortcuts. `pendingG` is true right after the user pressed "g", which starts a two-key
 * navigation chord such as "g c" (go to cases).
 */
export function globalAction(e: KeyLike, typing: boolean, pendingG: boolean): GlobalAction | null {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return { type: 'palette' };
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (pendingG) {
    const to = GO_TARGETS[e.key.toLowerCase()];
    return to ? { type: 'go', to } : null;
  }
  if (e.key === '?') return { type: 'shortcuts' };
  if (e.key === '/') return { type: 'search' };
  if (e.key === 'g') return { type: 'pending-g' };
  return null;
}

export type ExecuteAction =
  | { type: 'mark'; status: 'passed' | 'failed' | 'blocked' | 'skipped' }
  | { type: 'pass-all' }
  | { type: 'step'; delta: 1 | -1 }
  | { type: 'item'; delta: 1 | -1 }
  | { type: 'log-bug' };

/** Shortcuts in the execute view (HLD §5.2 and the canvas shortcut sheet). */
export function executeAction(e: KeyLike, typing: boolean): ExecuteAction | null {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') return { type: 'log-bug' };
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.shiftKey && e.key.toLowerCase() === 'p') return { type: 'pass-all' };
  switch (e.key) {
    case 'p': return { type: 'mark', status: 'passed' };
    case 'f': return { type: 'mark', status: 'failed' };
    case 'b': return { type: 'mark', status: 'blocked' };
    case 's': return { type: 'mark', status: 'skipped' };
    case 'ArrowDown': return { type: 'step', delta: 1 };
    case 'ArrowUp': return { type: 'step', delta: -1 };
    case 'j': case 'n': return { type: 'item', delta: 1 };
    case 'k': return { type: 'item', delta: -1 };
    default: return null;
  }
}

/**
 * Moves the focused row in a list that mixes data rows with group headers, skipping headers and
 * collapsed rows. Returns the new index, or the old one when there is nowhere to go.
 */
export function moveFocus(current: number, delta: 1 | -1, isSelectable: (index: number) => boolean, count: number): number {
  for (let i = current + delta; i >= 0 && i < count; i += delta) {
    if (isSelectable(i)) return i;
  }
  return current;
}
