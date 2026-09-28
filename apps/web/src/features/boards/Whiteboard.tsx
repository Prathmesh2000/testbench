'use client';

import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { localChanges, mergeElements } from './boards-utils';
import s from './boards.module.css';

// Loaded client-only (next/dynamic, ssr: false): Excalidraw touches window at import time.

/** Marks transactions this client wrote, so its own map updates are not replayed into the scene. */
const LOCAL = Symbol('whiteboard-local');

interface Props {
  doc: Y.Doc;
  canEdit: boolean;
  theme: 'dark' | 'light';
}

/** Excalidraw synced through the board's `elements` map (element id → element JSON). */
export default function Whiteboard({ doc, canEdit, theme }: Props) {
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const elements = doc.getMap<ExcalidrawElement>('elements');

  useEffect(() => {
    if (!excalidraw) return;
    const apply = () =>
      excalidraw.updateScene({
        elements: mergeElements(excalidraw.getSceneElementsIncludingDeleted(), elements.values()),
        // Other people's strokes must not land on this user's undo stack.
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    apply();
    const onRemote = (_e: Y.YMapEvent<ExcalidrawElement>, tx: Y.Transaction) => {
      if (tx.origin !== LOCAL) apply();
    };
    elements.observe(onRemote);
    return () => elements.unobserve(onRemote);
  }, [excalidraw, elements]);

  // Excalidraw calls this for every scene or app-state change, including the updateScene above. Only
  // elements whose version moved past the shared copy are written, which is what stops echo loops.
  const publish = (scene: readonly ExcalidrawElement[]) => {
    if (!canEdit) return;
    const changed = localChanges(scene, (id) => elements.get(id));
    if (changed.length === 0) return;
    doc.transact(() => {
      for (const el of changed) elements.set(el.id, el);
    }, LOCAL);
  };

  return (
    <div className={s.wb}>
      <Excalidraw
        excalidrawAPI={setExcalidraw}
        onChange={publish}
        viewModeEnabled={!canEdit}
        theme={theme}
        // ponytail: image files are not synced (only element JSON is), so the image tool is off; sync
        // BinaryFiles through a second Y.Map if images are needed.
        UIOptions={{ tools: { image: false } }}
      />
    </div>
  );
}
