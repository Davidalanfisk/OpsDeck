import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRelease } from '../desktop/source-updater.ts';

const manifestPath = join('release', 'source-updates', 'latest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
const { version } = parseRelease(manifest);
const portable: Record<string, { url: string; sha256: string }> = {};
for (const platform of ['mac-arm64', 'win-x64']) {
  const name = `OpsDeck-${version}-${platform}.zip`;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join('release', name))) hash.update(chunk);
  portable[platform] = {
    url: `https://github.com/Davidalanfisk/OpsDeck/releases/download/v${version}/${name}`,
    sha256: hash.digest('hex'),
  };
}
await writeFile(manifestPath, JSON.stringify({ ...manifest, portable }, null, 2) + '\n');
console.log('Added portable ZIP checksums to latest.json. Publish and verify the release assets before publishing the feed.');
