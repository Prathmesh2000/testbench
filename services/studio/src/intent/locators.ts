import type { Locator, PickedElement } from '@tb/contracts';

/**
 * How the tester's words shape locators. By default a test finds each element by what it is (test id,
 * role and name, label), never by where it sits, because position changes with the data. Positional
 * ("the first result", "row 3") and referential ("the price next to Dell XPS", "in the row for…")
 * locators are used only when the intent talks that way; and a button or form field is never found by
 * position unless the intent asks for exactly that ("click the second Add button").
 */
export interface LocatorPolicy {
  positional: boolean;
  referential: boolean;
  /** The intent names a position for a control itself, not just for content. */
  positionalControls: boolean;
}

const POSITIONAL = /\b(first|second|third|fourth|fifth|last|top|bottom|\d+(st|nd|rd|th)|nth|position)\b/i;
const REFERENTIAL = /\b(next to|beside|below|above|under|near|in the (row|card|item|list|section|table)|for the|that (says|shows|contains)|with the (name|title|text|label))\b/i;
const CONTROL_WORD = /\b(button|link|field|input|box|checkbox|option|dropdown|tab|menu item)s?\b/i;

/** For checks: they are about what the page shows, which must not depend on where it sits. */
export const CHECK_POLICY: LocatorPolicy = { positional: false, referential: false, positionalControls: false };

export function policyFor(text: string): LocatorPolicy {
  const positional = POSITIONAL.test(text);
  // "the second Add button": a position and a control named in the same phrase.
  const positionalControls = positional && new RegExp(`${POSITIONAL.source}\\s+(\\w+\\s+){0,3}${CONTROL_WORD.source}`, 'i').test(text);
  return { positional, referential: REFERENTIAL.test(text), positionalControls };
}

const CONTROL_ROLES = /^(button|textbox|searchbox|combobox|checkbox|radio|switch|slider|spinbutton|listbox)$/;

/**
 * Buttons and form fields: never found by position unless the intent asks for exactly that. Links,
 * options and list items are content in a list, where "the first result" is a fair way to say which.
 */
export function isControl(el: PickedElement): boolean {
  return /^(button|input|select|textarea)$/.test(el.tag) || CONTROL_ROLES.test(el.role ?? '');
}

type Candidate = PickedElement['locators'][number];

/**
 * The locator a step should use under the policy, best first:
 * 1. unique and stable, not scoped (scoped first instead when the intent is referential);
 * 2. by position, when the intent names one for this kind of element (then position is the point);
 * 3. unique and stable, scoped to its container ("the Add button in the Dell XPS row");
 * 4. unique but data-dependent;
 * 5. by position, where allowed at all; then anything left (a structural CSS path).
 * Only ambiguous elements have positional candidates, so a unique search box is never affected.
 */
export function chooseLocator(el: PickedElement, policy: LocatorPolicy): Locator | null {
  const control = isControl(el);
  const positionAsked = control ? policy.positionalControls : policy.positional;
  const allowed = (c: Candidate) => c.nth === undefined || positionAsked || (!control && policy.referential);
  const pool = el.locators.filter(allowed);
  const unique = (c: Candidate) => c.matches === 1 && c.nth === undefined;
  const scoped = (c: Candidate) => !!c.within;
  const byPosition = (c: Candidate) => c.nth !== undefined;
  const tiers: Array<(c: Candidate) => boolean> = [
    // "The first result": for an item in a list, its place in that list is what the tester means.
    (c) => positionAsked && !control && byPosition(c) && !!c.within,
    policy.referential ? (c) => unique(c) && scoped(c) && c.stable : (c) => unique(c) && !scoped(c) && c.stable && c.strategy !== 'css',
    (c) => positionAsked && byPosition(c),
    (c) => unique(c) && c.stable && c.strategy !== 'css',
    (c) => unique(c) && c.stable,
    (c) => unique(c),
    byPosition,
    () => true,
  ];
  for (const tier of tiers) {
    const hit = pool.find(tier);
    if (hit) return strip(hit);
  }
  return el.locators[0] ? strip(el.locators[0]) : null;
}

function strip(c: Candidate): Locator {
  return {
    strategy: c.strategy,
    value: c.value,
    ...(c.name ? { name: c.name } : {}),
    ...(c.within ? { within: c.within } : {}),
    ...(c.nth === undefined ? {} : { nth: c.nth }),
  };
}
