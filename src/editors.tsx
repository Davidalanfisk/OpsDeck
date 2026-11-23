import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { connectionTypes, isFileConnection, isSshConnection } from '../shared/model.ts';
import type { Client, Connection, Note } from '../shared/model.ts';
import { describe, request } from './state.ts';

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
  const file = value && isFileConnection(value) ? value : undefined;
  const ssh = value && isSshConnection(value) ? value : undefined;
  const network = ['SSH', 'SFTP', 'FTP', 'FTPS'].includes(type);
  const usesSsh = type === 'SSH' || type === 'SFTP';
  const [authMethod, setAuthMethod] = useState<'password' | 'agent'>(ssh?.auth_method ?? 'password');
  const [identity, setIdentity] = useState(ssh?.auth_method === 'agent' ? ssh.agent_fingerprint : '');
  const [identities, setIdentities] = useState<{ fingerprint: string; type: string }[]>([]);
  const [agentError, setAgentError] = useState('');
  const [fingerprint, setFingerprint] = useState(ssh?.fingerprint ?? '');
  const [candidate, setCandidate] = useState<{ host: string; port: number; fingerprint: string }>();
  const [lookupError, setLookupError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const lookupVersion = useRef(0);
  const hostInput = useRef<HTMLInputElement>(null);
  const portInput = useRef<HTMLInputElement>(null);
  function invalidateKey() {
    lookupVersion.current++;
    setCandidate(undefined);
    setLookupError('');
    setLookingUp(false);
    setFingerprint('');
  }
  async function lookupHostKey() {
    const host = hostInput.current?.value.trim() ?? '';
    const port = Number(portInput.current?.value);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      setLookupError('Enter a host and valid port first.');
      return;
    }
    const version = ++lookupVersion.current;
    setCandidate(undefined);
    setLookupError('');
    setLookingUp(true);
    try {
      const result = await request<{ fingerprint: string }>('/ssh/host-key', 'POST', { host, port });
      if (version === lookupVersion.current) setCandidate({ host, port, fingerprint: result.fingerprint });
    } catch (error) {
      if (version === lookupVersion.current) setLookupError(describe(error));
    } finally {
      if (version === lookupVersion.current) setLookingUp(false);
    }
  }
  async function loadIdentities() {
    try {
      const keys = await request<{ fingerprint: string; type: string }[]>('/ssh-agent/identities');
      setIdentities(keys);
      setAgentError(keys.length ? '' : 'No identities loaded. Use ssh-add and refresh.');
    } catch (error) {
      setIdentities([]);
      setAgentError(describe(error));
    }
  }
  useEffect(() => {
    if ((type === 'SSH' || type === 'SFTP') && authMethod === 'agent') void loadIdentities();
  }, [type, authMethod]);
  return <Dialog title={value ? 'Edit connection' : 'New connection'} close={close}>
    <EditForm submit={data => save({ ...Object.fromEntries(data), ...(network && { port: Number(data.get('port')) }) })} close={close} remove={remove}>
      <label>Name <input name="name" required maxLength={120} defaultValue={value?.name} autoFocus /></label>
      <label>Type <select name="type" value={type} onChange={event => {
        const next = connectionTypes.find(option => option === event.target.value);
        if (next) { invalidateKey(); setType(next); }
      }}>{connectionTypes.map(option => <option key={option}>{option}</option>)}</select></label>
      {network ? <>
        <div className="field-row">
          <label>Host <input ref={hostInput} name="host" required maxLength={253} defaultValue={file?.host} onChange={invalidateKey} /></label>
          <label>Port <input ref={portInput} key={usesSsh ? 'ssh' : 'ftp'} name="port" type="number" required min={1} max={65535} defaultValue={file?.port ?? (usesSsh ? 22 : 21)} onChange={invalidateKey} /></label>
        </div>
        <label>Username <input name="username" required maxLength={120} defaultValue={file?.username} /></label>
        {usesSsh ? <>
        <label>Trusted host key fingerprint <input name="fingerprint" required placeholder="SHA256:…" value={fingerprint} onChange={event => setFingerprint(event.target.value)} />
          <small>Verify the fingerprint with your hosting provider through a separate trusted channel before saving it.</small>
        </label>
        <button type="button" disabled={lookingUp} onClick={() => void lookupHostKey()}>{lookingUp ? 'Checking server key…' : 'Check server key'}</button>
        {lookupError && <p role="alert" className="error">{lookupError}</p>}
        {candidate && <div className="host-key-candidate">
          <p>Server key presented by {candidate.host}:{candidate.port}: <strong>{candidate.fingerprint}</strong></p>
          <p className="error">This key is not verified. An attacker could present a different key. Compare it with the SHA256 host key fingerprint from your provider before trusting it.</p>
          <button type="button" onClick={() => { setFingerprint(candidate.fingerprint); setCandidate(undefined); }}>I verified it — use this fingerprint</button>
        </div>}
        <label>Authentication <select name="auth_method" value={authMethod} onChange={event => setAuthMethod(event.target.value === 'agent' ? 'agent' : 'password')}>
          <option value="password">Password</option><option value="agent">SSH agent</option>
        </select></label>
        {authMethod === 'agent' && <>
          <label>Agent identity <select name="agent_fingerprint" required value={identity} onChange={event => setIdentity(event.target.value)}>
            <option value="">Select an identity</option>
            {identity && !identities.some(key => key.fingerprint === identity) && <option value={identity}>{identity} (not currently loaded)</option>}
            {identities.map(key => <option key={key.fingerprint} value={key.fingerprint}>{key.type} {key.fingerprint}</option>)}
          </select><small>This is the public key fingerprint, not the server host key fingerprint.</small></label>
          {agentError && <p role="alert" className="error">{agentError}</p>}
          <button type="button" onClick={() => void loadIdentities()}>Refresh agent identities</button>
        </>}
        </> : <>
          {type === 'FTPS' && <label>TLS mode <select name="tls_mode" defaultValue={file && 'tls_mode' in file ? file.tls_mode : 'explicit'}>
            <option value="explicit">Explicit TLS (usually port 21)</option><option value="implicit">Implicit TLS (usually port 990)</option>
          </select><small>Certificates must be valid for the host. TLS verification cannot be disabled.</small></label>}
          {type === 'FTP' && <p className="error">FTP sends passwords and files unencrypted. Prefer FTPS or SFTP.</p>}
          <small>Enter the password when connecting; it is never saved.</small>
        </>}
      </> : <label>URL <input type="url" name="url" required placeholder="https://example.com" defaultValue={value && 'url' in value ? value.url : ''} /></label>}
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
