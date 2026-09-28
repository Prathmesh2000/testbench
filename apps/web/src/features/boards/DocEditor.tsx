'use client';

import type { HocuspocusProvider } from '@hocuspocus/provider';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import type * as Y from 'yjs';
import type { Peer } from './collab';
import s from './boards.module.css';

interface Props {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  user: Peer;
  canEdit: boolean;
  /** Tighter layout for the meeting side pane. */
  compact?: boolean;
}

/** Rich-text editor on the board's `content` fragment, with everyone's carets. */
export function DocEditor({ doc, provider, user, canEdit, compact = false }: Props) {
  const editor = useEditor(
    {
      // Rendering on the server would mismatch the client, which only has content once the doc syncs.
      immediatelyRender: false,
      editable: canEdit,
      extensions: [
        // Yjs keeps its own per-user history; ProseMirror's would undo other people's edits too.
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: doc, field: 'content' }),
        CollaborationCaret.configure({ provider, user }),
      ],
      editorProps: { attributes: { class: `${s.prose} ${compact ? s.proseCompact : ''}`, 'aria-label': 'Document' } },
    },
    [doc, provider],
  );

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  return (
    <div className={compact ? s.docPaneCompact : s.docPane}>
      {editor && canEdit && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className={compact ? undefined : s.docBody} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      code: e.isActive('code'),
      block: e.isActive('codeBlock'),
    }),
  });
  const chain = () => editor.chain().focus();
  const tools: { key: keyof typeof on; label: string; title: string; run(): void }[] = [
    { key: 'h1', label: 'H1', title: 'Heading 1', run: () => chain().toggleHeading({ level: 1 }).run() },
    { key: 'h2', label: 'H2', title: 'Heading 2', run: () => chain().toggleHeading({ level: 2 }).run() },
    { key: 'bold', label: 'B', title: 'Bold (Ctrl+B)', run: () => chain().toggleBold().run() },
    { key: 'italic', label: 'I', title: 'Italic (Ctrl+I)', run: () => chain().toggleItalic().run() },
    { key: 'bullet', label: '• List', title: 'Bulleted list', run: () => chain().toggleBulletList().run() },
    { key: 'ordered', label: '1. List', title: 'Numbered list', run: () => chain().toggleOrderedList().run() },
    { key: 'code', label: '</>', title: 'Inline code', run: () => chain().toggleCode().run() },
    { key: 'block', label: 'Code block', title: 'Code block', run: () => chain().toggleCodeBlock().run() },
  ];
  return (
    <div className={s.toolbar} role="toolbar" aria-label="Formatting">
      {tools.map((t) => (
        <button key={t.key} type="button" className={`chip ${on[t.key] ? 'on' : ''}`} title={t.title} aria-pressed={on[t.key]} onClick={t.run}>
          {t.key === 'bold' ? <b>{t.label}</b> : t.key === 'italic' ? <i>{t.label}</i> : t.label}
        </button>
      ))}
    </div>
  );
}
