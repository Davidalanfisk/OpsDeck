export const maxTransferBytes = 10 * 1024 * 1024;
export const maxTextBytes = 1024 * 1024;
export type RemoteEntry = { name: string; kind: 'file' | 'directory' | 'link'; size: number };
export type RemoteText = { path: string; content: string; revision: string };
