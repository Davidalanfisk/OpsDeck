import type { FileConnection } from '../../shared/model.ts';

export declare function ftpFixture(t: { after: (cleanup: () => Promise<void>) => void }, tls?: { key: Buffer; cert: Buffer }): Promise<{
  files: Map<string, Buffer>; directories: Set<string>; commands: string[]; connection: FileConnection;
}>;
export declare function sftpFixture(t: { after: (cleanup: () => Promise<void>) => void }): Promise<{
  files: Map<string, Buffer>; directories: Set<string>; offered: Buffer[]; authAttempts: string[];
  connection: Extract<FileConnection, { type: 'SSH' | 'SFTP' }>;
}>;
export declare const text: Buffer;
