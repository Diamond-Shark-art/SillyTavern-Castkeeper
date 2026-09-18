import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const folder = 'SillyTavern-Castkeeper';
const staging = path.join(root, 'dist', folder);
await mkdir(path.join(root, 'dist'), { recursive: true });
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const file of ['manifest.json', 'index.js', 'style.css', 'src', 'README.md', 'LICENSE']) {
    await cp(path.join(root, file), path.join(staging, file), { recursive: true });
}
const archive = path.join(root, 'dist', `${folder}-${manifest.version}.zip`);
await rm(archive, { force: true });
execFileSync('zip', ['-qr', archive, folder], { cwd: path.join(root, 'dist') });
console.log(`Installable folder: ${staging}\nArchive: ${archive}`);
