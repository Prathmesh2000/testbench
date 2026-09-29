'use client';

import Editor, { loader, type Monaco, type OnMount } from '@monaco-editor/react';
import { CODE_PATH, type AutoRun, type AutoRunDetail, type CodeFile, type SavedCodeFile } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { usePrefs, useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago, bytes } from '@/lib/format';
import { SitePane } from './SitePane';
import s from './ide.module.css';

// ponytail: Monaco loads from jsDelivr at the version matching our installed types; bundle it
// locally (monaco-editor + worker setup) when the platform must work fully offline.
loader.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });

const ROOTS = ['tests', 'pages', 'fixtures', 'utils', 'data'] as const;
const LAST_URL = 'tb.ide.baseUrl';
const uri = (path: string) => `file:///${path}`;
const isSpec = (path: string) => /^tests\/.+\.spec\.ts$/.test(path);
const langOf = (path: string) => (path.endsWith('.json') ? 'json' : 'typescript');

interface Problem {
  path: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

// ---------- Monaco setup (once per page) ----------

let configured: Promise<void> | null = null;
/**
 * TypeScript in the editor behaves like a Playwright project: strict, ES modules, node-style
 * resolution, with Playwright's own declaration files, so `page.`, `expect(` and imports between
 * workspace files complete and type-check as they would locally.
 */
function configure(monaco: Monaco): Promise<void> {
  configured ??= (async () => {
    const ts = monaco.languages.typescript;
    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      strict: true,
      esModuleInterop: true,
      allowNonTsExtensions: true,
      baseUrl: 'file:///',
      lib: ['es2022', 'dom'],
    });
    ts.typescriptDefaults.setEagerModelSync(true);
    const libs = await fetch('/api/playwright-types').then((r) => r.json() as Promise<{ path: string; content: string }[]>);
    for (const l of libs) ts.typescriptDefaults.addExtraLib(l.content, l.path);
  })();
  return configured;
}

// ---------- file tree ----------

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: string[];
}

function buildTree(paths: string[]): Folder[] {
  const roots = new Map<string, Folder>(ROOTS.map((r) => [r, { name: r, path: r, folders: new Map(), files: [] }]));
  for (const p of paths) {
    const parts = p.split('/');
    let node: Folder | undefined = roots.get(parts[0]!);
    if (!node) continue;
    for (const seg of parts.slice(1, -1)) {
      const child: Folder = node.folders.get(seg) ?? { name: seg, path: `${node.path}/${seg}`, folders: new Map(), files: [] };
      node.folders.set(seg, child);
      node = child;
    }
    node.files.push(p);
  }
  return [...roots.values()];
}

/**
 * The code workspace as an IDE (testing-studio-plan §3.7): an explorer of the framework's folders,
 * Monaco with Playwright types, and a panel that runs the current spec or the whole suite headless.
 */
export function Ide({ header, initial }: { header: React.ReactNode; initial?: string | null }) {
  const [siteOpen, setSiteOpen] = useState(false);
  const { project, can } = useSession();
  const { theme } = usePrefs();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const all = useQuery({ queryKey: ['studio-code-all', project.id], queryFn: () => get<CodeFile[]>(`/projects/${project.id}/studio/code?content=1`) });
  // Last saved state per file, and unsaved edits on top of it.
  const [saved, setSaved] = useState<Record<string, { content: string; version: number }>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const monacoRef = useRef<Monaco | null>(null);
  // Monaco loads asynchronously; files can arrive before it exists, so model sync waits for this.
  const [ready, setReady] = useState(false);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const editable = can('run.execute');

  useEffect(() => {
    if (!all.data) return;
    setSaved(Object.fromEntries(all.data.map((f) => [f.path, { content: f.content, version: f.version }])));
    if (!active && all.data.length) {
      const first = all.data.find((f) => f.path === initial) ?? all.data.find((f) => isSpec(f.path)) ?? all.data[0]!;
      setOpen([first.path]);
      setActive(first.path);
    }
    // Only the first load picks the starting file; later refetches must not move the tester.
  }, [all.data]);

  const contentOf = useCallback((path: string) => drafts[path] ?? saved[path]?.content ?? '', [drafts, saved]);
  const dirty = (path: string) => path in drafts && drafts[path] !== saved[path]?.content;

  /** Every workspace file is a model, so `import { LoginPage } from '../pages/LoginPage'` resolves. */
  const syncModels = useCallback(() => {
    const monaco = monacoRef.current;
    if (!monaco || !ready) return;
    for (const path of Object.keys(saved)) {
      const u = monaco.Uri.parse(uri(path));
      const model = monaco.editor.getModel(u);
      if (!model) monaco.editor.createModel(contentOf(path), langOf(path), u);
    }
  }, [saved, contentOf, ready]);
  useEffect(syncModels, [syncModels]);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setReady(true);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    const collect = () =>
      setProblems(
        monaco.editor
          .getModelMarkers({})
          .filter((m) => m.resource.scheme === 'file' && !m.resource.path.startsWith('/node_modules/'))
          .map((m) => ({
            path: m.resource.path.slice(1),
            line: m.startLineNumber,
            column: m.startColumn,
            message: m.message,
            severity: m.severity >= monaco.MarkerSeverity.Error ? ('error' as const) : ('warning' as const),
          })),
      );
    monaco.editor.onDidChangeMarkers(collect);
  };

  const openFile = (path: string) => {
    setOpen((o) => (o.includes(path) ? o : [...o, path]));
    setActive(path);
  };
  const closeTab = (path: string) => {
    if (dirty(path) && !confirm(`${path} has unsaved changes. Close it anyway?`)) return;
    setOpen((o) => o.filter((p) => p !== path));
    setDrafts(({ [path]: _, ...rest }) => rest);
    monacoRef.current?.editor.getModel(monacoRef.current.Uri.parse(uri(path)))?.setValue(saved[path]?.content ?? '');
    if (active === path) setActive(open.filter((p) => p !== path).at(-1) ?? null);
  };

  const save = async (path = active) => {
    if (!path || !editable) return;
    const content = contentOf(path);
    try {
      const res = await api<SavedCodeFile>('PUT', `/projects/${project.id}/studio/code/file`, { path, content, baseVersion: saved[path]?.version });
      setSaved((all) => ({ ...all, [path]: { content, version: res.file.version } }));
      setDrafts(({ [path]: _, ...rest }) => rest);
      notify(res.diagnostics.length ? `Saved with ${res.diagnostics.length} syntax problem${res.diagnostics.length === 1 ? '' : 's'}` : `Saved ${path}`, res.diagnostics.length ? 'bad' : undefined);
      await queryClient.invalidateQueries({ queryKey: ['studio-code', project.id] });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save', 'bad');
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const saveAll = async () => {
    for (const p of open.filter(dirty)) await save(p);
  };

  const createFile = async (path: string) => {
    if (!CODE_PATH.test(path)) return notify('Use letters, digits, - and _, ending in .ts or .json, e.g. tests/cart.spec.ts', 'bad');
    if (saved[path]) return openFile(path);
    const content = isSpec(path)
      ? "import { expect, test } from '../fixtures';\nimport { url } from '../utils/env';\n\ntest('what this proves', async ({ page }) => {\n  await page.goto(url('/'));\n  await expect(page).toHaveTitle(/.+/);\n});\n"
      : path.startsWith('pages/')
        ? `import type { Page } from '@playwright/test';\n\nexport class ${path.split('/').pop()!.replace(/\.ts$/, '').replace(/[^A-Za-z0-9_]/g, '')} {\n  constructor(readonly page: Page) {}\n}\n`
        : path.endsWith('.json')
          ? '{}\n'
          : '';
    try {
      const res = await api<SavedCodeFile>('PUT', `/projects/${project.id}/studio/code/file`, { path, content });
      setSaved((all) => ({ ...all, [path]: { content, version: res.file.version } }));
      openFile(path);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the file', 'bad');
    }
  };
  const renameFile = async (from: string, to: string) => {
    if (dirty(from)) return notify('Save the file before renaming it', 'bad');
    try {
      await api('POST', `/projects/${project.id}/studio/code/rename`, { from, to });
      monacoRef.current?.editor.getModel(monacoRef.current.Uri.parse(uri(from)))?.dispose();
      setSaved(({ [from]: moved, ...rest }) => ({ ...rest, [to]: moved! }));
      setOpen((o) => o.map((p) => (p === from ? to : p)));
      if (active === from) setActive(to);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not rename', 'bad');
    }
  };
  const deleteFile = async (path: string) => {
    if (!confirm(`Delete ${path}? Runs already started keep their copy.`)) return;
    try {
      await api('DELETE', `/projects/${project.id}/studio/code/file?path=${encodeURIComponent(path)}`);
      monacoRef.current?.editor.getModel(monacoRef.current.Uri.parse(uri(path)))?.dispose();
      setSaved(({ [path]: _, ...rest }) => rest);
      setOpen((o) => o.filter((p) => p !== path));
      if (active === path) setActive(null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not delete', 'bad');
    }
  };
  const starter = async () => {
    try {
      await api('POST', `/projects/${project.id}/studio/code/starter`);
      await all.refetch();
      openFile('tests/example.spec.ts');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not add the starter framework', 'bad');
    }
  };

  const jump = (p: Problem) => {
    openFile(p.path);
    requestAnimationFrame(() => {
      editorRef.current?.setPosition({ lineNumber: p.line, column: p.column });
      editorRef.current?.revealLineInCenter(p.line);
      editorRef.current?.focus();
    });
  };

  const paths = useMemo(() => Object.keys(saved).sort(), [saved]);

  /** Drops a locator picked in the site pane straight into the editor at the cursor. */
  const insertAtCursor = (code: string) => {
    const editor = editorRef.current;
    if (!editor || !active) return;
    const pos = editor.getPosition();
    if (!pos) return;
    editor.executeEdits('tb-picker', [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: code }]);
    editor.focus();
  };

  return (
    <div className={s.ide} style={siteOpen ? { gridTemplateColumns: '240px minmax(0, 1fr) minmax(320px, 34%)' } : undefined}>
      <aside className={s.explorer}>
        {header}
        <Explorer paths={paths} active={active} editable={editable} dirty={dirty} onOpen={openFile} onCreate={createFile} onRename={renameFile} onDelete={deleteFile} onStarter={starter} />
      </aside>
      <div className={s.work}>
        <div className={s.tabs} role="tablist" aria-label="Open files">
          {open.map((p) => (
            <div key={p} className={`${s.tab} ${active === p ? s.on : ''}`} role="tab" aria-selected={active === p} onClick={() => setActive(p)} title={p}>
              <span className="mono">{p.split('/').pop()}</span>
              {dirty(p) ? <span className={s.dot} aria-label="Unsaved" /> : null}
              <button className="ib sm" aria-label={`Close ${p}`} onClick={(e) => { e.stopPropagation(); closeTab(p); }}><Icon name="x" size={10} /></button>
            </div>
          ))}
          <div className="f1" />
          <button className={`btn sm ${siteOpen ? 'primary' : ''}`} style={{ margin: 4 }} onClick={() => setSiteOpen((v) => !v)} title="Open your site beside the editor and pick locators from it">
            <Icon name="globe" size={11} />Site
          </button>
          {open.some(dirty) && editable && <button className="btn sm" style={{ margin: 4 }} onClick={saveAll}>Save all</button>}
        </div>
        <div className={s.editor}>
          {active ? (
            <Editor
              path={uri(active)}
              defaultLanguage={langOf(active)}
              defaultValue={contentOf(active)}
              theme={theme === 'dark' ? 'vs-dark' : 'light'}
              beforeMount={(monaco) => {
                monacoRef.current = monaco;
                void configure(monaco);
              }}
              onMount={onMount}
              onChange={(v) => setDrafts((d) => ({ ...d, [active]: v ?? '' }))}
              options={{ readOnly: !editable, fontSize: 13, minimap: { enabled: false }, tabSize: 2, scrollBeyondLastLine: false, automaticLayout: true }}
            />
          ) : (
            <div className={s.empty}>{all.data?.length === 0 ? 'Empty workspace: add the starter framework from the explorer.' : 'Open a file from the explorer.'}</div>
          )}
        </div>
        <RunPanel active={active} specs={paths.filter(isSpec)} problems={problems} onJump={jump} beforeRun={saveAll} />
      </div>
      {siteOpen && <SitePane onInsert={insertAtCursor} />}
    </div>
  );
}

// ---------- explorer ----------

function Explorer({ paths, active, editable, dirty, onOpen, onCreate, onRename, onDelete, onStarter }: {
  paths: string[]; active: string | null; editable: boolean; dirty(p: string): boolean;
  onOpen(p: string): void; onCreate(p: string): void; onRename(from: string, to: string): void; onDelete(p: string): void; onStarter(): void;
}) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');

  const toggle = (p: string) => setClosed((c) => { const n = new Set(c); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  const renderFolder = (f: Folder, depth: number): React.ReactNode => {
    const isOpen = !closed.has(f.path);
    const pad = { paddingLeft: 8 + depth * 14 };
    return (
      <div key={f.path}>
        <div className={s.node} style={pad} onClick={() => toggle(f.path)} role="treeitem" aria-expanded={isOpen}>
          <span className={s.caret}>{isOpen ? '▾' : '▸'}</span>
          <span>{f.name}</span>
          {editable && (
            <span className={s.acts}>
              <button className="ib sm" title={`New file in ${f.path}/ (use a/b.ts for a subfolder)`} aria-label={`New file in ${f.path}`} onClick={(e) => { e.stopPropagation(); setAdding(f.path); setName(''); setClosed((c) => { const n = new Set(c); n.delete(f.path); return n; }); }}><Icon name="plus" size={11} /></button>
            </span>
          )}
        </div>
        {isOpen && (
          <>
            {adding === f.path && (
              <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate(`${f.path}/${name.trim()}`); setAdding(null); }} style={{ paddingLeft: pad.paddingLeft + 14 }}>
                <input autoFocus className={`inp mono ${s.inline}`} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setAdding(null)} placeholder={f.path === 'tests' ? 'cart.spec.ts' : f.path === 'pages' ? 'CartPage.ts' : 'name.ts'} aria-label="New file name" />
              </form>
            )}
            {[...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => renderFolder(c, depth + 1))}
            {f.files.sort().map((p) =>
              renaming === p ? (
                <form key={p} onSubmit={(e) => { e.preventDefault(); if (name.trim() && name.trim() !== p) onRename(p, name.trim()); setRenaming(null); }} style={{ paddingLeft: pad.paddingLeft + 14 }}>
                  <input autoFocus className={`inp mono ${s.inline}`} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(null)} aria-label="New path" />
                </form>
              ) : (
                <div key={p} className={`${s.node} ${active === p ? s.on : ''}`} style={{ paddingLeft: pad.paddingLeft + 16 }} onClick={() => onOpen(p)} role="treeitem">
                  <span className="mono trunc">{p.split('/').pop()}</span>
                  {dirty(p) && <span className={s.dot} aria-label="Unsaved" />}
                  {editable && (
                    <span className={s.acts}>
                      <button className="ib sm" aria-label={`Rename ${p}`} title="Rename or move" onClick={(e) => { e.stopPropagation(); setRenaming(p); setName(p); }}><Icon name="edit" size={11} /></button>
                      <button className="ib sm" aria-label={`Delete ${p}`} onClick={(e) => { e.stopPropagation(); onDelete(p); }}><Icon name="x" size={11} /></button>
                    </span>
                  )}
                </div>
              ),
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="hdr">
        <h3>Explorer</h3>
        <div className="f1" />
        {editable && <button className="btn sm" onClick={onStarter} title="Adds page object, fixtures, helpers and an example spec; never overwrites">Starter</button>}
      </div>
      <div className={s.tree} role="tree" aria-label="Workspace files">{tree.map((f) => renderFolder(f, 0))}</div>
    </>
  );
}

// ---------- run / problems panel ----------

function RunPanel({ active, specs, problems, onJump, beforeRun }: {
  active: string | null; specs: string[]; problems: Problem[]; onJump(p: Problem): void; beforeRun(): Promise<void>;
}) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const [view, setView] = useState<'run' | 'problems'>('run');
  const [height, setHeight] = useState(240);
  const [baseUrl, setBaseUrl] = useState(() => (typeof localStorage !== 'undefined' && localStorage.getItem(LAST_URL)) || 'https://');
  const [runId, setRunId] = useState<string | null>(null);
  const run = useQuery({
    queryKey: ['studio-run', runId],
    queryFn: () => get<AutoRunDetail>(`/projects/${project.id}/studio/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'queued' || q.state.data.status === 'running') ? 1_500 : false),
  });
  const errors = problems.filter((p) => p.severity === 'error').length;

  const start = async (specPaths: string[]) => {
    if (!/^https?:\/\/.+/.test(baseUrl)) return notify('Enter the address of the site to test', 'bad');
    try {
      localStorage.setItem(LAST_URL, baseUrl);
    } catch {
      // Storage can be unavailable (private mode); the address just isn't remembered.
    }
    await beforeRun();
    try {
      const started = await api<AutoRun>('POST', `/projects/${project.id}/studio/runs`, {
        name: specPaths.length === 1 ? specPaths[0] : `All specs (${specPaths.length})`,
        specPaths,
        baseUrl,
      });
      setRunId(started.id);
      setView('run');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not start the run', 'bad');
    }
  };

  // Drag the panel's top edge to resize it.
  const drag = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => setHeight(Math.min(Math.max(startH + (startY - ev.clientY), 120), 640));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const r = run.data;
  return (
    <div className={s.panel} style={{ height }}>
      <div onPointerDown={drag} style={{ height: 4, cursor: 'row-resize', marginTop: -2 }} aria-hidden />
      <div className={s.panelBar}>
        <button className={`chip ${view === 'run' ? 'on' : ''}`} onClick={() => setView('run')}>Run</button>
        <button className={`chip ${view === 'problems' ? 'on' : ''}`} onClick={() => setView('problems')}>Problems{problems.length ? ` (${problems.length})` : ''}</button>
        <div className="f1" />
        {can('run.create') && (
          <>
            <input className="inp" style={{ height: 26, width: 260, fontSize: 12 }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label="Site to test" placeholder="https://staging.example.com" />
            <button className="btn sm" disabled={!active || !isSpec(active)} onClick={() => active && start([active])} title={errors ? `${errors} type error(s) in the workspace` : undefined}><Icon name="play" size={11} />Run file</button>
            <button className="btn sm" disabled={!specs.length} onClick={() => start(specs)}><Icon name="play" size={11} />Run all ({specs.length})</button>
          </>
        )}
      </div>
      <div className={s.panelBody}>
        {view === 'problems' && (
          problems.length === 0 ? <span className="t3">No problems in open files.</span> : problems.map((p, n) => (
            <button key={n} className={s.problem} onClick={() => onJump(p)}>
              <span className={p.severity === 'error' ? 'err' : 't3'}>{p.severity === 'error' ? '✗' : '!'}</span>
              <span className="mono t3">{p.path}:{p.line}:{p.column}</span>
              <span className="f1">{p.message}</span>
            </button>
          ))
        )}
        {view === 'run' && !r && <span className="t3">Run the current spec or all specs against a site. Results, errors, screenshots and traces appear here.</span>}
        {view === 'run' && r && (
          <div>
            <div className="row" style={{ gap: 10, marginBottom: 6 }}>
              <span className="mono t3">{r.key}</span>
              <b>{r.status === 'queued' ? 'Waiting for a runner…' : r.status === 'running' ? 'Running…' : r.status === 'done' ? 'Finished' : 'Cancelled'}</b>
              <span className="t3">{r.counts.passed} passed · {r.counts.failed} failed{r.counts.flaky ? ` · ${r.counts.flaky} flaky` : ''} · {r.baseUrl} · {ago(r.createdAt)}</span>
            </div>
            {r.items.map((i) => (
              <div key={i.id}>
                <div className={s.result}>
                  <span className={i.status === 'passed' ? 'st st-passed' : i.status === 'failed' || i.status === 'error' ? 'st st-failed' : 'st st-untested'}>{i.status}{i.flaky ? ' · flaky' : ''}</span>
                  <span className="mono">{i.specPath ?? i.testKey}</span>
                  {i.attempt > 1 && <span className="t3">attempt {i.attempt}</span>}
                  {i.durationMs !== null && <span className="t3">{(i.durationMs / 1000).toFixed(1)} s</span>}
                </div>
                {i.steps.map((st, n) => (
                  <div key={n} className={s.result} style={{ paddingLeft: 20 }}>
                    <span>{st.status === 'passed' ? '✓' : st.status === 'skipped' ? '–' : '✗'}</span>
                    <span className="f1">{st.title}</span>
                    <span className="t3">{(st.durationMs / 1000).toFixed(1)} s</span>
                  </div>
                ))}
                {i.error && <pre className={s.err}>{i.error}</pre>}
                {i.evidence.length > 0 && (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', paddingLeft: 20, alignItems: 'flex-start' }}>
                    {i.evidence.filter((e) => e.kind === 'screenshot').map((e, n) => (
                      <a key={n} href={e.url} target="_blank" rel="noreferrer"><img src={e.url} alt="Screen at the end of the test" style={{ width: 200, borderRadius: 4, border: '1px solid var(--border)' }} /></a>
                    ))}
                    {i.evidence.filter((e) => e.kind === 'video').map((e, n) => <video key={n} src={e.url} controls preload="metadata" style={{ width: 280 }} />)}
                    {i.evidence.filter((e) => e.kind === 'trace').map((e, n) => (
                      <a key={n} className="pill" style={{ height: 24 }} href={`https://trace.playwright.dev/?trace=${encodeURIComponent(e.url)}`} target="_blank" rel="noreferrer"><Icon name="play" size={11} />Trace · {bytes(e.sizeBytes)}</a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
