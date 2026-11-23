import { Client } from 'ssh2';
import { keyFingerprint } from './ssh-agent.ts';

export function inspectSshHostKey(host: string, port: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const ssh = new Client();
    let finished = false;
    let observed: string | undefined;
    const finish = (error?: Error, fingerprint?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      ssh.destroy();
      if (error) reject(error);
      else if (fingerprint) resolve(fingerprint);
      else reject(new Error('The server did not present an SSH host key.'));
    };
    const abort = () => finish(new Error('SSH host key lookup cancelled.'));
    const timer = setTimeout(() => finish(new Error('SSH host key lookup timed out. Check the host, port and network access.')), 15_000);
    ssh.on('error', error => {
      if (observed && error.message.includes('Host denied')) finish(undefined, observed);
      else finish(new Error('Could not retrieve the SSH host key. Check the host, port and network access.'));
    });
    ssh.on('close', () => finish(new Error('The server closed before presenting an SSH host key.')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      ssh.connect({
        host, port, username: 'opsdeck-host-key-lookup', readyTimeout: 15_000,
        authHandler: () => false,
        hostVerifier: (key: Buffer) => {
          observed = keyFingerprint(key);
          // Reject the handshake: lookup must never authenticate or trust the presented key.
          return false;
        },
      });
    } catch {
      finish(new Error('Invalid SSH host or port.'));
    }
  });
}
