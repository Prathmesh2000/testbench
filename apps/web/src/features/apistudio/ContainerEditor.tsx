'use client';

import type { ApiContainerConfig, ApiNodeDetail } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import { useProfiles } from './AuthPanels';
import { AuthEditor, ScriptsEditor, VariableTable } from './fields';
import s from './apistudio.module.css';

/** A collection's or folder's auth and variables, which every request inside inherits. */
export function ContainerEditor({ base, workspaceId, node, canEdit }: { base: string; workspaceId: string; node: ApiNodeDetail; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [config, setConfig] = useState<ApiContainerConfig>(node.config!);
  const [error, setError] = useState<string | null>(null);
  const profiles = useProfiles(base, workspaceId);
  // Reset when the node changes or is saved, not on every render of the same config object.
  useEffect(() => setConfig(node.config!), [node.id, node.updatedAt]);

  const dirty = JSON.stringify(config) !== JSON.stringify(node.config);
  const save = async () => {
    setError(null);
    try {
      await api('PATCH', `${base}/nodes/${node.id}`, { config: { ...config, variables: config.variables.map(({ hasValue: _h, ...v }) => v) } });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'node', workspaceId, node.id] });
      notify('Saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };

  return (
    <div style={{ overflow: 'auto', flex: 1 }}>
      <div className={s.bar}>
        <Icon name={node.kind === 'collection' ? 'layers' : 'tree'} />
        <h2 style={{ margin: 0, fontSize: 15 }}>{node.name}</h2>
        <span className="lbl">{node.kind}</span>
        <div className="f1" />
        {canEdit && <button className="btn primary" disabled={!dirty} onClick={save}>{dirty ? 'Save' : 'Saved'}</button>}
      </div>
      {error && <div className={s.notice} role="alert"><Icon name="alert" size={14} />{error}</div>}
      <div className={s.pane} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <section>
          <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>Auth</h3>
          <AuthEditor auth={config.auth} onChange={(auth) => setConfig({ ...config, auth })} readOnly={!canEdit} allowInherit={node.kind === 'folder'} profiles={profiles.data ?? []} />
        </section>
        <section>
          <h3 style={{ fontSize: 13, margin: '0 0 4px' }}>Variables</h3>
          <div className="t3" style={{ fontSize: 12, marginBottom: 8 }}>
            Used by every request inside. A folder’s value wins over its collection’s, and both win over the environment’s.
          </div>
          <VariableTable rows={config.variables} onChange={(variables) => setConfig({ ...config, variables })} readOnly={!canEdit} />
        </section>
        <section>
          <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>Scripts</h3>
          <ScriptsEditor scripts={config.scripts} onChange={(scripts) => setConfig({ ...config, scripts })} readOnly={!canEdit} scope={node.kind === 'collection' ? 'collection' : 'folder'} />
        </section>
      </div>
    </div>
  );
}
