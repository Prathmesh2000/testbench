import type { UiReviewBody } from '@tb/contracts';
import { maskText } from '@tb/platform';

/**
 * A UI review as it may go to a model: everything the page showed or the tester typed, masked. The
 * web app sends page text as the tester saw it (names, headings, the URL), which can hold an email, a
 * phone number or a token in a query string.
 */
export function maskedReview(body: UiReviewBody): UiReviewBody {
  return {
    ...body,
    url: maskText(body.url),
    title: maskText(body.title),
    focus: maskText(body.focus),
    issues: body.issues.map((i) => ({ ...i, example: maskText(i.example) })),
    sample: body.sample.map((s) => ({ ...s, element: maskText(s.element) })),
    findings: body.findings.map((f) => ({ title: maskText(f.title), note: maskText(f.note), element: maskText(f.element) })),
  };
}
