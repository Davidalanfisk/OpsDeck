import { useEffect, useLayoutEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
// Register contributions before the first editor initializes Monaco's services.
import 'monaco-editor/internal/common/workers.js';
import 'monaco-editor/languages/definitions/php/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/features/json/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';

globalThis.MonacoEnvironment = { getWorker: (_id, label) => label === 'json' ? new JsonWorker() : new EditorWorker() };
const languages: Record<string, string> = {
  php: 'php', js: 'javascript', ts: 'typescript', css: 'css', html: 'html', htm: 'html',
  json: 'json', md: 'markdown', sh: 'shell', py: 'python', xml: 'xml', yml: 'yaml', yaml: 'yaml',
};

export function Monaco({ path, value, readOnly, active, change, save }: {
  path: string; value: string; readOnly: boolean; active: boolean; change: (content: string) => void; save: () => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(null);
  const modelRef = useRef<monaco.editor.ITextModel>(null);
  const viewState = useRef<monaco.editor.ICodeEditorViewState | null>(null);
  const onChange = useRef(change);
  const onSave = useRef(save);
  onChange.current = change;
  onSave.current = save;
  useEffect(() => {
    if (!mount.current) return;
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    const model = monaco.editor.createModel(value, languages[extension] ?? 'plaintext');
    modelRef.current = model;
    const instance = monaco.editor.create(mount.current, {
      model: active ? model : null, theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false },
      fontSize: 13, scrollBeyondLastLine: false, readOnly,
    });
    editor.current = instance;
    const changed = model.onDidChangeContent(() => onChange.current(model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true)));
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave.current());
    return () => { changed.dispose(); instance.dispose(); model.dispose(); editor.current = null; modelRef.current = null; };
  }, [path]);
  useLayoutEffect(() => {
    const instance = editor.current;
    const model = modelRef.current;
    if (!instance || !model) return;
    if (!active && instance.getModel()) {
      // A hidden editor can retain Monaco's text focus and receive another tab's keystrokes.
      viewState.current = instance.saveViewState();
      instance.setModel(null);
    } else if (active && !instance.getModel()) {
      instance.setModel(model);
      instance.layout();
      if (viewState.current) instance.restoreViewState(viewState.current);
    }
  }, [active, path]);
  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) !== value) model.setValue(value);
  }, [value, path]);
  useEffect(() => { editor.current?.updateOptions({ readOnly }); }, [readOnly]);
  return <div className="monaco-mount" ref={mount} aria-label="Remote file editor" />;
}
