import { useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '../shared/update.ts';
import { describe, useOps } from './state.ts';
import { flushNote } from './panels.tsx';

export function Updates() {
  const bridge = window.opsDeckDesktop!;
  const [status, setStatus] = useState<UpdateStatus>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const previous = useRef<UpdateStatus['phase'] | undefined>(undefined);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => {
    let alive = true;
    const poll = () => void bridge.updateStatus().then(next => {
      if (alive) {
        setStatus(next);
        if (next.phase === 'available' && previous.current !== 'available') setOpen(true);
        previous.current = next.phase;
      }
    }).catch(error => { if (alive) setError(describe(error)); });
    poll();
    void bridge.updateStatus().then(next => { if (alive && next.supported) return bridge.updateCheck(); })
      .catch(error => { if (alive) setError(describe(error)); });
    const timer = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [bridge]);
  async function action(callback: () => Promise<void>) {
    setBusy(true); setError('');
    try { await callback(); }
    catch (error) { setError(describe(error)); }
    finally { setBusy(false); }
  }
  return <div className="update-controls">
    <button onClick={() => setOpen(value => !value)} aria-expanded={open}>Updates{status?.phase === 'available' ? ' •' : ''}</button>
    <dialog ref={dialog} onClose={() => setOpen(false)} className="update-popover">
      <div className="dialog-head"><strong>Software updates</strong><button aria-label="Close update settings" onClick={() => setOpen(false)}>×</button></div>
      <strong>OpsDeck {status?.current}</strong>
      <p role="status">{status?.detail ?? 'Loading updater…'}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <button disabled={busy || !status?.supported || ['checking', 'installing', 'ready'].includes(status?.phase ?? '')}
        onClick={() => void action(bridge.updateCheck)}>Check for updates</button>
      {status?.phase === 'available' && <>
        <small>The update downloads dependencies and builds separately. Restart disconnects SSH/file sessions; save remote drafts first.</small>
        <button disabled={busy} onClick={() => void action(bridge.updatePrepare)}>Download and build update</button>
      </>}
      {status?.phase === 'ready' && <button disabled={busy} onClick={() => void action(async () => {
        for (const note of useOps.getState().deck?.notes ?? []) await flushNote(note);
        await bridge.updateRestart();
      })}>Restart and install</button>}
    </dialog>
  </div>;
}
