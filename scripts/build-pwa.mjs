import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../dist/', import.meta.url);
async function files(dir = '') {
  const entries = await readdir(new URL(dir, root), { withFileTypes: true });
  const lists = await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(`${dir}${entry.name}/`) : [`${dir}${entry.name}`]));
  return lists.flat().filter(file => file !== 'sw.js').sort();
}
const paths = await files();
const template = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const hash = createHash('sha256').update(template);
for (const path of paths) hash.update(path).update(await readFile(new URL(path, root)));
const output = template.replace("const VERSION = 'development';", `const VERSION = '${hash.digest('hex').slice(0, 16)}';`)
  .replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(paths)};`);
await writeFile(new URL('sw.js', root), output);
console.log(`PWA: ${paths.length} files prepared for offline use.`);
