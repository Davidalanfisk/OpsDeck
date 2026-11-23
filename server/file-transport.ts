import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client as FtpClient, FTPError } from 'basic-ftp';
import { Client as SshClient } from 'ssh2';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { FileConnection } from '../shared/model.ts';
import { maxTransferBytes } from '../shared/files.ts';
import type { RemoteEntry } from '../shared/files.ts';
import { keyFingerprint } from './ssh-agent.ts';
import { sshAuthentication, sshErrorDetail } from './ssh-auth.ts';

export class FileError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

export function fileError(error: unknown) {
  if (error instanceof FileError) return error;
  if (error instanceof FTPError && error.code === 530) return new FileError('FTP authentication failed.');
  if (error instanceof FTPError && error.code === 550) return new FileError('The FTP server denied access to this path. Check the path and permissions.');
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (code === '3') return new FileError('SFTP permission denied. Check the remote account and file permissions.');
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code)) return new FileError('FTPS certificate verification failed. Check the hostname and server certificate.');
  return new FileError('File operation failed. Check permissions, connection settings and network access.');
}

export const revision = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export type RemoteTransport = {
  pwd: () => Promise<string>;
  list: (path: string) => Promise<RemoteEntry[]>;
  read: (path: string, limit: number) => Promise<Buffer>;
  write: (path: string, data: Buffer, expected: string | null) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  close: () => void;
};

async function collect(limit: number, download: (sink: Writable) => Promise<unknown>) {
  const chunks: Buffer[] = [];
  let size = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) { callback(new FileError('File exceeds the size limit.', 413)); return; }
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  // FTP may reject before it starts writing to the destination.
  sink.on('error', () => {});
  await download(sink);
  return Buffer.concat(chunks);
}

function checkSize(size: number, limit: number) {
  if (size > limit) throw new FileError('File exceeds the size limit.', 413);
}

async function sshTransport(connection: Extract<FileConnection, { type: 'SSH' | 'SFTP' }>, password?: string): Promise<RemoteTransport> {
  let authentication;
  try { authentication = await sshAuthentication(connection, password); }
  catch (error) { throw new FileError(error instanceof Error ? error.message : 'SSH authentication unavailable.'); }
  const ssh = new SshClient();
  let failure: FileError | undefined;
  ssh.on('error', error => { failure = new FileError(sshErrorDetail(error)); });
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    const failed = (error: Error) => { ssh.destroy(); reject(new FileError(sshErrorDetail(error))); };
    const closed = () => reject(failure ?? new FileError('SSH connection closed.'));
    ssh.once('error', failed);
    ssh.once('close', closed);
    ssh.once('ready', () => ssh.sftp((error, channel) => {
      ssh.off('error', failed);
      ssh.off('close', closed);
      if (error) { ssh.destroy(); reject(new FileError('The server refused SFTP access.')); }
      else resolve(channel);
    }));
    try {
      ssh.connect({
        host: connection.host, port: connection.port, username: connection.username, ...authentication,
        readyTimeout: 15_000, keepaliveInterval: 20_000, keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => keyFingerprint(key) === connection.fingerprint,
      });
    } catch { ssh.destroy(); reject(new FileError('Invalid SSH connection settings.')); }
  });
  function callback(run: (cb: (error?: Error | null) => void) => void) {
    if (failure) return Promise.reject(failure);
    return new Promise<void>((resolve, reject) => run(error => error ? reject(error) : resolve()));
  }
  const stat = (path: string) => new Promise<Stats>((resolve, reject) => sftp.lstat(path, (error, stats) => error ? reject(failure ?? error) : resolve(stats)));
  const read = async (path: string, limit: number) => {
    const info = await stat(path);
    if (!info.isFile()) throw new FileError('Only regular files can be read or edited.', 400);
    checkSize(info.size, limit);
    return collect(limit, sink => pipeline(sftp.createReadStream(path), sink));
  };
  const exists = async (path: string) => {
    try { return await stat(path); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 2) return undefined;
      throw error;
    }
  };
  return {
    pwd: () => new Promise((resolve, reject) => sftp.realpath('.', (error, path) => error ? reject(failure ?? error) : resolve(path))),
    list: path => new Promise((resolve, reject) => sftp.readdir(path, (error, entries) => {
      if (error) { reject(error); return; }
      resolve(entries.map(entry => ({
        name: entry.filename, size: entry.attrs.size,
        kind: (entry.attrs.mode & 0o170000) === 0o040000 ? 'directory'
          : (entry.attrs.mode & 0o170000) === 0o120000 ? 'link' : 'file',
      })));
    })),
    read,
    mkdir: path => callback(cb => sftp.mkdir(path, cb)),
    async write(path, data, expected) {
      const before = await exists(path);
      if (expected === null ? Boolean(before) : !before || revision(await read(path, maxTransferBytes)) !== expected) {
        throw new FileError('The remote file changed. Reload it before saving; your edits have not been uploaded.', 409);
      }
      const temp = posix.join(posix.dirname(path), `.opsdeck-${randomUUID()}.tmp`);
      try {
        await pipeline(Readable.from([data]), sftp.createWriteStream(temp, { flags: 'wx', mode: before ? before.mode & 0o777 : 0o600 }));
        if (expected === null ? Boolean(await exists(path)) : revision(await read(path, maxTransferBytes)) !== expected) {
          throw new FileError('The remote file changed during upload. Reload it before saving.', 409);
        }
        if (before) {
          await callback(cb => sftp.chmod(temp, before.mode & 0o777, cb));
          try { await callback(cb => sftp.ext_openssh_rename(temp, path, cb)); }
          catch (error) {
            if (!(error instanceof Error && (error.message === 'Server does not support this extended request' || ('code' in error && error.code === 8)))) throw error;
            await callback(cb => sftp.rename(temp, path, cb));
          }
        } else {
          await callback(cb => sftp.rename(temp, path, cb));
        }
      } catch (error) {
        await callback(cb => sftp.unlink(temp, cb)).catch(cleanup => {
          if (!(cleanup instanceof Error && 'code' in cleanup && cleanup.code === 2)) console.warn('Could not remove an SFTP temporary upload.');
        });
        throw error;
      }
    },
    close: () => ssh.destroy(),
  };
}

export async function connectFiles(connection: FileConnection, password?: string): Promise<RemoteTransport> {
  if (connection.type === 'SSH' || connection.type === 'SFTP') return sshTransport(connection, password);
  if (!password) throw new FileError('FTP password is required.', 400);
  const ftp = new FtpClient(15_000, { maxListingBytes: 2 * 1024 * 1024 });
  try {
    await ftp.access({
      host: connection.host, port: connection.port, user: connection.username, password,
      secure: connection.type === 'FTPS' ? connection.tls_mode === 'implicit' ? 'implicit' : true : false,
      secureOptions: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
  } catch (error) { ftp.close(); throw fileError(error); }
  const list = async (path: string): Promise<RemoteEntry[]> => (await ftp.list(path)).map(entry => ({
    name: entry.name, size: entry.size, kind: entry.isDirectory ? 'directory' : entry.isSymbolicLink ? 'link' : 'file',
  }));
  const exists = async (path: string) => (await list(posix.dirname(path))).find(entry => entry.name === posix.basename(path));
  const read = async (path: string, limit: number) => {
    const entry = await exists(path);
    if (!entry || entry.kind !== 'file') throw new FileError('Only regular files can be read or edited.', 400);
    checkSize(entry.size, limit);
    return collect(limit, sink => ftp.downloadTo(sink, path));
  };
  return {
    pwd: () => ftp.pwd(), list, read,
    async mkdir(path) { await ftp.send(`MKD ${path}`); },
    async write(path, data, expected) {
      const before = await exists(path);
      if (expected === null ? Boolean(before) : !before || revision(await read(path, maxTransferBytes)) !== expected) {
        throw new FileError('The remote file changed. Reload it before saving; your edits have not been uploaded.', 409);
      }
      const temp = posix.join(posix.dirname(path), `.opsdeck-${randomUUID()}.tmp`);
      try {
        await ftp.uploadFrom(Readable.from([data]), temp);
        if (expected === null ? Boolean(await exists(path)) : revision(await read(path, maxTransferBytes)) !== expected) {
          throw new FileError('The remote file changed during upload. Reload it before saving.', 409);
        }
        if (before?.kind === 'file') {
          const info = (await ftp.list(posix.dirname(path))).find(entry => entry.name === posix.basename(path));
          if (info?.permissions) {
            const { user, group, world } = info.permissions;
            try { await ftp.send(`SITE CHMOD ${user}${group}${world} ${temp}`); }
            catch { throw new FileError('The FTP server could not preserve file permissions. The original file was not replaced.'); }
          }
        }
        await ftp.rename(temp, path);
      } catch (error) {
        await ftp.remove(temp, true).catch(() => console.warn('Could not remove an FTP temporary upload.'));
        throw error;
      }
    },
    close: () => ftp.close(),
  };
}
