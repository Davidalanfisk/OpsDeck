import { create } from 'zustand';
import type { Deck } from '../shared/model.ts';

export async function request<T>(path: string, method = 'GET', body?: unknown, keepalive = false): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, keepalive, body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function readLocal<T>(key: string): T | undefined {
  try { return JSON.parse(localStorage.getItem(`opsdeck:${key}`) ?? 'null') ?? undefined; }
  catch { return undefined; }
}

export function writeLocal(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(`opsdeck:${key}`);
    else localStorage.setItem(`opsdeck:${key}`, JSON.stringify(value));
    return true;
  } catch { return false; }
}

type Location = { clientId?: string; workspaceId?: string };
type State = {
  location: Location;
  navigate: (location: Location) => void;
  deck?: Deck;
  setDeck: (deck?: Deck) => void;
  error?: string;
  setError: (message?: string) => void;
};

export const useOps = create<State>(set => ({
  location: readLocal<Location>('location') ?? {},
  navigate: location => {
    const saved = writeLocal('location', location);
    set(state => ({
      location,
      deck: state.deck?.client.id === location.clientId ? state.deck : undefined,
      error: saved ? undefined : 'Browser storage is unavailable; the active workspace may not reopen automatically.',
    }));
  },
  setDeck: deck => set({ deck }),
  setError: error => set({ error }),
}));

export function refreshDeck(clientId: string) {
  return request<Deck>(`/clients/${clientId}`).then(deck => {
    if (useOps.getState().location.clientId === clientId) useOps.getState().setDeck(deck);
  });
}

export function describe(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
