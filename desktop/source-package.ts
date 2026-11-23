import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compareVersions } from '../shared/update.ts';

export function sourcePath(path: string) {
  return /^(?:src|server|shared|desktop|scripts|test|skills|docs)\/[A-Za-z0-9_. /-]+$/.test(path) ||
    ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'README.md', 'electron-builder.yml'].includes(path);
}

export async function unpackSource(bytes: Buffer, target: string, version: string) {
  compareVersions(version, version);
  const body: unknown = JSON.parse(gunzipSync(bytes, { maxOutputLength: 50_000_000 }).toString('utf8'));
  if (!body || typeof body !== 'object' || !('version' in body) || body.version !== version ||
    !('files' in body) || !Array.isArray(body.files) || body.files.length > 5000) throw new Error('Invalid source update package.');
  const files = new Map<string, Buffer>();
  for (const file of body.files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.content !== 'string' ||
      !sourcePath(file.path) || file.path.split('/').some((part: string) => !part || part === '.' || part === '..') ||
      files.has(file.path) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
      throw new Error('Invalid file in source update package.');
    }
    files.set(file.path, Buffer.from(file.content, 'base64'));
  }
  const manifest = files.get('package.json');
  if (!manifest || JSON.parse(manifest.toString()).version !== version || !files.has('package-lock.json') ||
    !files.has('desktop/main.ts')) throw new Error('Source update package is incomplete.');
  for (const [path, content] of files) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await writeFile(join(target, path), content, { flag: 'wx', mode: 0o600 });
  }
}
