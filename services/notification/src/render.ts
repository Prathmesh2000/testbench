// Template rendering: `{{name}}` placeholders filled from the event data. Deliberately not a template
// language (no logic, no includes): templates are edited by admins in the UI, and a logic-free
// syntax means a template can never run code or read anything the event did not carry.

export type Escape = 'none' | 'html' | 'slack';

const ESCAPES: Record<Escape, (s: string) => string> = {
  none: (s) => s,
  html: (s) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    ),
  // Slack mrkdwn treats &, < and > as control characters (links and mentions).
  slack: (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!),
};

/**
 * Fills placeholders; unknown ones render as empty rather than leaking "{{x}}" to a recipient.
 * Values are escaped for the destination, the template text itself is not (admins write it).
 */
export function render(template: string, data: Record<string, unknown>, escape: Escape = 'none'): string {
  return template.replace(/\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g, (_m, key: string) => {
    const value = data[key];
    return value === undefined || value === null ? '' : ESCAPES[escape](String(value));
  });
}

/** Placeholders a template uses, so the editor can warn about ones the event never provides. */
export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g)].map((m) => m[1]!))];
}
