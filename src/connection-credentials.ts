import { useEffect, useState } from 'react';
import { describe, request } from './state.ts';

type CredentialStatus = { available: boolean; saved: boolean; stored: boolean };
const changeEvent = 'opsdeck-credentials-changed';

export function notifyCredentialChange() {
  window.dispatchEvent(new Event(changeEvent));
}

export function useConnectionCredentials(clientId: string, connectionId: string) {
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [credentialError, setCredentialError] = useState('');
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const refresh = () => {
      const current = ++sequence;
      void request<CredentialStatus>(`/files/credentials?clientId=${clientId}&connectionId=${connectionId}`)
        .then(result => { if (active && current === sequence) { setCredential(result); setCredentialError(''); } })
        .catch(error => { if (active && current === sequence) { setCredential(null); setCredentialError(describe(error)); } });
    };
    refresh();
    window.addEventListener(changeEvent, refresh);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener(changeEvent, refresh); window.removeEventListener('focus', refresh); };
  }, [clientId, connectionId]);
  return { credential, credentialError };
}
