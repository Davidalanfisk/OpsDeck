import { z } from 'zod';

export const connectionTypes = ['SSH', 'Website', 'WordPress', 'Plesk', 'SiteGround', 'DigitalOcean', 'Documentation', 'Custom'] as const;
const name = z.string().trim().min(1).max(120);
const webUrl = z.url({ protocol: /^https?$/ });

export const clientInput = z.object({
  name, description: z.string().max(4000), colour: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export const connectionInput = z.discriminatedUnion('type', [
  z.object({
    name, type: z.literal('SSH'), host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535), username: name,
    fingerprint: z.string().trim().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  }),
  z.object({ name, type: z.enum(['Website', 'WordPress', 'Plesk', 'SiteGround', 'DigitalOcean', 'Documentation', 'Custom']), url: webUrl }),
]);
export const noteInput = z.object({ title: name, content: z.string().max(250_000) });
export const layoutInput = z.record(z.string(), z.json());
export const workspaceInput = z.object({ name, layout: layoutInput.nullable().optional() });

type Entity = { id: string; created_at: string; updated_at: string };
export type Client = Entity & z.infer<typeof clientInput>;
export type Connection = Entity & z.infer<typeof connectionInput> & { client_id: string };
export type Note = Entity & z.infer<typeof noteInput> & { client_id: string };
export type Layout = z.infer<typeof layoutInput>;
export type Workspace = Entity & { client_id: string; name: string; layout: Layout | null };
export type Deck = { client: Client; connections: Connection[]; notes: Note[]; workspaces: Workspace[] };
