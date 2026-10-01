import { describe, expect, it } from 'vitest';
import { apiBugDescription } from './bug';

describe('apiBugDescription', () => {
  it('puts the request, the response and what failed into the bug, cutting long bodies', () => {
    const doc = apiBugDescription(
      {
        id: 'h',
        nodeId: null,
        method: 'POST',
        url: 'https://api.test/orders',
        status: 500,
        durationMs: 40,
        error: null,
        createdAt: '',
        request: { headers: [['Authorization', 'Bearer ••••••']], body: '{"qty":2}' },
        response: { status: 500, statusText: 'Server Error', headers: [['content-type', 'application/json']], body: 'x'.repeat(7000), bodyEncoding: 'utf8', contentType: 'application/json', sizeBytes: 7000, truncated: false },
      },
      { note: 'Started after the 2.3 deploy', found: 'suite Smoke, run 12', link: 'https://tb.test/api', failures: ['status is 201, but it is 500'] },
    );
    const text = JSON.stringify(doc);
    expect(text).toContain('POST https://api.test/orders');
    expect(text).toContain('status is 201, but it is 500');
    expect(text).toContain('Bearer ••••••');
    expect(text).toContain('(cut)');
    expect(doc.content.some((n) => n.type === 'codeBlock')).toBe(true);
  });
});
