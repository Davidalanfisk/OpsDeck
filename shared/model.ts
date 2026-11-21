import { z } from 'zod';

export const connectionTypes = ['SSH', 'SFTP', 'FTP', 'FTPS', 'Website', 'WordPress', 'Plesk', 'SiteGround', 'DigitalOcean', 'Documentation', 'Custom'] as const;
const name = z.string().trim().min(1).max(120);
const webUrl = z.url({ protocol: /^https?$/ });
const fingerprint = z.string().trim().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);
const ftpUsername = name.refine(value => !/[\0\r\n]/.test(value), 'Username cannot contain control characters');

export const clientInput = z.object({
  name, description: z.string().max(4000), colour: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export const connectionInput = z.union([
  z.object({
    name, type: z.enum(['SSH', 'SFTP']), host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535), username: name,
    fingerprint, auth_method: z.literal('password').default('password'),
    agent_fingerprint: z.null().optional(),
  }).or(z.object({
    name, type: z.enum(['SSH', 'SFTP']), host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535), username: name,
    fingerprint, auth_method: z.literal('agent'), agent_fingerprint: fingerprint,
  })),
  z.object({
    name, type: z.enum(['FTP', 'FTPS']), host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535), username: ftpUsername,
    tls_mode: z.enum(['explicit', 'implicit']).default('explicit'),
  }),
  z.object({ name, type: z.enum(['Website', 'WordPress', 'Plesk', 'SiteGround', 'DigitalOcean', 'Documentation', 'Custom']), url: webUrl }),
]);
export const noteInput = z.object({ title: name, content: z.string().max(250_000) });
export const layoutInput = z.record(z.string(), z.json());
export const workspaceInput = z.object({ name, layout: layoutInput.nullable().optional() });

type Entity = { id: string; created_at: string; updated_at: string };
export type Client = Entity & z.infer<typeof clientInput>;
export type Connection = Entity & z.infer<typeof connectionInput> & { client_id: string };
export type SshConnection = Extract<Connection, { type: 'SSH' | 'SFTP' }>;
export type FileConnection = Extract<Connection, { host: string }>;
export function isFileConnection(connection: Connection): connection is FileConnection {
  return connection.type === 'SSH' || connection.type === 'SFTP' || connection.type === 'FTP' || connection.type === 'FTPS';
}
export function isSshConnection(connection: Connection): connection is SshConnection {
  return connection.type === 'SSH' || connection.type === 'SFTP';
}
export type Note = Entity & z.infer<typeof noteInput> & { client_id: string };
export type Layout = z.infer<typeof layoutInput>;
export type Workspace = Entity & { client_id: string; name: string; layout: Layout | null };
export type Deck = { client: Client; connections: Connection[]; notes: Note[]; workspaces: Workspace[] };
