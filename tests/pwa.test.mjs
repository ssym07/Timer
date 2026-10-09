import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function worker() {
  const handlers = {}, saved = new Map();
  const scope = 'https://example.com/tempo/';
  const cache = { async addAll(urls) { urls.forEach(url => saved.set(url, { url })); }, async match(url) { return saved.get(url); } };
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
    .replace('const PRECACHE = [];', 'const PRECACHE = ["index.html", "assets/app.js", "assets/alert.mp3"];');
  const deleted = [];
  vm.runInNewContext(source, {
    URL, Set,
    self: { registration: { scope }, addEventListener: (type, handler) => handlers[type] = handler, clients: { claim: async () => {} } },
    caches: { open: async () => cache, keys: async () => [`tempo-${scope}-old`, 'another-app'], delete: async key => deleted.push(key) },
    fetch: () => { throw new Error('Offline'); },
  });
  return { handlers, scope, deleted };
}
test('installed PWA serves the page, script and alarm offline under a subpath', async () => {
  const { handlers, scope } = worker();
  let pending;
  handlers.install({ waitUntil: promise => pending = promise });
  await pending;
  for (const [path, mode, expected] of [['?source=icon', 'navigate', ''], ['assets/app.js', 'cors', 'assets/app.js'], ['assets/alert.mp3', 'cors', 'assets/alert.mp3']]) {
    handlers.fetch({ request: { url: scope + path, method: 'GET', mode }, respondWith: promise => pending = promise });
    assert.equal((await pending).url, scope + expected);
  }
  let intercepted = false;
  handlers.fetch({ request: { url: 'https://other.example/', method: 'GET' }, respondWith: () => intercepted = true });
  assert.equal(intercepted, false);
});
test('activation only removes old caches belonging to this application scope', async () => {
  const { handlers, scope, deleted } = worker();
  let pending;
  handlers.activate({ waitUntil: promise => pending = promise });
  await pending;
  assert.deepEqual(deleted, [`tempo-${scope}-old`]);
});
