// Code that makes the same request in other tools and languages (plan §4), from the resolved request
// with secrets already replaced, so a snippet can be pasted into a ticket or chat safely.

import type { SNIPPET_LANGS } from '@tb/contracts';

export type SnippetLanguage = (typeof SNIPPET_LANGS)[number];

export interface SnippetRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const js = (s: string) => JSON.stringify(s);

export function snippet(lang: SnippetLanguage, r: SnippetRequest): string {
  switch (lang) {
    case 'curl':
      return [
        `curl -X ${r.method} ${sh(r.url)}`,
        ...r.headers.map(([k, v]) => `  -H ${sh(`${k}: ${v}`)}`),
        ...(r.body !== null ? [`  --data-raw ${sh(r.body)}`] : []),
      ].join(' \\\n');
    case 'fetch': {
      const opts = [
        `  method: ${js(r.method)},`,
        r.headers.length ? `  headers: {\n${r.headers.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n  },` : null,
        r.body !== null ? `  body: ${js(r.body)},` : null,
      ].filter(Boolean);
      return `const res = await fetch(${js(r.url)}, {\n${opts.join('\n')}\n});\nconsole.log(res.status, await res.text());`;
    }
    case 'python': {
      const lines = ['import requests', '', `response = requests.request(`, `    ${js(r.method)},`, `    ${js(r.url)},`];
      if (r.headers.length) lines.push(`    headers={\n${r.headers.map(([k, v]) => `        ${js(k)}: ${js(v)},`).join('\n')}\n    },`);
      if (r.body !== null) lines.push(`    data=${js(r.body)}.encode("utf-8"),`);
      lines.push(')', 'print(response.status_code, response.text)');
      return lines.join('\n');
    }
    case 'go': {
      const body = r.body !== null ? `strings.NewReader(${js(r.body)})` : 'nil';
      return [
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"io"',
        '\t"net/http"',
        ...(r.body !== null ? ['\t"strings"'] : []),
        ')',
        '',
        'func main() {',
        `\treq, _ := http.NewRequest(${js(r.method)}, ${js(r.url)}, ${body})`,
        ...r.headers.map(([k, v]) => `\treq.Header.Set(${js(k)}, ${js(v)})`),
        '\tres, err := http.DefaultClient.Do(req)',
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tdefer res.Body.Close()',
        '\tb, _ := io.ReadAll(res.Body)',
        '\tfmt.Println(res.StatusCode, string(b))',
        '}',
      ].join('\n');
    }
    case 'java': {
      const pub = r.body !== null ? `HttpRequest.BodyPublishers.ofString(${js(r.body)})` : 'HttpRequest.BodyPublishers.noBody()';
      return [
        'import java.net.URI;',
        'import java.net.http.*;',
        '',
        'var request = HttpRequest.newBuilder()',
        `    .uri(URI.create(${js(r.url)}))`,
        // HttpClient refuses to let callers set a few restricted headers; they are left to it.
        ...r.headers.filter(([k]) => !['host', 'content-length', 'connection'].includes(k.toLowerCase())).map(([k, v]) => `    .header(${js(k)}, ${js(v)})`),
        `    .method(${js(r.method)}, ${pub})`,
        '    .build();',
        'var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());',
        'System.out.println(response.statusCode() + " " + response.body());',
      ].join('\n');
    }
    case 'csharp': {
      const contentType = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
      const lines = [
        'using var client = new HttpClient();',
        `var request = new HttpRequestMessage(new HttpMethod(${js(r.method)}), ${js(r.url)});`,
        ...r.headers.filter(([k]) => k.toLowerCase() !== 'content-type').map(([k, v]) => `request.Headers.TryAddWithoutValidation(${js(k)}, ${js(v)});`),
      ];
      if (r.body !== null)
        lines.push(`request.Content = new StringContent(${js(r.body)}, System.Text.Encoding.UTF8${contentType ? `, ${js(contentType.split(';')[0]!.trim())}` : ''});`);
      lines.push('var response = await client.SendAsync(request);', 'Console.WriteLine($"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");');
      return lines.join('\n');
    }
  }
}
