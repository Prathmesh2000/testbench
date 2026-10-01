import { ApiRequestDef, HTTP_METHODS, type ApiBody, type HttpMethod, type KeyValue } from '@tb/contracts';
import { ImportError } from './postman';

// A pasted cURL command (as "Copy as cURL" in browser dev tools produces it) as a request (plan §4).

/** Splits a shell command line the way sh would for the quoting cURL commands use. */
export function shellWords(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new ImportError('The command has an unclosed single quote.');
      cur += text.slice(i + 1, end);
      i = end;
      has = true;
    } else if (c === '$' && text[i + 1] === "'") {
      // Bash ANSI-C quoting, which Chrome uses for bodies with special characters.
      let j = i + 2;
      for (; j < text.length && text[j] !== "'"; j++) {
        if (text[j] === '\\' && j + 1 < text.length) {
          const n = text[++j]!;
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        } else cur += text[j];
      }
      i = j;
      has = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && ['"', '\\', '$', '`'].includes(text[j + 1] ?? '')) cur += text[++j];
        else cur += text[j];
      }
      if (j >= text.length) throw new ImportError('The command has an unclosed double quote.');
      i = j;
      has = true;
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const WITH_VALUE = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '-u', '--user', '-b', '--cookie', '-F', '--form', '--url', '-A', '--user-agent', '-e', '--referer', '-o', '--output', '-m', '--max-time', '--connect-timeout']);

export function fromCurl(command: string): { name: string; request: ApiRequestDef; warnings: string[] } {
  const words = shellWords(command.trim());
  if (words[0] !== 'curl') throw new ImportError('Paste a command that starts with curl.');
  const warnings: string[] = [];
  const headers: KeyValue[] = [];
  const data: string[] = [];
  const form: KeyValue[] = [];
  let method: string | null = null;
  let url = '';
  let json = false;
  let get = false;
  let auth: ApiRequestDef['auth'] = { type: 'none' };
  let timeoutMs: number | null = null;

  for (let i = 1; i < words.length; i++) {
    let w = words[i]!;
    let value: string | undefined;
    // --header=value and -XPOST forms.
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    if (eq > 0 && WITH_VALUE.has(w.slice(0, eq))) {
      value = w.slice(eq + 1);
      w = w.slice(0, eq);
    } else if (/^-[XHdubFAem]./.test(w) && !w.startsWith('--')) {
      value = w.slice(2);
      w = w.slice(0, 2);
    } else if (WITH_VALUE.has(w)) value = words[++i];
    if (WITH_VALUE.has(w) && value === undefined) throw new ImportError(`${w} needs a value.`);

    switch (w) {
      case '-X':
      case '--request':
        method = value!.toUpperCase();
        break;
      case '-H':
      case '--header': {
        const at = value!.indexOf(':');
        if (at > 0) headers.push({ key: value!.slice(0, at).trim(), value: value!.slice(at + 1).trim(), enabled: true });
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
        if (value!.startsWith('@') && w !== '--data-raw') warnings.push(`The body is read from a file (${value}), which cannot be imported; paste the body instead.`);
        else data.push(value!);
        break;
      case '--data-urlencode': {
        const at = value!.indexOf('=');
        data.push(at >= 0 ? `${value!.slice(0, at)}=${encodeURIComponent(value!.slice(at + 1))}` : encodeURIComponent(value!));
        break;
      }
      case '--json':
        json = true;
        data.push(value!);
        break;
      case '-F':
      case '--form': {
        const at = value!.indexOf('=');
        if (value!.slice(at + 1).startsWith('@')) warnings.push(`The file field ${value!.slice(0, at)} cannot be imported and was left out.`);
        else form.push({ key: value!.slice(0, at), value: value!.slice(at + 1), enabled: true });
        break;
      }
      case '-u':
      case '--user': {
        const at = value!.indexOf(':');
        auth = { type: 'basic', username: at >= 0 ? value!.slice(0, at) : value!, password: at >= 0 ? value!.slice(at + 1) : '' };
        break;
      }
      case '-b':
      case '--cookie':
        if (value!.includes('=')) headers.push({ key: 'Cookie', value: value!, enabled: true });
        else warnings.push('Cookies read from a file cannot be imported.');
        break;
      case '-A':
      case '--user-agent':
        headers.push({ key: 'User-Agent', value: value!, enabled: true });
        break;
      case '-e':
      case '--referer':
        headers.push({ key: 'Referer', value: value!, enabled: true });
        break;
      case '--url':
        url = value!;
        break;
      case '-m':
      case '--max-time':
        timeoutMs = Math.min(120_000, Math.max(100, Math.round(Number(value) * 1000) || 30_000));
        break;
      case '-G':
      case '--get':
        get = true;
        break;
      case '-I':
      case '--head':
        method = 'HEAD';
        break;
      case '-L':
      case '--location':
        // Testbench follows redirects by default anyway.
        break;
      case '-k':
      case '--insecure':
        warnings.push('The command skips TLS checks (-k). Testbench always checks certificates; add a client certificate or fix the server certificate if the request fails.');
        break;
      default:
        if (!w.startsWith('-')) url = url || w;
    }
  }
  if (!url) throw new ImportError('The command has no URL.');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  let body: ApiBody = { type: 'none' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImportError(`That is not a valid URL: ${url}`);
  }
  // -G sends the data as the query string instead of the body.
  if (get && data.length) {
    for (const pair of data.join('&').split('&')) {
      const [k, ...v] = pair.split('=');
      if (k) parsed.searchParams.append(decodeURIComponent(k), decodeURIComponent(v.join('=')));
    }
    data.length = 0;
  }
  const params: KeyValue[] = [...parsed.searchParams].map(([key, value]) => ({ key, value, enabled: true }));
  const base = `${parsed.origin}${parsed.pathname}`;

  const contentType = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (form.length) body = { type: 'form', fields: form };
  else if (data.length) {
    const text = data.join('&');
    if (json || contentType.includes('json') || (!contentType && /^\s*[{[]/.test(text))) {
      body = { type: 'json', text };
      if (json && !contentType) headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
    } else if (!contentType || contentType.includes('x-www-form-urlencoded')) {
      body = { type: 'form', fields: [...new URLSearchParams(text)].map(([key, value]) => ({ key, value, enabled: true })) };
    } else body = { type: 'text', text, contentType };
  }
  if (form.length) warnings.push('Multipart form data (-F) is sent as a URL-encoded form for now.');

  const m = (method ?? (data.length || form.length ? 'POST' : 'GET')) as HttpMethod;
  if (!(HTTP_METHODS as readonly string[]).includes(m)) throw new ImportError(`Method ${m} is not supported.`);
  // The body type sets Content-Type itself; a duplicate from the command would be sent twice.
  const keptHeaders = body.type === 'form' || body.type === 'json' ? headers.filter((h) => h.key.toLowerCase() !== 'content-type' || body.type === 'json') : headers;
  return {
    name: `${m} ${parsed.pathname}`.slice(0, 200),
    request: ApiRequestDef.parse({
      method: m,
      url: base,
      params,
      headers: keptHeaders,
      body,
      auth,
      settings: { timeoutMs: timeoutMs ?? 30_000, followRedirects: true },
    }),
    warnings,
  };
}
