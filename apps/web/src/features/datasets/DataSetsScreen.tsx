'use client';

import { MAX_DATA_ROWS, type DataFile, type DataSetDetail, type DataSetSummary } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago, bytes, fmt } from '@/lib/format';
import { parseTable, toCsv, type ParsedTable } from './parse';
import s from './datasets.module.css';

interface Draft extends ParsedTable {
  name: string;
  description: string;
}

const EMPTY: Draft = { name: '', description: '', columns: ['amount', 'vpa'], rows: [{ amount: '', vpa: '' }] };

/**
 * Test data library (data-driven testing). A data set is a table of inputs, built here, pasted from a
 * spreadsheet or imported from CSV/JSON, plus supporting files. Cases linked to it run once per row.
 */
export function DataSetsScreen() {
  const { project, can } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('set');
  const list = useQuery({ queryKey: ['data-sets', project.id], queryFn: () => get<DataSetSummary[]>(`/projects/${project.id}/data-sets`) });

  const select = (id: string | null) => router.replace(id ? `/data?set=${id}` : '/data');

  return (
    <div className={s.layout}>
      <aside className={s.list} aria-label="Data sets">
        <div className="hdr">
          <h3>Test data</h3>
          <div className="f1" />
          {can('case.write') && (
            <button className="btn sm primary" onClick={() => select('new')}><Icon name="plus" size={12} />New</button>
          )}
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {list.data?.map((d) => (
            <button key={d.id} className={`${s.item} ${selected === d.id ? s.on : ''}`} onClick={() => select(d.id)}>
              <b className="trunc">{d.name}</b>
              <span className="t3">{fmt(d.rowCount)} rows · {d.columns.length} columns · {d.caseCount} cases{d.fileCount ? ` · ${d.fileCount} files` : ''}</span>
              <span className="t3">Updated {ago(d.updatedAt)} by {d.updatedBy}</span>
            </button>
          ))}
          {list.data?.length === 0 && (
            <div className="empty t3" style={{ padding: 24, fontSize: 12.5 }}>
              <Icon name="rows" size={20} />
              <div>No test data yet.</div>
              <div>Make a table of inputs (amounts, VPAs, card numbers…) and link it to a case to run it once per row.</div>
            </div>
          )}
        </div>
      </aside>
      <section className={s.main}>
        {selected === 'new' && <DataSetEditor key="new" initial={null} onSaved={(id) => select(id)} />}
        {selected && selected !== 'new' && <DataSetLoader id={selected} onDeleted={() => select(null)} />}
        {!selected && (
          <div className="empty" style={{ flex: 1 }}>
            <Icon name="rows" size={22} />
            <div className="h1" style={{ fontSize: 16 }}>Data-driven testing</div>
            <div className="t2" style={{ maxWidth: 480 }}>
              Pick a data set, or create one. Use <span className="mono">{'{{column}}'}</span> in a case’s steps, link the data set on the case, and every run gets one item per row with its own result, evidence and bugs.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function DataSetLoader({ id, onDeleted }: { id: string; onDeleted(): void }) {
  const { project } = useSession();
  const detail = useQuery({ queryKey: ['data-set', project.id, id], queryFn: () => get<DataSetDetail>(`/projects/${project.id}/data-sets/${id}`) });
  if (detail.error) return <div className="empty t3" style={{ flex: 1 }}>{detail.error instanceof ApiError ? detail.error.message : 'Could not load this data set.'}</div>;
  if (!detail.data) return <div className="empty t3" style={{ flex: 1 }}>Loading…</div>;
  return <DataSetEditor key={`${id}:${detail.data.version}`} initial={detail.data} onSaved={() => {}} onDeleted={onDeleted} />;
}

/** The table editor: header row of column names, one input per cell, import/export, files and usage. */
function DataSetEditor({ initial, onSaved, onDeleted }: { initial: DataSetDetail | null; onSaved(id: string): void; onDeleted?(): void }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const editable = can('case.write');
  const [draft, setDraft] = useState<Draft>(
    initial ? { name: initial.name, description: initial.description, columns: initial.columns, rows: initial.rows } : EMPTY,
  );
  const [dirty, setDirty] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const change = (next: Draft) => {
    setDraft(next);
    setDirty(true);
  };
  const setCell = (row: number, col: string, value: string) =>
    change({ ...draft, rows: draft.rows.map((r, i) => (i === row ? { ...r, [col]: value } : r)) });
  const renameColumn = (index: number, name: string) => {
    const old = draft.columns[index]!;
    change({
      ...draft,
      columns: draft.columns.map((c, i) => (i === index ? name : c)),
      rows: draft.rows.map(({ [old]: value, ...rest }) => ({ ...rest, [name]: value ?? '' })),
    });
  };
  const addColumn = () => {
    let name = `column ${draft.columns.length + 1}`;
    for (let n = 2; draft.columns.includes(name); n++) name = `column ${draft.columns.length + n}`;
    change({ ...draft, columns: [...draft.columns, name], rows: draft.rows.map((r) => ({ ...r, [name]: '' })) });
  };
  const removeColumn = (index: number) => {
    const col = draft.columns[index]!;
    change({ ...draft, columns: draft.columns.filter((_, i) => i !== index), rows: draft.rows.map(({ [col]: _drop, ...rest }) => rest) });
  };
  const addRow = () => change({ ...draft, rows: [...draft.rows, Object.fromEntries(draft.columns.map((c) => [c, '']))] });
  const removeRow = (index: number) => change({ ...draft, rows: draft.rows.filter((_, i) => i !== index) });

  const importTable = (fileName: string, text: string) => {
    try {
      const table = parseTable(fileName, text);
      if (table.rows.length > MAX_DATA_ROWS) throw new Error(`That file has ${fmt(table.rows.length)} rows; a data set holds up to ${fmt(MAX_DATA_ROWS)}.`);
      change({ ...draft, ...table, name: draft.name || fileName.replace(/\.[^.]+$/, '') });
      notify(`Imported ${fmt(table.rows.length)} rows and ${table.columns.length} columns. Review, then save.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not read that file', 'bad');
    }
  };

  // A spreadsheet paste anywhere outside a cell replaces the table; inside a cell it stays a normal paste.
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (!editable || (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA' || !text.includes('\n')) return;
    e.preventDefault();
    importTable('pasted.tsv', text);
  };

  const save = async () => {
    setError(null);
    try {
      const body = { name: draft.name, description: draft.description, columns: draft.columns, rows: draft.rows };
      const saved = initial
        ? await api<{ id: string }>('PUT', `/projects/${project.id}/data-sets/${initial.id}`, body)
        : await api<{ id: string }>('POST', `/projects/${project.id}/data-sets`, body);
      await queryClient.invalidateQueries({ queryKey: ['data-sets', project.id] });
      await queryClient.invalidateQueries({ queryKey: ['data-set', project.id, saved.id] });
      setDirty(false);
      notify(`Saved ${draft.name}`);
      onSaved(saved.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };

  const remove = async () => {
    if (!initial) return;
    try {
      await api('DELETE', `/projects/${project.id}/data-sets/${initial.id}`);
      await queryClient.invalidateQueries({ queryKey: ['data-sets', project.id] });
      notify(`Deleted ${initial.name}`);
      onDeleted?.();
    } catch (err) {
      setConfirmDelete(false);
      notify(err instanceof ApiError ? err.message : 'Could not delete', 'bad');
    }
  };

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([toCsv(draft)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${draft.name || 'data'}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={s.editor} onPaste={onPaste}>
      <div className={s.head}>
        <div className="col f1" style={{ gap: 6, minWidth: 0 }}>
          <input className={`inp ${s.title}`} value={draft.name} placeholder="Data set name, e.g. UPI collect amounts" readOnly={!editable}
            onChange={(e) => change({ ...draft, name: e.target.value })} aria-label="Data set name" />
          <input className="inp" value={draft.description} placeholder="What this data covers (optional)" readOnly={!editable}
            onChange={(e) => change({ ...draft, description: e.target.value })} aria-label="Description" />
        </div>
        <div className="row" style={{ gap: 6, alignSelf: 'flex-start' }}>
          {editable && (
            <>
              <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,.json" hidden
                onChange={async (e) => { const f = e.target.files?.[0]; if (f) importTable(f.name, await f.text()); e.target.value = ''; }} />
              <button className="btn sm" onClick={() => fileInput.current?.click()} title="CSV, TSV or JSON; or paste from a spreadsheet">Import</button>
            </>
          )}
          <button className="btn sm" onClick={exportCsv}>Export CSV</button>
          {editable && <button className="btn sm primary" onClick={save} disabled={!dirty || !draft.name.trim()}>{initial ? 'Save' : 'Create'}</button>}
        </div>
      </div>
      {error && <div className="err" style={{ margin: '0 16px' }}>{error}</div>}

      <div className={s.gridWrap}>
        <table className={s.grid}>
          <thead>
            <tr>
              <th className={s.rowNo}>#</th>
              {draft.columns.map((c, i) => (
                <th key={i}>
                  <div className="row" style={{ gap: 2 }}>
                    <input className={s.colName} value={c} readOnly={!editable} onChange={(e) => renameColumn(i, e.target.value)} aria-label={`Column ${i + 1} name`} />
                    {editable && draft.columns.length > 1 && (
                      <button className="ib sm" onClick={() => removeColumn(i)} aria-label={`Remove column ${c}`}><Icon name="x" size={11} /></button>
                    )}
                  </div>
                  <span className={s.placeholder}>{`{{${c}}}`}</span>
                </th>
              ))}
              {editable && <th className={s.add}><button className="ib sm" onClick={addColumn} aria-label="Add a column"><Icon name="plus" size={12} /></button></th>}
            </tr>
          </thead>
          <tbody>
            {draft.rows.map((r, i) => (
              <tr key={i}>
                <td className={s.rowNo}>
                  {i + 1}
                  {editable && <button className={`ib sm ${s.delRow}`} onClick={() => removeRow(i)} aria-label={`Remove row ${i + 1}`}><Icon name="x" size={10} /></button>}
                </td>
                {draft.columns.map((c) => (
                  <td key={c}>
                    <input className={s.cell} value={r[c] ?? ''} readOnly={!editable} onChange={(e) => setCell(i, c, e.target.value)} aria-label={`Row ${i + 1}, ${c}`} />
                  </td>
                ))}
                {editable && <td />}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ gap: 10, padding: '8px 4px' }}>
          {editable && draft.rows.length < MAX_DATA_ROWS && <button className="btn sm ghost" onClick={addRow}><Icon name="plus" size={12} />Row</button>}
          <span className="t3" style={{ fontSize: 12 }}>{fmt(draft.rows.length)} rows · each becomes one run item per configuration{dirty ? ' · unsaved changes' : ''}</span>
        </div>
      </div>

      {initial && (
        <div className={s.foot}>
          <Files set={initial} />
          <div className="col" style={{ gap: 6, minWidth: 0 }}>
            <div className="sec">Used by {initial.caseCount} cases</div>
            {initial.cases.length === 0 && <div className="t3" style={{ fontSize: 12 }}>Open a case and pick this data set in its Data tab.</div>}
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {initial.cases.map((c) => <Link key={c.key} className="chip" href={`/cases/${c.key}`} title={c.title}><span className="mono">{c.key}</span></Link>)}
            </div>
            {editable && (
              <div style={{ marginTop: 'auto' }}>
                {confirmDelete ? (
                  <span className="row" style={{ gap: 6 }}>
                    <span className="t2" style={{ fontSize: 12 }}>Delete {initial.name}?</span>
                    <button className="btn sm danger" onClick={remove}>Delete</button>
                    <button className="btn sm" onClick={() => setConfirmDelete(false)}>Keep</button>
                  </span>
                ) : (
                  <button className="btn sm ghost" onClick={() => setConfirmDelete(true)}>Delete data set</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Supporting files (sample documents, images, fixtures) uploaded straight to storage. */
function Files({ set }: { set: DataSetDetail }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<DataFile[]>(set.files);
  useEffect(() => setFiles(set.files), [set.files]);

  const upload = async (list: FileList) => {
    setBusy(true);
    for (const file of Array.from(list)) {
      try {
        const up = await api<{ file: DataFile; uploadUrl: string }>('POST', `/projects/${project.id}/data-sets/${set.id}/files`, {
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        });
        const put = await fetch(up.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
        if (!put.ok) throw new Error(`upload failed (${put.status})`);
        setFiles((f) => [...f, up.file]);
      } catch (err) {
        notify(err instanceof ApiError ? err.message : `Could not upload ${file.name}`, 'bad');
      }
    }
    setBusy(false);
    await queryClient.invalidateQueries({ queryKey: ['data-sets', project.id] });
  };

  const remove = async (id: string) => {
    try {
      await api('DELETE', `/projects/${project.id}/data-sets/${set.id}/files/${id}`);
      setFiles((f) => f.filter((x) => x.id !== id));
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not remove the file', 'bad');
    }
  };

  return (
    <div className="col" style={{ gap: 6, minWidth: 0 }}>
      <div className="row" style={{ gap: 8 }}>
        <div className="sec">Files</div>
        <div className="f1" />
        {can('case.write') && (
          <>
            <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
            <button className="btn sm" onClick={() => input.current?.click()} disabled={busy}>
              <Icon name={busy ? 'refresh' : 'paperclip'} size={12} className={busy ? 'spin' : ''} />{busy ? 'Uploading…' : 'Add files'}
            </button>
          </>
        )}
      </div>
      {files.length === 0 && <div className="t3" style={{ fontSize: 12 }}>Sample documents, images or fixtures testers need for this data (up to 100 MB each).</div>}
      {files.map((f) => (
        <div key={f.id} className={s.file}>
          <Icon name="paperclip" size={12} />
          <a className="trunc f1" href={f.url} target="_blank" rel="noreferrer">{f.fileName}</a>
          <span className="t3">{bytes(f.sizeBytes)}</span>
          {can('case.write') && <button className="ib sm" onClick={() => remove(f.id)} aria-label={`Remove ${f.fileName}`}><Icon name="x" size={11} /></button>}
        </div>
      ))}
    </div>
  );
}
