import type { ConnectConfig } from 'ssh2';
import { agentIdentities, SelectedAgent } from './ssh-agent.ts';

export async function sshAuthentication(connection: { auth_method: 'password' } | { auth_method: 'agent'; agent_fingerprint: string }, password?: string): Promise<Pick<ConnectConfig, 'password' | 'agent' | 'authHandler'>> {
  if (connection.auth_method === 'password') {
    if (!password) throw new Error('SSH password is required.');
    return { password };
  }
  const socket = process.env.SSH_AUTH_SOCK;
  let identities: Awaited<ReturnType<typeof agentIdentities>>;
  try { identities = await agentIdentities(); }
  catch { throw new Error('SSH agent unavailable. Start OpsDeck with access to SSH_AUTH_SOCK.'); }
  if (!identities.some(identity => identity.fingerprint === connection.agent_fingerprint)) {
    throw new Error('The selected SSH agent identity is missing. Load it with ssh-add.');
  }
  if (!socket) throw new Error('SSH agent unavailable. Start OpsDeck with access to SSH_AUTH_SOCK.');
  return { agent: new SelectedAgent(socket, connection.agent_fingerprint), authHandler: ['agent'] };
}

export function sshErrorDetail(error: Error & { level?: string }) {
  return error.level === 'agent'
    ? error.message === 'Selected SSH agent identity is missing'
      ? 'The selected SSH agent identity is missing. Load it with ssh-add.'
      : 'SSH agent unavailable or unable to sign. Check SSH_AUTH_SOCK and the loaded key.'
    : error.level === 'client-authentication'
      ? 'SSH authentication failed.'
      : error.message.includes('Host denied')
        ? 'SSH host key did not match the saved fingerprint.'
        : 'SSH connection failed. Check the host, port and network access.';
}
