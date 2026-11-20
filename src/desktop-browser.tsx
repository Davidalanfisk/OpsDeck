import { useEffect, useRef, useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import type { BrowserAction, BrowserBounds, BrowserState, DesktopBridge } from '../shared/desktop.ts';

declare global {
  interface Window { opsDeckDesktop?: DesktopBridge }
}

function visibleBounds(slot: HTMLDivElement, api: DockviewPanelApi, dragging: boolean): BrowserBounds | null {
  if (!api.isVisible || dragging || slot.ownerDocument !== document || document.querySelector('dialog[open]')) return null;
  const { top, left, bottom, right } = slot.getBoundingClientRect();
  const x = Math.max(0, Math.ceil(left));
  const y = Math.max(0, Math.ceil(top));
  const width = Math.min(window.innerWidth, Math.floor(right)) - x;
  const height = Math.min(window.innerHeight, Math.floor(bottom)) - y;
  if (width < 2 || height < 2 || document.elementFromPoint(x + width / 2, y + height / 2) !== slot) return null;
  return { x, y, width, height };
}

export function DesktopBrowser({ bridge, api, id, clientId, url, name }: {
  bridge: DesktopBridge; api: DockviewPanelApi; id: string; clientId: string; url: string; name: string;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserState>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let frame = 0;
    let dragging = false;
    let previous = '';
    const update = () => {
      frame = requestAnimationFrame(update);
      const bounds = slot.current ? visibleBounds(slot.current, api, dragging) : null;
      const signature = JSON.stringify(bounds);
      if (previous !== signature) {
        previous = signature;
        bridge.layout(id, bounds);
      }
    };
    const drag = () => { dragging = true; bridge.layout(id, null); previous = ''; };
    const release = () => { dragging = false; };
    const unsubscribe = bridge.onState(id, setState);
    document.addEventListener('dragstart', drag, true);
    document.addEventListener('drop', release, true);
    document.addEventListener('dragend', release, true);
    void bridge.open(id, clientId, url).then(() => {
      if (active) frame = requestAnimationFrame(update);
    }).catch(() => { if (active) setError('Could not open this website pane.'); });
    return () => {
      active = false;
      unsubscribe();
      cancelAnimationFrame(frame);
      bridge.release(id);
      document.removeEventListener('dragstart', drag, true);
      document.removeEventListener('drop', release, true);
      document.removeEventListener('dragend', release, true);
    };
  }, [bridge, api, id, clientId, url]);

  function act(action: BrowserAction) {
    setError('');
    void bridge.action(id, action).catch(() => setError(action === 'external'
      ? 'Could not open the system browser.' : 'The website could not be loaded.'));
  }
  return <div className="link-panel">
    <div className="panel-toolbar">
      <button aria-label="Go back" disabled={!state?.canGoBack} onClick={() => act('back')}>‹</button>
      <button aria-label="Go forward" disabled={!state?.canGoForward} onClick={() => act('forward')}>›</button>
      <button aria-label="Reload website" onClick={() => act('reload')}>↻</button>
      <span className="truncate spacer" title={state?.origin}>{state?.origin ?? name}</span>
      <button onClick={() => act('external')}>Open separately ↗</button>
    </div>
    {(error || state?.failed) && <small className="error" role="alert">{error || 'The website did not load. Check its address and certificate or try your system browser.'}</small>}
    {state?.loading && <small role="status">Loading website…</small>}
    <div ref={slot} className="desktop-browser-slot" aria-label={`${name} website`} />
  </div>;
}
