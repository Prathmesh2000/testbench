import type { AdfDoc, AdfNode } from '@tb/defect';
import type { HistoryDetail } from '@tb/contracts';

// A Jira bug from a failed API call (plan §15): the request and response as the history stored them,
// which is already masked, so no secret reaches Jira.

const CUT = 6000;
const para = (label: string, value: string): AdfNode => ({ type: 'paragraph', content: [{ type: 'text', text: label, marks: [{ type: 'strong' }] }, { type: 'text', text: value }] });
const code = (text: string, language = 'json'): AdfNode => ({ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: text.length > CUT ? `${text.slice(0, CUT)}\n… (cut)` : text || '(empty)' }] });
const heading = (t: string): AdfNode => ({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: t }] });
const pretty = (body: string) => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

export function apiBugDescription(h: HistoryDetail, ctx: { note: string; found: string; link: string; failures: string[] }): AdfDoc {
  const content: AdfNode[] = [
    para('Found by: ', ctx.found),
    para('Request: ', `${h.method} ${h.url}`),
    para('Result: ', h.status === null ? `no response (${h.error ?? 'unknown error'})` : `status ${h.status} in ${h.durationMs} ms`),
  ];
  if (ctx.failures.length) content.push(heading('What failed'), { type: 'bulletList', content: ctx.failures.map((f) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: f }] }] })) });
  if (ctx.note.trim()) content.push(heading('Notes'), { type: 'paragraph', content: [{ type: 'text', text: ctx.note.trim() }] });
  content.push(heading('Request'), code(h.request.headers.map(([k, v]) => `${k}: ${v}`).join('\n'), 'http'));
  if (h.request.body) content.push(code(pretty(h.request.body)));
  if (h.response) {
    content.push(heading(`Response ${h.response.status} ${h.response.statusText}`), code(h.response.headers.map(([k, v]) => `${k}: ${v}`).join('\n'), 'http'));
    if (h.response.bodyEncoding === 'utf8') content.push(code(pretty(h.response.body)));
  }
  content.push(para('In Testbench: ', ctx.link));
  return { type: 'doc', version: 1, content };
}
