import { z } from 'zod';

// API Studio (docs/api-testing-plan.md): workspaces of collections, folders and requests, variations,
// environments, the spec library and sending requests from the server.

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export const HttpMethod = z.enum(HTTP_METHODS);
export type HttpMethod = z.infer<typeof HttpMethod>;

const name = z.string().trim().min(1).max(200);
const varKey = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][\w.-]*$/, 'Variable names start with a letter or _ and use letters, digits, _ . -');

export const KeyValue = z.object({
  key: z.string().max(500),
  value: z.string().max(10_000),
  enabled: z.boolean().default(true),
});
export type KeyValue = z.infer<typeof KeyValue>;

/**
 * A variable as the browser sees it. A secret's value is never sent back: `value` is empty and
 * `hasValue` says whether one is stored. Saving a secret with an empty value keeps the stored one.
 */
export const ApiVariable = z.object({
  key: varKey,
  value: z.string().max(10_000),
  secret: z.boolean().default(false),
  enabled: z.boolean().default(true),
  hasValue: z.boolean().optional(),
});
export type ApiVariable = z.infer<typeof ApiVariable>;
const variables = z
  .array(ApiVariable)
  .max(500)
  .refine((vs) => new Set(vs.map((v) => v.key)).size === vs.length, { message: 'Variable names must be unique' });

export const ApiAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  /** Use the folder's or collection's auth. The default for a request. */
  z.object({ type: z.literal('inherit') }),
  z.object({ type: z.literal('bearer'), token: z.string().max(10_000) }),
  z.object({ type: z.literal('basic'), username: z.string().max(500), password: z.string().max(2000) }),
  z.object({
    type: z.literal('apikey'),
    key: z.string().min(1).max(200),
    value: z.string().max(10_000),
    in: z.enum(['header', 'query']),
  }),
  /** Log in with an auth profile and reuse the session (plan §16.5). */
  z.object({ type: z.literal('profile'), profileId: z.uuid() }),
]);
export type ApiAuth = z.infer<typeof ApiAuth>;

export const ApiBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('json'), text: z.string().max(1_000_000) }),
  z.object({ type: z.literal('text'), text: z.string().max(1_000_000), contentType: z.string().max(200) }),
  z.object({ type: z.literal('form'), fields: z.array(KeyValue).max(200) }),
  z.object({ type: z.literal('graphql'), query: z.string().max(200_000), variables: z.string().max(200_000) }),
]);
export type ApiBody = z.infer<typeof ApiBody>;

export const ASSERT_SOURCES = ['status', 'time', 'size', 'header', 'body'] as const;
export const ASSERT_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'notContains', 'matches', 'exists', 'notExists', 'type', 'in'] as const;

/** A no-code check on the response (plan §7). `path` is a header name or a JSONPath, by source. */
export const ApiAssertion = z.object({
  id: z.string().min(1).max(40),
  source: z.enum(ASSERT_SOURCES),
  path: z.string().max(500).default(''),
  op: z.enum(ASSERT_OPS),
  value: z.string().max(10_000).default(''),
  enabled: z.boolean().default(true),
});
export type ApiAssertion = z.infer<typeof ApiAssertion>;

/** Copies a value from the response into a variable for the requests that follow. */
export const ApiExtractor = z.object({
  variable: varKey,
  source: z.enum(['body', 'header', 'status']),
  path: z.string().max(500).default(''),
  enabled: z.boolean().default(true),
});
export type ApiExtractor = z.infer<typeof ApiExtractor>;

/**
 * JavaScript run before the request is sent and after the response arrives (plan §6), in a sandbox
 * with no network, file or process access. `pm.*` works as an alias of `tb.*` for Postman scripts.
 */
export const ApiScripts = z.object({
  pre: z.string().max(100_000).default(''),
  post: z.string().max(100_000).default(''),
});
export type ApiScripts = z.infer<typeof ApiScripts>;

export const STREAM_PROTOCOLS = ['http', 'ws', 'sse'] as const;
export type StreamProtocol = (typeof STREAM_PROTOCOLS)[number];

/** What a WebSocket or SSE request does once connected. */
export const ApiStreamSettings = z.object({
  /** Messages sent in order right after connecting (WebSocket only). {{variables}} are filled in. */
  send: z.array(z.string().max(100_000)).max(50).default([]),
  /** How long to listen after connecting. */
  listenMs: z.number().int().min(200).max(60_000).default(5000),
  /** Stop once this many messages or events have come in. */
  maxMessages: z.number().int().min(1).max(500).default(50),
});
export type ApiStreamSettings = z.infer<typeof ApiStreamSettings>;

export const ApiRequestDef = z.object({
  /** http unless it is a WebSocket (ws:// or wss://) or Server-Sent Events request. */
  protocol: z.enum(STREAM_PROTOCOLS).optional(),
  stream: ApiStreamSettings.optional(),
  method: HttpMethod,
  url: z.string().max(8000),
  params: z.array(KeyValue).max(200).default([]),
  headers: z.array(KeyValue).max(200).default([]),
  body: ApiBody.default({ type: 'none' }),
  auth: ApiAuth.default({ type: 'inherit' }),
  assertions: z.array(ApiAssertion).max(100).default([]),
  extractors: z.array(ApiExtractor).max(50).default([]),
  settings: z
    .object({
      timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
      followRedirects: z.boolean().default(true),
    })
    .default({ timeoutMs: 30_000, followRedirects: true }),
  docs: z.string().max(20_000).default(''),
  scripts: ApiScripts.default({ pre: '', post: '' }),
  /** The spec operation this request was made from ("GET /orders/{id}"), when there is one. */
  operation: z
    .object({
      specId: z.uuid(),
      method: HttpMethod,
      path: z.string().max(2000),
      /** The spec version the request was made from or last reviewed against; null for older requests. */
      version: z.number().int().min(1).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type ApiRequestDef = z.infer<typeof ApiRequestDef>;

/**
 * Collection and folder settings every request inside inherits. Auth defaults to inherit so a new
 * folder passes its collection's auth through; on a collection, inherit means none.
 */
export const ApiContainerConfig = z.object({
  auth: ApiAuth.default({ type: 'inherit' }),
  variables: variables.default([]),
  /** Run for every request inside: pre scripts outermost first, post scripts innermost first. */
  scripts: ApiScripts.default({ pre: '', post: '' }),
});
export type ApiContainerConfig = z.infer<typeof ApiContainerConfig>;

/** Fields present replace the request's own; absent fields inherit (plan §3). */
export const ApiVariationOverrides = ApiRequestDef.pick({
  params: true,
  headers: true,
  body: true,
  auth: true,
  assertions: true,
})
  .partial()
  .extend({ url: z.string().max(8000).optional() });
export type ApiVariationOverrides = z.infer<typeof ApiVariationOverrides>;

// ---------- workspaces and the tree ----------

export const WorkspaceBody = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['team', 'personal']).default('team') });
export const WorkspacePatch = z.object({ name: z.string().trim().min(1).max(120).optional(), variables: variables.optional() });

export interface ApiWorkspace {
  id: string;
  name: string;
  kind: 'team' | 'personal';
  ownerId: string;
  variables: ApiVariable[];
  updatedAt: string;
}

export const NodeKind = z.enum(['collection', 'folder', 'request']);
export type NodeKind = z.infer<typeof NodeKind>;

export const CreateNodeBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('collection'), name, config: ApiContainerConfig.optional() }),
  z.object({ kind: z.literal('folder'), name, parentId: z.uuid(), config: ApiContainerConfig.optional() }),
  z.object({ kind: z.literal('request'), name, parentId: z.uuid(), request: ApiRequestDef.optional() }),
]);
export type CreateNodeBody = z.infer<typeof CreateNodeBody>;

/** Rename, move (parentId + position) or save the node's settings, in any combination. */
export const UpdateNodeBody = z.object({
  name: name.optional(),
  parentId: z.uuid().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  config: ApiContainerConfig.optional(),
  request: ApiRequestDef.optional(),
});
export type UpdateNodeBody = z.infer<typeof UpdateNodeBody>;

/** One row of the tree. The tree loads flat; the client nests it by parentId. */
export interface ApiNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  name: string;
  position: number;
  /** Requests only, so the tree can show the verb without loading every request. */
  method: HttpMethod | null;
  variationCount: number;
  /** Set when the spec operation it was made from changed since: what changed, in a sentence. */
  needsReview: string | null;
  updatedAt: string;
}

export interface ApiNodeDetail extends ApiNode {
  config: ApiContainerConfig | null;
  request: ApiRequestDef | null;
  variations: ApiVariation[];
}

export const VariationBody = z.object({ name, overrides: ApiVariationOverrides.default({}) });
export type VariationBody = z.infer<typeof VariationBody>;

export interface ApiVariation {
  id: string;
  requestId: string;
  name: string;
  position: number;
  overrides: ApiVariationOverrides;
  updatedAt: string;
}

// ---------- environments ----------

export const EnvironmentBody = z.object({
  name: z.string().trim().min(1).max(60),
  variables: variables.default([]),
  /** A production environment: load tests and active security checks against it need an admin's override. */
  production: z.boolean().default(false),
});
export type EnvironmentBody = z.infer<typeof EnvironmentBody>;

export interface ApiEnvironment {
  id: string;
  name: string;
  position: number;
  variables: ApiVariable[];
  production: boolean;
  updatedAt: string;
}

// ---------- sending ----------

/** Cookie handling for one send (plan §16.5). The builder defaults to the saved jar. */
export const CookieMode = z.enum(['none', 'saved']);
export type CookieMode = z.infer<typeof CookieMode>;

export const SendBody = z.object({
  /** The request as it is in the editor, which may have unsaved changes. */
  request: ApiRequestDef,
  /** Where it sits in the tree: its folders and collection supply auth and variables. */
  nodeId: z.uuid().nullable().default(null),
  /** For a new request not saved yet: the folder or collection it will go in. */
  parentId: z.uuid().nullable().default(null),
  variationId: z.uuid().nullable().default(null),
  environmentId: z.uuid().nullable().default(null),
  cookies: CookieMode.default('saved'),
  /**
   * Values earlier sends extracted (a login token), held by the tester's browser and the most specific
   * scope. Kept out of shared environments so one tester's token never overwrites a teammate's.
   */
  locals: z.record(varKey, z.string().max(10_000)).default({}),
});
export type SendBody = z.infer<typeof SendBody>;

export interface ApiTimings {
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  firstByteMs: number | null;
  totalMs: number;
}

export interface AssertionResult {
  id: string;
  passed: boolean;
  /** Plain words: "status is 201", "$.total is 1998, expected 2000". */
  message: string;
  actual: string | null;
}

export interface ApiResponseView {
  status: number;
  statusText: string;
  headers: [string, string][];
  /** Text bodies as text; anything else as base64. Cut at `truncated` bytes when too large. */
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  contentType: string | null;
  sizeBytes: number;
  truncated: boolean;
}

export interface StreamEvent {
  /** Milliseconds since the connection opened. */
  t: number;
  kind: 'open' | 'out' | 'in' | 'close' | 'error';
  data: string;
  /** SSE only. */
  event?: string;
  id?: string;
}

export interface StreamResult {
  protocol: Exclude<StreamProtocol, 'http'>;
  url: string;
  /** 101 for a WebSocket that connected, the HTTP status for SSE; null when it never connected. */
  status: number | null;
  responseHeaders: [string, string][];
  requestHeaders: [string, string][];
  events: StreamEvent[];
  closeCode: number | null;
  closeReason: string | null;
  /** Why it ended: the server closed it, the listening time ran out, or enough messages came in. */
  endedBy: 'server' | 'time' | 'messages' | 'error';
  timings: { connectMs: number | null; firstMessageMs: number | null; totalMs: number };
  error: { code: string; message: string } | null;
  truncated: boolean;
  assertions: AssertionResult[];
  extracted: Record<string, string>;
  unresolved: string[];
  logs: ScriptLog[];
  scriptErrors: { phase: 'pre' | 'post'; source: string; message: string }[];
}

export interface SendResult {
  historyId: string;
  /** The URL actually called, secrets masked. */
  url: string;
  method: HttpMethod;
  /** Headers sent, secrets masked. */
  requestHeaders: [string, string][];
  response: ApiResponseView | null;
  /** Why there is no response: blocked address, timeout, refused, bad URL. */
  error: { code: string; message: string } | null;
  timings: ApiTimings;
  redirects: { status: number; url: string }[];
  assertions: AssertionResult[];
  /** Values the extractors and scripts saved, secrets masked. The browser keeps them as session values. */
  extracted: Record<string, string>;
  /** Session values a script unset; the browser drops them. */
  cleared: string[];
  /** How the response differs from the spec, when the request came from a spec operation. */
  drift: DriftReport | null;
  /** What the response gives away without being attacked: weak headers, cookies, leaked fields or errors. */
  security: SecurityFinding[];
  /** The login an auth profile ran first, when it had to (no session yet, expired, or a 401). */
  login: { status: number | null; error: string | null; historyId: string; reason: 'no_session' | 'expired' | 'unauthorized' } | null;
  /** Variables used but not defined anywhere; the request was sent with them left as {{name}}. */
  unresolved: string[];
  cookiesSent: string[];
  cookiesSet: string[];
  /** console.* output from pre and post scripts, secrets masked. */
  logs: ScriptLog[];
  /** A script that threw or ran out of time; a failed pre script means nothing was sent. */
  scriptErrors: { phase: 'pre' | 'post'; source: string; message: string }[];
}

export interface ScriptLog {
  phase: 'pre' | 'post';
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

export interface HistoryEntry {
  id: string;
  nodeId: string | null;
  method: HttpMethod;
  url: string;
  status: number | null;
  durationMs: number;
  error: string | null;
  createdAt: string;
}

export interface HistoryDetail extends HistoryEntry {
  request: { headers: [string, string][]; body: string | null };
  response: ApiResponseView | null;
}

export interface CookieView {
  name: string;
  domain: string;
  path: string;
  expires: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
}

// ---------- spec library ----------

export const SPEC_MAX_BYTES = 20 * 1024 * 1024;

export const SpecUploadBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** The document as text: JSON or YAML. */
    content: z.string().min(2).max(SPEC_MAX_BYTES).optional(),
    /** Or a URL to fetch it from; kept so the spec can be synced again. */
    url: z.url().max(2000).optional(),
  })
  .refine((b) => Boolean(b.content) !== Boolean(b.url), { message: 'Give the spec as content or as a URL, not both' });
export type SpecUploadBody = z.infer<typeof SpecUploadBody>;

export const SpecVersionBody = z.object({ content: z.string().min(2).max(SPEC_MAX_BYTES).optional() });

export interface SpecOperation {
  method: HttpMethod;
  path: string;
  operationId: string | null;
  summary: string;
  tags: string[];
  deprecated: boolean;
  /** Parameter names by location, and which are required. */
  parameters: { name: string; in: 'path' | 'query' | 'header' | 'cookie'; required: boolean }[];
  requestBody: { required: boolean; contentTypes: string[] } | null;
  /** Documented status codes ("200", "4XX", "default"). */
  responses: string[];
  /** Security scheme names; empty when the operation is public; null when the spec does not say. */
  security: string[] | null;
}

export interface SpecChange {
  kind:
    | 'operation_added'
    | 'operation_removed'
    | 'parameter_added'
    | 'parameter_removed'
    | 'parameter_now_required'
    | 'body_now_required'
    | 'response_added'
    | 'response_removed'
    | 'deprecated'
    | 'security_changed';
  breaking: boolean;
  method: HttpMethod;
  path: string;
  detail: string;
}

export interface SpecDiff {
  fromVersion: number;
  added: number;
  removed: number;
  changed: number;
  breaking: number;
  changes: SpecChange[];
}

export interface ApiSpecSummary {
  id: string;
  name: string;
  sourceUrl: string | null;
  version: number;
  title: string;
  apiVersion: string;
  format: 'openapi3' | 'swagger2';
  operationCount: number;
  breakingInLatest: number;
  updatedAt: string;
}

export interface ApiSpecVersion {
  version: number;
  title: string;
  apiVersion: string;
  format: 'openapi3' | 'swagger2';
  sizeBytes: number;
  operationCount: number;
  diff: SpecDiff | null;
  createdBy: string;
  createdAt: string;
}

export interface ApiSpecDetail extends ApiSpecSummary {
  versions: ApiSpecVersion[];
  operations: SpecOperation[];
  /** Servers declared in the spec, to suggest as a baseUrl. */
  servers: string[];
}

/** Result of an upload: `created` is false when the content matched the latest version. */
export interface SpecUploadResult {
  spec: ApiSpecSummary;
  created: boolean;
}

/** Makes requests in a collection from spec operations, one folder per tag. */
export const SpecImportBody = z.object({
  workspaceId: z.uuid(),
  /** An existing collection to add to, or a new one with this name. */
  collectionId: z.uuid().nullable().default(null),
  collectionName: z.string().trim().min(1).max(200).optional(),
  version: z.number().int().min(1).optional(),
  /** "GET /orders/{id}" keys; empty imports every operation. */
  operations: z.array(z.string().max(2100)).max(5000).default([]),
});
export type SpecImportBody = z.infer<typeof SpecImportBody>;

// ---------- import, export, snippets ----------

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

export const ImportBody = z.discriminatedUnion('format', [
  /** A Postman collection export (v2.0 or v2.1), as a new collection. */
  z.object({ format: z.literal('postman'), content: z.string().min(2).max(IMPORT_MAX_BYTES) }),
  /** A Postman environment export, as a new environment. */
  z.object({ format: z.literal('postman-environment'), content: z.string().min(2).max(IMPORT_MAX_BYTES) }),
  /** A pasted cURL command, as a new request in this folder or collection. */
  z.object({ format: z.literal('curl'), content: z.string().min(4).max(1_000_000), parentId: z.uuid() }),
]);
export type ImportBody = z.infer<typeof ImportBody>;

export interface ImportResult {
  kind: 'collection' | 'environment' | 'request';
  id: string;
  name: string;
  requests: number;
  /** What did not carry over, in plain words. */
  warnings: string[];
}

export const SNIPPET_LANGS = ['curl', 'fetch', 'python', 'go', 'java', 'csharp'] as const;
export const SnippetBody = SendBody.extend({ language: z.enum(SNIPPET_LANGS) });
export type SnippetBody = z.infer<typeof SnippetBody>;

export interface SnippetResult {
  language: (typeof SNIPPET_LANGS)[number];
  code: string;
}

// ---------- client certificates and auth profiles ----------

const pem = (what: string) =>
  z.string().trim().max(100_000).regex(/-----BEGIN [A-Z0-9 ]+-----[\s\S]+-----END [A-Z0-9 ]+-----/, `Paste the ${what} in PEM format (-----BEGIN …)`);

export const ClientCertBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** "api.bank.test", "*.bank.test", optionally with ":8443". */
  host: z.string().trim().toLowerCase().regex(/^(\*\.)?[a-z0-9.-]+(:[0-9]{1,5})?$/, 'A host like api.bank.test, *.bank.test or api.bank.test:8443'),
  /** Certificate and key, or only a CA for a server whose certificate is private. */
  cert: pem('certificate').optional(),
  key: pem('private key').optional(),
  passphrase: z.string().max(1000).optional(),
  ca: pem('CA certificate').optional(),
}).refine((b) => Boolean(b.cert) === Boolean(b.key), { message: 'A client certificate needs its private key, and a key needs its certificate' })
  .refine((b) => b.cert || b.ca, { message: 'Give a client certificate and key, a CA certificate, or both' });
export type ClientCertBody = z.infer<typeof ClientCertBody>;

export interface ClientCertView {
  id: string;
  name: string;
  host: string;
  subject: string;
  expiresAt: string | null;
  hasClientCert: boolean;
  hasCa: boolean;
  updatedAt: string;
}

export const AuthProfileConfig = z.object({
  /** Where the login response carries the credential. For a cookie, `path` is the cookie name. */
  extract: z.object({ source: z.enum(['body', 'header', 'cookie']), path: z.string().trim().min(1).max(500) }),
  /** How it goes on each request. `cookie` sends nothing extra: the saved cookie jar carries it. */
  apply: z.discriminatedUnion('as', [
    z.object({ as: z.literal('bearer') }),
    z.object({ as: z.literal('header'), header: z.string().trim().min(1).max(200), prefix: z.string().max(100).default('') }),
    z.object({ as: z.literal('cookie') }),
  ]),
  /** How long a session lasts. Null uses the token's own exp claim, or keeps it until a 401. */
  ttlSeconds: z.number().int().min(10).max(30 * 86_400).nullable().default(null),
  /** On a 401, log in again once and retry; a second 401 is a real failure. */
  reloginOn401: z.boolean().default(true),
  /** Double-submit CSRF: copy this cookie into this header on POST, PUT, PATCH and DELETE. */
  csrf: z.object({ cookie: z.string().trim().min(1).max(200), header: z.string().trim().min(1).max(200) }).nullable().default(null),
});
export type AuthProfileConfig = z.infer<typeof AuthProfileConfig>;

export const AuthProfileBody = z.object({
  name: z.string().trim().min(1).max(120),
  loginNodeId: z.uuid(),
  config: AuthProfileConfig,
});
export type AuthProfileBody = z.infer<typeof AuthProfileBody>;

export interface AuthProfileView {
  id: string;
  name: string;
  loginNodeId: string | null;
  loginName: string | null;
  config: AuthProfileConfig;
  updatedAt: string;
}

// ---------- dependency graph, project map and workflows (plan §12) ----------

/** "POST /orders" style key for a spec operation. */
export type OperationKey = string;

/** One operation produces a value another needs: `field` of `from`'s response fills `param` of `to`. */
export interface DependencyLink {
  id: string;
  from: OperationKey;
  to: OperationKey;
  /** `auth` means `to` needs a credential `from` hands out; `name` is the security scheme then. */
  param: { in: 'path' | 'query' | 'header' | 'body' | 'auth'; name: string };
  /** JSONPath in `from`'s response; null for auth links, where the profile says where the token is. */
  field: string | null;
  confidence: number;
  reason: string;
  source: 'spec' | 'inferred' | 'confirmed';
}

export interface MapOperation {
  key: OperationKey;
  specId: string;
  specName: string;
  method: HttpMethod;
  path: string;
  summary: string;
  tag: string;
  secured: boolean;
  /** Inputs no operation produces: the tester has to supply them (a data set or a variable). */
  orphans: string[];
}

export interface ApiSuggestedWorkflow {
  id: string;
  kind: 'crud' | 'setup';
  name: string;
  /** Operations in the order to call them. */
  steps: { key: OperationKey; expectStatus: string | null; note: string }[];
}

export interface ProjectMap {
  operations: MapOperation[];
  links: DependencyLink[];
  /** All operations in an order that respects every link (cycles broken where they close). */
  order: OperationKey[];
  suggestions: ApiSuggestedWorkflow[];
}

export const LinkDecisionBody = z.object({
  from: z.string().min(3).max(2100),
  to: z.string().min(3).max(2100),
  param: z.object({ in: z.enum(['path', 'query', 'header', 'body', 'auth']), name: z.string().min(1).max(200) }),
  field: z.string().max(500).nullable(),
  /** confirmed: use it; rejected: never suggest it again. */
  status: z.enum(['confirmed', 'rejected']),
});
export type LinkDecisionBody = z.infer<typeof LinkDecisionBody>;

const Assign = z.object({ variable: varKey, source: z.enum(['body', 'header', 'status']), path: z.string().max(500).default('') });
export type ApiWorkflowAssign = z.infer<typeof Assign>;

const stepBase = { id: z.string().min(1).max(40), name: z.string().trim().max(200).default('') };

/** A condition on a workflow variable, for if and poll-until. */
export const ApiWorkflowCondition = z.object({
  variable: varKey,
  op: z.enum(['eq', 'ne', 'lt', 'gt', 'contains', 'exists', 'notExists']),
  value: z.string().max(2000).default(''),
});
export type ApiWorkflowCondition = z.infer<typeof ApiWorkflowCondition>;

export type ApiWorkflowStep =
  | { id: string; name: string; kind: 'request'; requestId: string; variationId: string | null; assign: ApiWorkflowAssign[]; continueOnFail: boolean }
  | { id: string; name: string; kind: 'wait'; ms: number }
  | { id: string; name: string; kind: 'poll'; requestId: string; variationId: string | null; assign: ApiWorkflowAssign[]; until: ApiWorkflowCondition; intervalMs: number; timeoutMs: number }
  | { id: string; name: string; kind: 'if'; condition: ApiWorkflowCondition; then: ApiWorkflowStep[]; else: ApiWorkflowStep[] }
  | { id: string; name: string; kind: 'loop'; count: number | null; overVariable: string | null; as: string; steps: ApiWorkflowStep[] }
  | { id: string; name: string; kind: 'parallel'; branches: ApiWorkflowStep[][] }
  | { id: string; name: string; kind: 'workflow'; workflowId: string };

export const ApiWorkflowStep: z.ZodType<ApiWorkflowStep> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ ...stepBase, kind: z.literal('request'), requestId: z.uuid(), variationId: z.uuid().nullable().default(null), assign: z.array(Assign).max(50).default([]), continueOnFail: z.boolean().default(false) }),
    z.object({ ...stepBase, kind: z.literal('wait'), ms: z.number().int().min(0).max(60_000) }),
    z.object({
      ...stepBase,
      kind: z.literal('poll'),
      requestId: z.uuid(),
      variationId: z.uuid().nullable().default(null),
      assign: z.array(Assign).max(50).default([]),
      until: ApiWorkflowCondition,
      intervalMs: z.number().int().min(200).max(60_000).default(2000),
      timeoutMs: z.number().int().min(1000).max(120_000).default(60_000),
    }),
    z.object({ ...stepBase, kind: z.literal('if'), condition: ApiWorkflowCondition, then: z.array(ApiWorkflowStep).max(100).default([]), else: z.array(ApiWorkflowStep).max(100).default([]) }),
    z.object({
      ...stepBase,
      kind: z.literal('loop'),
      count: z.number().int().min(1).max(100).nullable().default(null),
      /** A variable holding a JSON array; each item is `as` inside the loop. */
      overVariable: varKey.nullable().default(null),
      as: varKey.default('item'),
      steps: z.array(ApiWorkflowStep).max(100).default([]),
    }),
    z.object({ ...stepBase, kind: z.literal('parallel'), branches: z.array(z.array(ApiWorkflowStep).max(100)).min(2).max(10) }),
    z.object({ ...stepBase, kind: z.literal('workflow'), workflowId: z.uuid() }),
  ]),
) as z.ZodType<ApiWorkflowStep>;

export const ApiWorkflowDef = z.object({
  /** Starting values, like inputs; steps add to them with assign, extractors and scripts. */
  variables: z.array(KeyValue).max(100).default([]),
  steps: z.array(ApiWorkflowStep).max(200).default([]),
  /** Always runs after the steps, even when one failed, so test data is cleaned up. */
  teardown: z.array(ApiWorkflowStep).max(50).default([]),
});
export type ApiWorkflowDef = z.infer<typeof ApiWorkflowDef>;

export const ApiWorkflowBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  def: ApiWorkflowDef,
});
export type ApiWorkflowBody = z.infer<typeof ApiWorkflowBody>;

export interface ApiWorkflowSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  stepCount: number;
  lastRun: { id: string; status: ApiWorkflowRunStatus; finishedAt: string | null } | null;
  /** Steps whose requests need review after a spec change. */
  needsReview: number;
  updatedAt: string;
}

export interface ApiWorkflow extends ApiWorkflowSummary {
  def: ApiWorkflowDef;
}

/** Makes a workflow from a suggestion, creating requests for operations the workspace does not have. */
export const ApiWorkflowFromSuggestionBody = z.object({ suggestionId: z.string().min(1).max(200), name: z.string().trim().min(1).max(200).optional() });

export const ApiWorkflowRunBody = z.object({
  environmentId: z.uuid().nullable().default(null),
  /** step: stop after each top-level step; the tester continues with the step endpoint. */
  mode: z.enum(['all', 'step']).default('all'),
  locals: z.record(varKey, z.string().max(10_000)).default({}),
});
export type ApiWorkflowRunBody = z.infer<typeof ApiWorkflowRunBody>;

export type ApiWorkflowRunStatus = 'running' | 'paused' | 'passed' | 'failed' | 'error' | 'cancelled';

export interface ApiWorkflowStepResult {
  stepId: string;
  /** Loop and parallel steps run their children many times; this tells the runs apart. */
  iteration: string;
  kind: ApiWorkflowStep['kind'];
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  message: string;
  historyId: string | null;
  httpStatus: number | null;
  durationMs: number;
  /** Variables this step set, secrets masked. */
  assigned: Record<string, string>;
  startedAt: string;
}

export interface ApiWorkflowRun {
  id: string;
  workflowId: string;
  version: number;
  status: ApiWorkflowRunStatus;
  mode: 'all' | 'step';
  /** Index of the next top-level step in step mode. */
  next: number;
  results: ApiWorkflowStepResult[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// ---------- spec quality (plan §10) ----------

export type LintSeverity = 'error' | 'warning' | 'info';
export type LintCategory = 'security' | 'completeness' | 'naming' | 'consistency' | 'errors' | 'http' | 'pagination' | 'versioning';

export interface LintRule {
  id: string;
  category: LintCategory;
  severity: LintSeverity;
  title: string;
  why: string;
}

export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  category: LintCategory;
  /** JSON pointer into the spec document. */
  pointer: string;
  operation: OperationKey | null;
  message: string;
  fix: string;
}

export interface LintReport {
  /** 0 to 100; weighted by severity and scaled to the size of the API. */
  score: number;
  counts: Record<LintSeverity, number>;
  issues: LintIssue[];
  operations: number;
  rulesRun: number;
}

export interface SpecQuality extends LintReport {
  version: number;
  rules: (LintRule & { enabled: boolean; reason: string | null })[];
}

export const LintSettingBody = z.object({
  rule: z.string().min(1).max(60),
  enabled: z.boolean(),
  /** Why it is off, for the next person who wonders. Required to switch a rule off. */
  reason: z.string().trim().max(500).default(''),
}).refine((b) => b.enabled || b.reason.length >= 3, { message: 'Say why the rule is switched off', path: ['reason'] });

// ---------- enrichment (plan §9) ----------

export const ENRICHMENT_KINDS = ['security', 'error_response', 'required', 'constraints', 'dependency', 'example', 'side_effect', 'business_rule'] as const;
export type EnrichmentKind = (typeof ENRICHMENT_KINDS)[number];

/** One change to the spec document, at a JSON pointer. `merge` adds keys to an object; `append` adds to a list. */
export interface OverlayPatch {
  pointer: string;
  op: 'set' | 'merge' | 'append';
  value: unknown;
  /** The question it answers. */
  question: string;
}

export const EnrichmentAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('security'), scheme: z.string().max(100).nullable(), roles: z.array(z.string().trim().min(1).max(60)).max(20).default([]) }),
  z.object({ kind: z.literal('error_response'), status: z.string().regex(/^[45]\d\d$/, 'A 4xx or 5xx status'), description: z.string().max(500).default(''), body: z.string().max(20_000).default('') }),
  z.object({ kind: z.literal('required'), fields: z.array(z.string().min(1).max(200)).max(200) }),
  z.object({
    kind: z.literal('constraints'),
    minimum: z.number().nullable().default(null),
    maximum: z.number().nullable().default(null),
    maxLength: z.number().int().min(0).max(1_000_000).nullable().default(null),
    pattern: z.string().max(500).default(''),
    enum: z.array(z.string().max(200)).max(100).default([]),
  }),
  z.object({ kind: z.literal('dependency'), confirmed: z.boolean() }),
  z.object({ kind: z.literal('example'), body: z.string().min(2).max(100_000) }),
  z.object({ kind: z.literal('side_effect'), effect: z.enum(['hard', 'soft']), field: z.string().max(100).default(''), value: z.string().max(200).default('') }),
  z.object({ kind: z.literal('business_rule'), text: z.string().max(2000) }),
]);
export type EnrichmentAnswer = z.infer<typeof EnrichmentAnswer>;

export interface EnrichmentQuestion {
  id: string;
  kind: EnrichmentKind;
  operation: OperationKey;
  pointer: string;
  field: string | null;
  prompt: string;
  impact: number;
  status: 'open' | 'answered' | 'skipped' | 'stale';
  answer: EnrichmentAnswer | null;
  source: 'user' | 'ai' | null;
  assignedTo: { id: string; name: string } | null;
  answeredBy: string | null;
  answeredAt: string | null;
}

export interface EnrichmentView {
  specId: string;
  version: number;
  /** 0 to 100: how much of what testing needs the spec (with answers) now says. */
  readiness: number;
  counts: { open: number; answered: number; skipped: number; stale: number };
  questions: EnrichmentQuestion[];
}

export const EnrichmentAnswerBody = z.object({ questionId: z.string().min(8).max(40), answer: EnrichmentAnswer, source: z.enum(['user', 'ai']).default('user') });
export const EnrichmentStatusBody = z.object({ questionId: z.string().min(8).max(40), status: z.enum(['open', 'skipped']), assignTo: z.uuid().nullable().optional() });

/** An AI-drafted answer, for the tester to accept, edit or ignore. Never applied on its own. */
export interface EnrichmentDraft {
  answer: EnrichmentAnswer;
  why: string;
  ai: { status: 'used' | 'off' | 'unavailable'; message: string | null };
}

// ---------- generated tests and coverage (plan §11) ----------

export const GENERATED_KINDS = ['happy', 'required_missing', 'wrong_type', 'boundary', 'enum', 'format', 'pattern', 'pairwise', 'not_found', 'auth_missing'] as const;
export type GeneratedKind = (typeof GENERATED_KINDS)[number];

export interface GeneratedTest {
  id: string;
  operation: OperationKey;
  kind: GeneratedKind;
  name: string;
  expect: string[];
  why: string;
  pointer: string;
  overrides: ApiVariationOverrides;
  status: 'pending' | 'accepted' | 'rejected';
  /** The variation it became, once accepted. */
  variationId: string | null;
  requestId: string | null;
}

export interface GeneratedView {
  specId: string;
  version: number;
  tests: GeneratedTest[];
  counts: { pending: number; accepted: number; rejected: number };
}

export const GenerateBody = z.object({ operations: z.array(z.string().max(2100)).max(5000).default([]) });

export const ReviewGeneratedBody = z.object({
  ids: z.array(z.string().min(8).max(40)).min(1).max(1000),
  decision: z.enum(['accept', 'reject', 'pending']),
  /** Where accepted tests go: their operation's request in this workspace, made from the spec if missing. */
  workspaceId: z.uuid().optional(),
});

/** undocumented: tests expect a status the spec does not document, so the spec should say it. */
export type CoverageCell = 'covered' | 'generated' | 'missing' | 'undocumented';

export interface CoverageRow {
  operation: OperationKey;
  tag: string;
  /** Documented status codes, and one column for any undocumented status that tests expect. */
  cells: Record<string, CoverageCell>;
}

export interface CoverageView {
  statuses: string[];
  rows: CoverageRow[];
  totals: { cells: number; covered: number; generated: number; missing: number; undocumented: number; percent: number };
}

// ---------- AI answers for API Studio (validated before use; drafts for a person to accept) ----------

export const ApiEnrichDraft = z.object({ answer: EnrichmentAnswer, why: z.string().max(1000) });
export type ApiEnrichDraft = z.infer<typeof ApiEnrichDraft>;

export const ApiExplainAnswer = z.object({
  routes: z
    .array(
      z.object({
        key: z.string().max(2100),
        purpose: z.string().max(600),
        whatToTest: z.array(z.string().max(300)).max(15),
        gaps: z.array(z.string().max(300)).max(10),
      }),
    )
    .max(50),
});
export type ApiExplainAnswer = z.infer<typeof ApiExplainAnswer>;

/** Which of the valid chains the planner found fits the requirement best; -1 when none does. */
export const ApiPlanAnswer = z.object({ chosen: z.number().int().min(-1).max(20), explanation: z.string().max(2000), gaps: z.array(z.string().max(300)).max(10) });
export type ApiPlanAnswer = z.infer<typeof ApiPlanAnswer>;

export const ApiAskAnswer = z.object({ answer: z.string().max(4000), operations: z.array(z.string().max(2100)).max(20) });
export type ApiAskAnswer = z.infer<typeof ApiAskAnswer>;

// ---------- schema drift (plan §14) ----------

/** One way a response disagrees with the spec, at a JSONPath in the body. */
export interface DriftIssue {
  path: string;
  kind: 'type' | 'missing' | 'enum' | 'extra' | 'status';
  expected: string;
  actual: string;
}

export interface DriftReport {
  operation: OperationKey;
  specId: string;
  specVersion: number;
  status: number;
  issues: DriftIssue[];
}

// ---------- spec-change impact (plan §8) ----------

export interface ImpactItem {
  kind: 'request' | 'workflow';
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  operation: OperationKey | null;
  /** What changed in the spec since this was made or last reviewed. */
  changes: SpecChange[];
}

export interface ImpactView {
  specId: string;
  version: number;
  items: ImpactItem[];
}

// ---------- suites, schedules and monitors (plan §13) ----------

export const SuiteItem = z.discriminatedUnion('kind', [
  /** A request as saved, or one of its variations. */
  z.object({ kind: z.literal('request'), requestId: z.uuid(), variationId: z.uuid().nullable().default(null) }),
  /** A request and every variation it has. */
  z.object({ kind: z.literal('request_all'), requestId: z.uuid() }),
  /** Every request in a folder or collection, with all their variations. */
  z.object({ kind: z.literal('folder'), nodeId: z.uuid() }),
  z.object({ kind: z.literal('workflow'), workflowId: z.uuid() }),
]);
export type SuiteItem = z.infer<typeof SuiteItem>;

export const SuiteSettings = z.object({
  environmentId: z.uuid().nullable().default(null),
  /** A test data set: the suite runs once per row, with the columns as variables. */
  dataSetId: z.uuid().nullable().default(null),
  parallel: z.number().int().min(1).max(10).default(1),
  /** Extra attempts for a failing request; a pass after a retry counts as flaky. */
  retries: z.number().int().min(0).max(3).default(0),
  stopOnFail: z.boolean().default(false),
  delayMs: z.number().int().min(0).max(10_000).default(0),
  /** Count a response that differs from the spec as a failure, not only a note. */
  failOnDrift: z.boolean().default(false),
});
export type SuiteSettings = z.infer<typeof SuiteSettings>;

export const SuiteSchedule = z.object({
  /** Five-field cron in IST, like "0 2 * * *"; null for no schedule. */
  cron: z.string().trim().max(100).nullable().default(null),
  /** A monitor runs every few minutes and alerts on failure or slowness. */
  monitor: z
    .object({
      everyMinutes: z.number().int().min(5).max(60),
      /** Alert when the run's p95 latency goes above this. */
      maxP95Ms: z.number().int().min(10).max(120_000).nullable().default(null),
    })
    .nullable()
    .default(null),
  /** Run whenever a spec used by its requests gets a new version. */
  onSpecChange: z.boolean().default(false),
});
export type SuiteSchedule = z.infer<typeof SuiteSchedule>;

export const SuiteBody = z.object({
  name: z.string().trim().min(1).max(200),
  items: z.array(SuiteItem).min(1).max(500),
  settings: SuiteSettings.default(SuiteSettings.parse({})),
  schedule: SuiteSchedule.default(SuiteSchedule.parse({})),
});
export type SuiteBody = z.infer<typeof SuiteBody>;

export type SuiteRunStatus = 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export type SuiteTrigger = 'manual' | 'schedule' | 'monitor' | 'ci' | 'spec_change';

export interface SuiteRunTotals {
  total: number;
  passed: number;
  flaky: number;
  failed: number;
  errored: number;
  skipped: number;
  drift: number;
  p50Ms: number;
  p95Ms: number;
}

export interface SuiteResult {
  /** "request:<id>:<variation>" or "workflow:<id>", plus the data row. */
  key: string;
  group: string;
  name: string;
  row: number | null;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  flaky: boolean;
  attempts: number;
  httpStatus: number | null;
  durationMs: number;
  message: string;
  historyId: string | null;
  driftIssues: number;
  method: HttpMethod | null;
  operation: OperationKey | null;
}

export interface SuiteRun {
  id: string;
  suiteId: string;
  trigger: SuiteTrigger;
  status: SuiteRunStatus;
  environmentId: string | null;
  totals: SuiteRunTotals;
  results: SuiteResult[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string | null;
}

export interface ApiSuite {
  id: string;
  name: string;
  items: SuiteItem[];
  settings: SuiteSettings;
  schedule: SuiteSchedule;
  nextRunAt: string | null;
  lastRun: { id: string; status: SuiteRunStatus; totals: SuiteRunTotals; finishedAt: string | null } | null;
  updatedAt: string;
}

export const SuiteRunBody = z.object({
  environmentId: z.uuid().nullable().optional(),
  /** Wait for the run to finish and return it (for CI), up to 10 minutes. */
  wait: z.boolean().default(false),
});

/** Pass rate and latency per run over time, for a suite (plan §15). */
export interface SuiteTrend {
  runs: { id: string; startedAt: string; status: SuiteRunStatus; trigger: SuiteTrigger; passRate: number; flaky: number; p95Ms: number; drift: number }[];
  /** Slowest and least reliable requests across those runs. */
  requests: { key: string; name: string; runs: number; failures: number; flaky: number; p95Ms: number }[];
}

// ---------- bugs from API failures (plan §15) ----------

export const ApiBugBody = z.object({
  summary: z.string().trim().min(5).max(250),
  severity: z.enum(['Blocker', 'Critical', 'Major', 'Minor', 'Trivial']).default('Major'),
  labels: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
  note: z.string().max(4000).default(''),
  /** What failed, as the run or the builder reported it. */
  failures: z.array(z.string().max(1000)).max(50).default([]),
  /** Where it was found, for the bug: "suite Smoke, run …" or "API Studio". */
  found: z.string().max(300).default('API Studio'),
});

// ---------- the API assistant (plan §16) ----------

export interface AssistAi {
  status: 'used' | 'off' | 'unavailable';
  message: string | null;
}

export const ExplainBody = z.object({ text: z.string().min(3).max(200_000) });

export interface ExplainedRoute {
  key: OperationKey;
  /** In the project's specs; an unknown route is undocumented and gets a gap instead of a guess. */
  known: boolean;
  source: string;
  purpose: string;
  inputs: string[];
  security: string[];
  dependsOn: { key: OperationKey; field: string | null; param: string }[];
  feeds: OperationKey[];
  whatToTest: string[];
  gaps: string[];
}

export interface ExplainResult {
  routes: ExplainedRoute[];
  /** Pasted text the assistant could not read as a route. */
  unread: number;
  ai: AssistAi;
}

export const PlanBody = z.object({ requirement: z.string().trim().min(5).max(4000) });

export interface PlanChain {
  index: number;
  steps: OperationKey[];
  why: string;
}

export interface PlanResult {
  chains: PlanChain[];
  /** The chain that meets the requirement, or null when no documented calls do. */
  chosen: number | null;
  explanation: string;
  gaps: string[];
  ai: AssistAi;
}

export const AskBody = z.object({ question: z.string().trim().min(3).max(2000), historyId: z.uuid().nullable().default(null) });

export interface AskResult {
  answer: string;
  /** Operations the answer names, all real. */
  operations: OperationKey[];
  ai: AssistAi;
}

export const DetectAuthBody = z.object({ historyId: z.uuid() });

export interface DetectAuthResult {
  found: boolean;
  config: AuthProfileConfig | null;
  explanation: string;
  /** The request the login came from, to use as the profile's login. */
  loginNodeId: string | null;
}

export const ChainWorkflowBody = z.object({ name: z.string().trim().min(1).max(200), steps: z.array(z.string().min(3).max(2100)).min(1).max(30) });

// ---------- mock server (plan §14) ----------

export const MockConfig = z.object({
  /** Added to every response, to see how a client copes with a slow API. */
  latencyMs: z.number().int().min(0).max(10_000).default(0),
  /** Refuse requests that miss a required query parameter or body field, with the spec's documented 400 or 422. */
  validate: z.boolean().default(false),
  /** Answer 401 to a secured operation when the request carries no credential. */
  enforceAuth: z.boolean().default(false),
});
export type MockConfig = z.infer<typeof MockConfig>;

/** One operation's answer, instead of the spec's own example. */
export const MockOverride = z.object({
  status: z.number().int().min(100).max(599).nullable().default(null),
  /** JSON text; empty keeps the spec's example. */
  body: z.string().max(200_000).default(''),
  delayMs: z.number().int().min(0).max(10_000).default(0),
});
export type MockOverride = z.infer<typeof MockOverride>;

export const MockBody = z.object({
  enabled: z.boolean(),
  config: MockConfig,
  overrides: z.record(z.string().max(2100), MockOverride).default({}),
});
export type MockBody = z.infer<typeof MockBody>;

export interface MockView {
  specId: string;
  /** Null until the mock is first switched on. */
  url: string | null;
  enabled: boolean;
  config: MockConfig;
  overrides: Record<string, MockOverride>;
}

export interface MockHit {
  at: string;
  method: string;
  path: string;
  status: number;
  operation: OperationKey | null;
  ms: number;
}

// ---------- the safety gate: verified targets (plan §14) ----------

export const TargetBody = z.object({
  /** Host (and port when it is not 80 or 443): api.example.com, staging.example.com:8443. */
  host: z.string().trim().toLowerCase().min(3).max(260).regex(/^[a-z0-9.-]+(:[0-9]{1,5})?$/, 'A host like api.example.com, with no scheme or path'),
});

export interface ApiTarget {
  id: string;
  host: string;
  status: 'pending' | 'verified';
  /** What to publish to prove the host is yours. */
  challenge: { token: string; dns: { name: string; value: string }; file: { url: string; content: string } };
  verifiedAt: string | null;
  verifiedBy: string | null;
  method: 'dns' | 'file' | null;
}

export const VerifyTargetBody = z.object({ method: z.enum(['dns', 'file']) });

// ---------- security checks (plan §14) ----------

export const SECURITY_CHECKS = ['auth', 'bfla', 'bola', 'mass_assignment', 'injection', 'cors', 'rate_limit'] as const;
export type SecurityCheck = (typeof SECURITY_CHECKS)[number];

export type FindingSeverity = 'high' | 'medium' | 'low' | 'info';

export interface SecurityFinding {
  /** Stable across runs: the same problem on the same operation updates one finding, not a new one each time. */
  fingerprint: string;
  rule: string;
  severity: FindingSeverity;
  /** OWASP API Security Top 10 (2023) category, or the classic name for injection. */
  owasp: string;
  operation: OperationKey | null;
  title: string;
  detail: string;
  /** Masked request and response, short, as sent. */
  evidence: { request: string; response: string };
  historyId: string | null;
}

export interface StoredFinding extends SecurityFinding {
  id: string;
  status: 'open' | 'fixed' | 'suppressed';
  suppressReason: string | null;
  suppressUntil: string | null;
  firstSeen: string;
  lastSeen: string;
}

export const SecurityRunBody = z.object({
  workspaceId: z.uuid(),
  /** Values for what the specs do not give (an id that exists, a customer number): the checks need a request that works. */
  values: z.record(z.string().regex(/^[A-Za-z_][\w.-]*$/), z.string().max(2000)).default({}),
  environmentId: z.uuid(),
  /** Requests (made from the spec) to check: the folders or requests picked; empty means all made from this spec. */
  nodeIds: z.array(z.uuid()).max(500).default([]),
  checks: z.array(z.enum(SECURITY_CHECKS)).min(1).max(7).default([...SECURITY_CHECKS]),
  /** The person whose requests are the baseline. Their ids are what "someone else" must not reach. */
  otherProfileId: z.uuid().nullable().default(null),
  /** An account with the lowest role, to see whether it can call admin operations. */
  lowProfileId: z.uuid().nullable().default(null),
  /** An admin's explicit go-ahead for a production environment. */
  productionOverride: z.boolean().default(false),
});
export type SecurityRunBody = z.infer<typeof SecurityRunBody>;

export interface SecurityRunView {
  id: string;
  specId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  host: string;
  environmentName: string;
  checks: SecurityCheck[];
  requests: number;
  findings: SecurityFinding[];
  notes: string[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const SuppressBody = z.object({
  reason: z.string().trim().min(3).max(500),
  /** Days until it comes back for another look; null keeps it suppressed. */
  days: z.number().int().min(1).max(365).nullable().default(30),
});

// ---------- load testing (plan §14) ----------

export const LOAD_PROFILES = ['smoke', 'load', 'stress', 'spike', 'soak'] as const;
export type LoadProfile = (typeof LOAD_PROFILES)[number];

export const LoadSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), requestId: z.uuid(), variationId: z.uuid().nullable().default(null) }),
  z.object({ kind: z.literal('suite'), suiteId: z.uuid() }),
  z.object({ kind: z.literal('workflow'), workflowId: z.uuid() }),
]);
export type LoadSource = z.infer<typeof LoadSource>;

export const LoadThresholds = z.object({
  p95Ms: z.number().int().min(1).max(120_000).nullable().default(800),
  errorPercent: z.number().min(0).max(100).nullable().default(1),
  minRps: z.number().min(0).max(100_000).nullable().default(null),
});
export type LoadThresholds = z.infer<typeof LoadThresholds>;

/** In-process ceiling. Beyond it the test is exported as a k6 script for a runner with more capacity. */
export const LOAD_LIMITS = { vus: 100, seconds: 600 } as const;

export const LoadTestBody = z.object({
  name: z.string().trim().min(1).max(200),
  source: z.array(LoadSource).min(1).max(20),
  environmentId: z.uuid(),
  dataSetId: z.uuid().nullable().default(null),
  profile: z.enum(LOAD_PROFILES),
  /** Peak virtual users and total duration; the profile shapes how it ramps. */
  vus: z.number().int().min(1).max(10_000),
  seconds: z.number().int().min(5).max(86_400),
  thresholds: LoadThresholds.default(LoadThresholds.parse({})),
  /** Stop on its own when the error rate or latency goes past these. */
  abort: z.object({ errorPercent: z.number().min(1).max(100).default(50), p95Ms: z.number().int().min(100).max(300_000).nullable().default(null) }).default({ errorPercent: 50, p95Ms: null }),
});
export type LoadTestBody = z.infer<typeof LoadTestBody>;

export interface LoadStage {
  /** Seconds from the start. */
  at: number;
  vus: number;
}

export interface LoadEndpointStats {
  key: string;
  name: string;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface LoadSecond {
  t: number;
  vus: number;
  rps: number;
  errors: number;
  p95: number;
}

export interface LoadMetrics {
  requests: number;
  errors: number;
  errorPercent: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  bytes: number;
  endpoints: LoadEndpointStats[];
  timeline: LoadSecond[];
}

export interface LoadVerdict {
  name: string;
  passed: boolean;
  detail: string;
}

export interface LoadRunView {
  id: string;
  loadTestId: string;
  status: 'running' | 'passed' | 'failed' | 'aborted' | 'error' | 'cancelled';
  host: string;
  metrics: LoadMetrics;
  verdicts: LoadVerdict[];
  /** Against the run before it: positive is slower or worse. */
  compare: { previousId: string; p95Delta: number; errorDelta: number; rpsDelta: number } | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ApiLoadTest {
  id: string;
  name: string;
  body: LoadTestBody;
  lastRun: { id: string; status: LoadRunView['status']; p95: number; rps: number; finishedAt: string | null } | null;
  updatedAt: string;
}

export const LoadRunBody = z.object({ productionOverride: z.boolean().default(false) });
