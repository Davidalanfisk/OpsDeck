import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { connectionTypes } from '../shared/model.ts';
import type { Client, Connection, Note } from '../shared/model.ts';
import { describe } from './state.ts';

export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-head"><h2>{title}</h2><button className="quiet" type="button" onClick={close} aria-label="Close dialog">×</button></div>
    {children}
  </dialog>;
}

function EditForm({ children, submit, close, remove, label = 'Save' }: {
  children: ReactNode; submit: (data: FormData) => Promise<void>; close: () => void;
  remove?: () => Promise<void>; label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); close(); }
    catch (error) { setError(describe(error)); setBusy(false); }
  }
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(() => submit(data));
  }
  return <form className="editor" onSubmit={onSubmit}>
    {children}
    {error && <p role="alert" className="error">{error}</p>}
    <footer>
      {remove && <button type="button" className="danger" disabled={busy} onClick={() => {
        if (window.confirm('Delete this item? This cannot be undone.')) void run(remove);
      }}>Delete</button>}
      <span className="spacer" />
      <button type="button" onClick={close} disabled={busy}>Cancel</button>
      <button className="primary" disabled={busy}>{label}</button>
    </footer>
  </form>;
}

type EditorProps = { save: (data: unknown) => Promise<void>; close: () => void; remove?: () => Promise<void> };
export function ClientEditor({ value, save, close, remove }: EditorProps & { value?: Client }) {
  return <Dialog title={value ? 'Edit client' : 'New client'} close={close}>
    <EditForm submit={data => save(Object.fromEntries(data))} close={close} remove={remove}>
      <label>Name <input name="name" required maxLength={120} defaultValue={value?.name} autoFocus /></label>
      <label>Description <textarea name="description" rows={3} maxLength={4000} defaultValue={value?.description} /></label>
      <label className="colour-field">Client colour <input type="color" name="colour" defaultValue={value?.colour ?? '#9275ff'} /></label>
    </EditForm>
  </Dialog>;
}

export function ConnectionEditor({ value, save, close, remove }: EditorProps & { value?: Connection }) {
  const [type, setType] = useState<(typeof connectionTypes)[number]>(value?.type ?? 'SSH');
  const ssh = value?.type === 'SSH' ? value : undefined;
  return <Dialog title={value ? 'Edit connection' : 'New connection'} close={close}>
    <EditForm submit={data => save({ ...Object.fromEntries(data), ...(type === 'SSH' && { port: Number(data.get('port')) }) })} close={close} remove={remove}>
      <label>Name <input name="name" required maxLength={120} defaultValue={value?.name} autoFocus /></label>
      <label>Type <select name="type" value={type} onChange={event => {
        const next = connectionTypes.find(option => option === event.target.value);
        if (next) setType(next);
      }}>{connectionTypes.map(option => <option key={option}>{option}</option>)}</select></label>
      {type === 'SSH' ? <>
        <div className="field-row">
          <label>Host <input name="host" required maxLength={253} defaultValue={ssh?.host} /></label>
          <label>Port <input name="port" type="number" required min={1} max={65535} defaultValue={ssh?.port ?? 22} /></label>
        </div>
        <label>Username <input name="username" required maxLength={120} defaultValue={ssh?.username} /></label>
        <label>Trusted host key fingerprint <input name="fingerprint" required placeholder="SHA256:…" defaultValue={ssh?.fingerprint} />
          <small>Get the SHA256 fingerprint from your server administrator or console. Passwords are entered only when connecting.</small>
        </label>
      </> : <label>URL <input type="url" name="url" required placeholder="https://example.com" defaultValue={value?.type !== 'SSH' ? value?.url : ''} /></label>}
    </EditForm>
  </Dialog>;
}

export function NamedEditor({ kind, title, save, close, remove }: {
  kind: 'note' | 'workspace'; title?: Note['title']; save: (value: string) => Promise<void>; close: () => void; remove?: () => Promise<void>;
}) {
  return <Dialog title={title ? `Edit ${kind}` : `New ${kind}`} close={close}>
    <EditForm submit={data => save(String(data.get('name')))} close={close} remove={remove} label={title ? 'Save' : 'Create'}>
      <label>{kind === 'note' ? 'Title' : 'Name'} <input name="name" required maxLength={120} defaultValue={title} autoFocus /></label>
    </EditForm>
  </Dialog>;
}
