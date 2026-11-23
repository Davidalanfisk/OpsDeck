import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { sourcePath } from '../desktop/source-package.ts';
import { compareVersions } from '../shared/update.ts';

const revision = process.argv[2] ?? 'HEAD';
const version = JSON.parse(execFileSync('git', ['show', `${revision}:package.json`], { encoding: 'utf8' })).version as string;
compareVersions(version, version);
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', revision], { encoding: 'utf8' }).trim().split('\n').filter(sourcePath);
const files = paths.map(path => ({ path, content: execFileSync('git', ['show', `${revision}:${path}`], { maxBuffer: 10_000_000 }).toString('base64') }));
const archive = gzipSync(JSON.stringify({ version, files }));
const sha256 = createHash('sha256').update(archive).digest('hex');
await mkdir('release/source-updates', { recursive: true });
const name = `OpsDeck-${version}-source.json.gz`;
await writeFile(`release/source-updates/${name}`, archive);
execFileSync('git', ['archive', '--format=zip', `--prefix=OpsDeck-${version}/`,
  `--output=release/source-updates/OpsDeck-${version}-source.zip`, revision, ...paths]);
await writeFile('release/source-updates/latest.json', JSON.stringify({ version, sha256,
  url: `https://raw.githubusercontent.com/Davidalanfisk/OpsDeck-updates/main/packages/${name}` }, null, 2) + '\n');
const current = JSON.parse(await readFile('package.json', 'utf8')).version;
console.log(`Created ${name} from ${revision} (working-tree version ${current}). Publish the package before latest.json.`);
