'use client';

import type { ApiEnvironment, ApiLoadTest, ApiNode, ApiNodeDetail, ApiSpecSummary, ApiSuite, ApiWorkflow, ApiWorkflowSummary, ApiWorkspace, HistoryDetail, HistoryEntry } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get, qs } from '@/lib/api';
import { ago } from '@/lib/format';
import { AssistantView } from './AssistantView';
import { ContainerEditor } from './ContainerEditor';
import { EnvironmentsDialog } from './EnvironmentsDialog';
import { MapView } from './MapView';
import { METHOD_SHORT, pathTo, prettyBody, statusTone } from './model';
import { RequestEditor } from './RequestEditor';
import { SpecList, SpecUploadDialog, SpecView } from './Specs';
import { ImportDialog } from './Transfer';
import { LoadView, newLoadTest } from './LoadView';
import { newSuite, SuiteView } from './SuitesView';
import { Tree } from './Tree';
import { WorkflowEditor } from './WorkflowEditor';
import s from './apistudio.module.css';

type Side = 'collections' | 'workflows' | 'suites' | 'specs' | 'history';

/**
 * API Studio (docs/api-testing-plan.md): workspaces of collections, folders and requests sent through
 * the server, environments, and the project's spec library. Everything that picks a view is in the URL.
 */
export function ApiStudioScreen() {
  const { project, can } = useSession();
  const { notify } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const canEdit = can('run.execute');
  const [envOpen, setEnvOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const side = (params.get('side') as Side | null) ?? 'collections';
  const nodeId = params.get('node');
  const variationId = params.get('var');
  const specId = params.get('spec');
  const historyId = params.get('h');
  const workflowId = params.get('wf');
  const suiteId = params.get('suite');
  const loadId = params.get('load');
  const mainView = params.get('view');
  // Reads the live URL, not this render's params: router.replace lands asynchronously, so a second
  // change made before it lands (pick an environment, then create a collection) would undo the first.
  const go = (next: Record<string, string | null>) => {
    const now = new URLSearchParams(window.location.search);
    const keep = Object.fromEntries(['ws', 'env', 'side', 'node', 'var', 'spec', 'h', 'wf', 'view', 'suite', 'load'].map((k) => [k, now.get(k)]));
    router.replace(`/api${qs({ ...keep, ...next })}`);
  };

  const projectBase = `/projects/${project.id}/apitest`;
  const workspaces = useQuery({ queryKey: ['apitest', 'workspaces', project.id], queryFn: () => get<ApiWorkspace[]>(`${projectBase}/workspaces`) });
  const ws = workspaces.data?.find((w) => w.id === params.get('ws')) ?? workspaces.data?.[0] ?? null;
  const base = ws ? `${projectBase}/workspaces/${ws.id}` : '';

  const tree = useQuery({ queryKey: ['apitest', 'tree', ws?.id], queryFn: () => get<ApiNode[]>(`${base}/tree`), enabled: !!ws });
  const envs = useQuery({ queryKey: ['apitest', 'envs', ws?.id], queryFn: () => get<ApiEnvironment[]>(`${base}/environments`), enabled: !!ws });
  const specs = useQuery({ queryKey: ['apitest', 'specs', project.id], queryFn: () => get<ApiSpecSummary[]>(`${projectBase}/specs`) });
  const workflows = useQuery({ queryKey: ['apitest', 'workflows', ws?.id], queryFn: () => get<ApiWorkflowSummary[]>(`${base}/workflows`), enabled: !!ws && side === 'workflows' });
  const suites = useQuery({ queryKey: ['apitest', 'suites', ws?.id], queryFn: () => get<ApiSuite[]>(`${base}/suites`), enabled: !!ws && side === 'suites' });
  const loadTests = useQuery({ queryKey: ['apitest', 'load-tests', ws?.id], queryFn: () => get<ApiLoadTest[]>(`${base}/load-tests`), enabled: !!ws && side === 'suites' });
  const history = useQuery({ queryKey: ['apitest', 'history', ws?.id], queryFn: () => get<HistoryEntry[]>(`${base}/history`), enabled: !!ws && side === 'history' });
  const node = useQuery({
    queryKey: ['apitest', 'node', ws?.id, nodeId],
    queryFn: () => get<ApiNodeDetail>(`${base}/nodes/${nodeId}`),
    enabled: !!ws && !!nodeId,
  });
  const env = envs.data?.find((e) => e.id === params.get('env')) ?? null;

  const crumbs = useMemo(() => {
    if (!tree.data || !nodeId) return [];
    const byId = new Map(tree.data.map((n) => [n.id, n.name]));
    return pathTo(tree.data, nodeId).slice(0, -1).map((id) => byId.get(id) ?? '');
  }, [tree.data, nodeId]);

  const newWorkspace = async () => {
    const name = window.prompt('Workspace name', ws ? '' : `${project.key} APIs`);
    if (!name?.trim()) return;
    const personal = window.confirm('Make it a personal workspace only you can see?\n\nOK = personal, Cancel = shared with the project team.');
    try {
      const created = await api<ApiWorkspace>('POST', `${projectBase}/workspaces`, { name: name.trim(), kind: personal ? 'personal' : 'team' });
      await queryClient.invalidateQueries({ queryKey: ['apitest', 'workspaces', project.id] });
      go({ ws: created.id, node: null, var: null, env: null });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the workspace', 'bad');
    }
  };
  const newCollection = async () => {
    const name = window.prompt('Collection name', 'New collection');
    if (!name?.trim() || !ws) return;
    const created = await api<ApiNodeDetail>('POST', `${base}/nodes`, { kind: 'collection', name: name.trim() });
    await queryClient.invalidateQueries({ queryKey: ['apitest', 'tree', ws.id] });
    go({ node: created.id, var: null, side: 'collections', spec: null, h: null });
  };

  const newWorkflow = async () => {
    const name = window.prompt('Workflow name', 'New workflow');
    if (!name?.trim() || !ws) return;
    try {
      const created = await api<ApiWorkflow>('POST', `${base}/workflows`, { name: name.trim(), def: { steps: [], teardown: [], variables: [] } });
      await queryClient.invalidateQueries({ queryKey: ['apitest', 'workflows', ws.id] });
      go({ wf: created.id, view: null, side: 'workflows' });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the workflow', 'bad');
    }
  };

  const makeSuite = async () => {
    const name = window.prompt('Suite name', 'Smoke');
    if (!name?.trim() || !ws) return;
    try {
      const created = await newSuite(base, name.trim(), tree.data ?? []);
      await queryClient.invalidateQueries({ queryKey: ['apitest', 'suites', ws.id] });
      go({ suite: created.id, side: 'suites', view: null });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the suite', 'bad');
    }
  };

  const makeLoadTest = async () => {
    const name = window.prompt('Load test name', 'Peak traffic');
    if (!name?.trim() || !ws) return;
    try {
      const created = await newLoadTest(base, name.trim(), tree.data ?? [], envs.data ?? []);
      await queryClient.invalidateQueries({ queryKey: ['apitest', 'load-tests', ws.id] });
      go({ load: created.id, suite: null, side: 'suites', view: null });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the load test', 'bad');
    }
  };

  if (workspaces.error) return <div className="empty t3" style={{ flex: 1 }}>{workspaces.error instanceof ApiError ? workspaces.error.message : 'Could not load API Studio.'}</div>;

  const main = () => {
    if (mainView === 'assistant')
      return <AssistantView projectBase={projectBase} base={ws ? base : null} workspaceId={ws?.id ?? null} historyId={historyId} canEdit={canEdit} onOpenWorkflow={(id) => go({ view: null, wf: id, side: 'workflows' })} />;
    if (mainView === 'map')
      return <MapView projectId={project.id} workspaceId={ws?.id ?? null} canEdit={canEdit} onWorkflow={(id) => go({ view: null, wf: id, side: 'workflows' })} />;
    if (side === 'suites' && loadId && ws)
      return <LoadView key={loadId} base={base} projectBase={projectBase} workspaceId={ws.id} testId={loadId} nodes={tree.data ?? []} environments={envs.data ?? []} canEdit={canEdit} canOverride={can('project.manage')} onDeleted={() => go({ load: null })} />;
    if (side === 'suites' && suiteId && ws)
      return <SuiteView key={suiteId} base={base} projectBase={projectBase} workspaceId={ws.id} suiteId={suiteId} nodes={tree.data ?? []} environments={envs.data ?? []} canEdit={canEdit} onDeleted={() => go({ suite: null })} />;
    if (side === 'workflows' && workflowId && ws)
      return <WorkflowEditor key={workflowId} base={base} workspaceId={ws.id} workflowId={workflowId} nodes={tree.data ?? []} environmentId={env?.id ?? null} canEdit={canEdit} onDeleted={() => go({ wf: null })} />;
    if (side === 'specs' && specId)
      return <SpecView key={specId} projectId={project.id} specId={specId} workspaceId={ws?.id ?? null} canEdit={canEdit} canOverride={can('project.manage')} onImported={(id) => go({ side: 'collections', node: id, spec: null })} onDeleted={() => go({ spec: null })} />;
    if (side === 'history' && historyId && ws) return <HistoryView base={base} id={historyId} />;
    if (!ws) {
      return (
        <div className="empty" style={{ flex: 1 }}>
          <Icon name="plug" size={22} />
          <div className="h1" style={{ fontSize: 16 }}>API Studio</div>
          <div className="t2" style={{ maxWidth: 480 }}>Build and send API requests, keep them in collections your team shares, and bring in your OpenAPI specs. Start with a workspace.</div>
          {canEdit && <button className="btn primary" onClick={newWorkspace}><Icon name="plus" size={13} />New workspace</button>}
        </div>
      );
    }
    if (nodeId && node.error) return <div className="empty t3" style={{ flex: 1 }}>{node.error instanceof ApiError ? node.error.message : 'Could not load this item.'}</div>;
    if (nodeId && node.data?.kind === 'request')
      return <RequestEditor key={node.data.id} base={base} workspaceId={ws.id} node={node.data} crumbs={crumbs} environmentId={env?.id ?? null} variationId={variationId} onVariation={(v) => go({ var: v })} canEdit={canEdit} />;
    if (nodeId && node.data) return <ContainerEditor key={node.data.id} base={base} workspaceId={ws.id} node={node.data} canEdit={canEdit} />;
    if (nodeId) return <div className="empty t3" style={{ flex: 1 }}>Loading…</div>;
    return (
      <div className="empty" style={{ flex: 1 }}>
        <Icon name="play" size={22} />
        <div className="t2" style={{ maxWidth: 460 }}>
          Pick a request, or make a collection. Use <span className="mono">{'{{baseUrl}}'}</span> and other variables from an environment, and add checks so each send tells you whether the API behaved.
        </div>
      </div>
    );
  };

  return (
    <div className={s.layout}>
      <aside className={s.side} aria-label="API Studio">
        <div className={s.sideTop}>
          <div style={{ display: 'flex', gap: 6 }}>
            <select className="inp" style={{ flex: 1 }} value={ws?.id ?? ''} aria-label="Workspace" onChange={(e) => go({ ws: e.target.value, node: null, var: null, env: null, h: null })}>
              {!ws && <option value="">No workspace yet</option>}
              {workspaces.data?.map((w) => <option key={w.id} value={w.id}>{w.name}{w.kind === 'personal' ? ' (personal)' : ''}</option>)}
            </select>
            {canEdit && <button className="btn" aria-label="New workspace" title="New workspace" onClick={newWorkspace}><Icon name="plus" size={13} /></button>}
            <button className={`btn ${mainView === 'assistant' ? 'primary' : ''}`} aria-label="API assistant" title="Explain routes, find the calls for a requirement, ask about your APIs" onClick={() => go({ view: mainView === 'assistant' ? null : 'assistant' })}><Icon name="sparkle" size={13} /></button>
          </div>
          {ws && (
            <div style={{ display: 'flex', gap: 6 }}>
              <select className="inp" style={{ flex: 1 }} value={env?.id ?? ''} aria-label="Environment" onChange={(e) => go({ env: e.target.value || null })}>
                <option value="">No environment</option>
                {envs.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
              <button className="btn" onClick={() => setEnvOpen(true)} title="Environments, variables, auth profiles and certificates" aria-label="Workspace settings"><Icon name="gear" size={13} /></button>
            </div>
          )}
        </div>
        <div className={`tabs ${s.sideTabs}`} role="tablist" aria-label="Sidebar">
          {(['collections', 'workflows', 'suites', 'specs', 'history'] as Side[]).map((t) => (
            <button key={t} role="tab" aria-selected={side === t} className={`tab ${side === t ? 'on' : ''}`} onClick={() => go({ side: t, view: null })}>
              {{ collections: 'Requests', workflows: 'Flows', suites: 'Suites', specs: 'Specs', history: 'History' }[t]}
              {t === 'specs' && specs.data?.length ? <span className="n">{specs.data.length}</span> : null}
            </button>
          ))}
          <div className="f1" />
        </div>
        {((canEdit && (side === 'collections' || side === 'suites' ? !!ws : side === 'specs')) || side === 'workflows' || side === 'specs') && (
          <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--soft)' }}>
            {side === 'workflows' && ws && canEdit && <button className="btn sm" onClick={newWorkflow}><Icon name="plus" size={12} />Workflow</button>}
            {side === 'suites' && ws && canEdit && <button className="btn sm" onClick={makeSuite}><Icon name="plus" size={12} />Suite</button>}
            {side === 'suites' && ws && canEdit && <button className="btn sm" onClick={makeLoadTest} title="Send a request many times at once and measure how the API holds up"><Icon name="plus" size={12} />Load test</button>}
            {(side === 'workflows' || side === 'specs') && <button className={`btn sm ${mainView === 'map' ? 'primary' : ''}`} onClick={() => go({ view: mainView === 'map' ? null : 'map' })} title="Which API feeds which, the order to call them, and suggested workflows"><Icon name="tree" size={12} />Project map</button>}
            {side === 'collections' && <button className="btn sm" onClick={newCollection}><Icon name="plus" size={12} />Collection</button>}
            {side === 'collections' && <button className="btn sm" onClick={() => setImportOpen(true)} title="Import a Postman collection or environment, or a cURL command">Import</button>}
            {side === 'specs' && canEdit && <button className="btn sm" onClick={() => setUploadOpen(true)}><Icon name="plus" size={12} />Spec</button>}
          </div>
        )}
        <div className={s.sideBody}>
          {side === 'collections' && ws && tree.data && (
            tree.data.length ? (
              <Tree base={base} workspaceId={ws.id} nodes={tree.data} selectedId={nodeId} onSelect={(id) => go({ node: id, var: null })} canEdit={canEdit} />
            ) : (
              <div className="empty t3" style={{ padding: 20, fontSize: 12.5 }}>
                <Icon name="layers" size={20} />
                <div>No collections yet.</div>
                <div>Make one, or add a spec and make requests from its operations.</div>
              </div>
            )
          )}
          {side === 'workflows' && ws && (
            workflows.data?.length ? (
              workflows.data.map((w) => (
                <button key={w.id} className={`${s.row} ${workflowId === w.id && mainView !== 'map' ? s.on : ''}`} style={{ height: 'auto', padding: '8px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => go({ wf: w.id, view: null })}>
                  <b className="trunc" style={{ maxWidth: '100%' }}>{w.name}</b>
                  <span className="t3" style={{ fontSize: 11.5 }}>
                    {w.stepCount} steps · v{w.version}
                    {w.needsReview > 0 && <> · <span className={s.fail}>{w.needsReview} need review</span></>}
                    {w.lastRun && <> · last run <span className={w.lastRun.status === 'passed' ? s.pass : w.lastRun.status === 'failed' || w.lastRun.status === 'error' ? s.fail : ''}>{w.lastRun.status}</span></>}
                  </span>
                </button>
              ))
            ) : workflows.data ? (
              <div className="empty t3" style={{ padding: 20, fontSize: 12.5 }}>
                <Icon name="tree" size={20} />
                <div>No workflows yet.</div>
                <div>A workflow calls requests in order and passes values along: log in, create, read, delete. Open the Project map to have one made from your specs.</div>
              </div>
            ) : null
          )}
          {side === 'suites' && ws && (
            suites.data?.length ? (
              suites.data.map((x) => (
                <button key={x.id} className={`${s.row} ${suiteId === x.id && !loadId ? s.on : ''}`} style={{ height: 'auto', padding: '8px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => go({ suite: x.id, load: null, view: null })}>
                  <b className="trunc" style={{ maxWidth: '100%' }}>{x.name}</b>
                  <span className="t3" style={{ fontSize: 11.5 }}>
                    {x.lastRun ? <span className={x.lastRun.status === 'passed' ? s.pass : x.lastRun.status === 'running' ? '' : s.fail}>{x.lastRun.status}</span> : 'not run yet'}
                    {x.lastRun && ` · ${x.lastRun.totals.passed + x.lastRun.totals.flaky}/${x.lastRun.totals.total}`}
                    {(x.schedule.cron || x.schedule.monitor) && ' · scheduled'}
                  </span>
                </button>
              ))
            ) : suites.data ? (
              <div className="empty t3" style={{ padding: 20, fontSize: 12.5 }}>
                <Icon name="runs" size={20} />
                <div>No suites yet.</div>
                <div>A suite runs requests, variations and workflows together, by hand, on a schedule, as a monitor or from CI.</div>
              </div>
            ) : null
          )}
          {side === 'suites' && ws && loadTests.data && loadTests.data.length > 0 && (
            <>
              <div className="flab" style={{ padding: '10px 12px 2px' }}>Load tests</div>
              {loadTests.data.map((x) => (
                <button key={x.id} className={`${s.row} ${loadId === x.id ? s.on : ''}`} style={{ height: 'auto', padding: '8px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => go({ load: x.id, suite: null, view: null })}>
                  <b className="trunc" style={{ maxWidth: '100%' }}>{x.name}</b>
                  <span className="t3" style={{ fontSize: 11.5 }}>
                    {x.lastRun ? <span className={x.lastRun.status === 'passed' ? s.pass : x.lastRun.status === 'running' ? '' : s.fail}>{x.lastRun.status}</span> : 'not run yet'}
                    {x.lastRun && ` · p95 ${x.lastRun.p95} ms · ${x.lastRun.rps}/s`}
                  </span>
                </button>
              ))}
            </>
          )}
          {side === 'specs' && specs.data && <SpecList specs={specs.data} selectedId={specId} onSelect={(id) => go({ spec: id })} />}
          {side === 'history' && ws && (
            <>
              {history.data?.length ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 8px' }}>
                  <button className="btn ghost sm" onClick={async () => { await api('DELETE', `${base}/history`); history.refetch(); go({ h: null }); }}>Clear</button>
                </div>
              ) : null}
              {history.data?.map((e) => (
                <button key={e.id} className={`${s.row} ${historyId === e.id ? s.on : ''}`} style={{ height: 'auto', padding: '6px 10px', flexDirection: 'column', alignItems: 'stretch', gap: 2 }} onClick={() => go({ h: e.id })}>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className={`${s.method} ${s[`m-${e.method}`]}`}>{METHOD_SHORT[e.method]}</span>
                    <span className={`${s.status} ${s[`t-${statusTone(e.status)}`]}`} style={{ fontSize: 11.5 }}>{e.status ?? 'ERR'}</span>
                    <span className="t3" style={{ marginLeft: 'auto', fontSize: 11 }}>{ago(e.createdAt)}</span>
                  </span>
                  <span className="mono trunc t2" style={{ fontSize: 11.5 }}>{e.url}</span>
                </button>
              ))}
              {history.data?.length === 0 && <div className="empty t3" style={{ padding: 20, fontSize: 12.5 }}>Your sends from this workspace show up here, with secrets masked.</div>}
            </>
          )}
        </div>
      </aside>
      <section className={s.main}>{main()}</section>
      {envOpen && ws && <EnvironmentsDialog key={ws.id} base={base} projectBase={projectBase} workspace={ws} environments={envs.data ?? []} activeId={env?.id ?? null} canEdit={canEdit} requests={(tree.data ?? []).filter((n) => n.kind === 'request')} onClose={() => setEnvOpen(false)} />}
      {importOpen && ws && (
        <ImportDialog
          base={base}
          workspaceId={ws.id}
          containers={(tree.data ?? []).filter((n) => n.kind !== 'request')}
          defaultParent={node.data && node.data.kind !== 'request' ? node.data.id : (node.data?.parentId ?? null)}
          onClose={() => setImportOpen(false)}
          onDone={(r) => {
            setImportOpen(false);
            if (r.kind === 'environment') go({ env: r.id });
            else go({ node: r.id, var: null, side: 'collections' });
          }}
        />
      )}
      {uploadOpen && <SpecUploadDialog projectId={project.id} onClose={() => setUploadOpen(false)} onDone={(id) => { setUploadOpen(false); go({ side: 'specs', spec: id }); }} />}
    </div>
  );
}

/** A past send, read-only: what went out and what came back, as stored (secrets masked). */
function HistoryView({ base, id }: { base: string; id: string }) {
  const h = useQuery({ queryKey: ['apitest', 'history-entry', id], queryFn: () => get<HistoryDetail>(`${base}/history/${id}`) });
  if (h.error) return <div className="empty t3" style={{ flex: 1 }}>{h.error instanceof ApiError ? h.error.message : 'Could not load it.'}</div>;
  if (!h.data) return <div className="empty t3" style={{ flex: 1 }}>Loading…</div>;
  const d = h.data;
  return (
    <div style={{ overflow: 'auto', flex: 1 }}>
      <div className={s.bar}>
        <span className={`${s.method} ${s[`m-${d.method}`]}`}>{d.method}</span>
        <span className="mono trunc" style={{ flex: 1 }}>{d.url}</span>
        <span className={`${s.status} ${s[`t-${statusTone(d.status)}`]}`}>{d.status ?? 'No response'}</span>
        <span className="t2">{d.durationMs} ms</span>
      </div>
      {d.error && <div className={s.notice}><Icon name="alert" size={14} />{d.error}</div>}
      <div className={s.pane} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section>
          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Sent</h3>
          {d.request.headers.map(([k, v], i) => <div key={i} className="mono" style={{ fontSize: 12 }}><span className="t2">{k}:</span> {v}</div>)}
          {d.request.body && <pre className={s.pre} style={{ marginTop: 8 }}>{prettyBody(d.request.body, null)}</pre>}
        </section>
        {d.response && (
          <section>
            <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Received{d.response.truncated ? ' (first 64 KB)' : ''}</h3>
            {d.response.headers.map(([k, v], i) => <div key={i} className="mono" style={{ fontSize: 12 }}><span className="t2">{k}:</span> {v}</div>)}
            {d.response.bodyEncoding === 'utf8' && <pre className={s.pre} style={{ marginTop: 8 }}>{prettyBody(d.response.body, d.response.contentType)}</pre>}
          </section>
        )}
      </div>
    </div>
  );
}
