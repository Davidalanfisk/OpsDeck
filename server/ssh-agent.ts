import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import type { IdentityCallback, ParsedKey, PublicKeyEntry } from 'ssh2';

const { OpenSSHAgent, utils } = ssh2;

function parsedKey(entry: ParsedKey | PublicKeyEntry): ParsedKey {
  if ('getPublicSSH' in entry) return entry;
  const value = 'pubKey' in entry.pubKey ? entry.pubKey.pubKey : entry.pubKey;
  const key = utils.parseKey(value);
  if (key instanceof Error) throw key;
  return key;
}

export function keyFingerprint(key: Buffer) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export async function agentIdentities() {
  const socket = process.env.SSH_AUTH_SOCK;
  if (!socket) throw new Error('SSH agent unavailable');
  const keys = await new Promise<ParsedKey[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSH agent timed out')), 5000);
    new OpenSSHAgent(socket).getIdentities((error, identities) => {
      clearTimeout(timer);
      if (error || !identities) reject(error ?? new Error('SSH agent returned no identities'));
      else {
        try { resolve(identities.map(parsedKey)); }
        catch (parseError) { reject(parseError); }
      }
    });
  });
  return keys.map(key => ({ key, fingerprint: keyFingerprint(key.getPublicSSH()), type: key.type }));
}

export class SelectedAgent extends OpenSSHAgent {
  private fingerprint: string;
  constructor(socket: string, fingerprint: string) { super(socket); this.fingerprint = fingerprint; }

  override getIdentities(callback: IdentityCallback<ParsedKey>) {
    super.getIdentities((error, keys) => {
      if (error || !keys) { callback(error ?? new Error('SSH agent unavailable')); return; }
      let selected: ParsedKey[];
      try { selected = keys.map(parsedKey).filter(key => keyFingerprint(key.getPublicSSH()) === this.fingerprint); }
      catch { callback(new Error('Invalid SSH agent identity')); return; }
      if (!selected.length) { callback(new Error('Selected SSH agent identity is missing')); return; }
      callback(null, selected);
    });
  }
}
