import type { FileConnection } from '../../shared/model.ts';

export declare function ftpFixture(t: { after: (cleanup: () => Promise<void>) => void }, tls?: { key: Buffer; cert: Buffer }): Promise<{
  files: Map<string, Buffer>; commands: string[]; connection: FileConnection;
}>;
export declare const text: Buffer;
