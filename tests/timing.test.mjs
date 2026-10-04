import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import test from 'node:test';

function app(saved = null) {
  let wall = 1000000, monotonic = 0;
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', value: '', style: {}, classList: { toggle() {} }, setAttribute() {}, replaceChildren() {}, firstElementChild: { style: {} } });
    return nodes.get(id);
  }
  const storage = new Map(saved ? [['tempo-timer', JSON.stringify(saved)]] : []);
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [wall])); } static now() { return wall; } }
  const context = vm.createContext({ Date: FakeDate, Intl, console, Blob, File, performance: { now: () => monotonic }, document: { getElementById: node, querySelectorAll: () => [], addEventListener() {}, hidden: false }, navigator: {}, window: { isSecureContext: false, setTimeout: () => 1 }, clearTimeout() {}, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace("import './style.css';", '').replace("import alertUrl from '../alert.mp3';", "const alertUrl = '/alert.mp3';").replaceAll('import.meta.env.BASE_URL', "'/'");
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
  return { node, run: code => vm.runInContext(code, context), advance(ms) { wall += ms; monotonic += ms; } };
}
test('timer uses deadline after background delay and completes once', () => {
  const a = app(); a.run('setDuration(3000)'); a.node('timer-toggle').onclick(); a.advance(10000); a.run('render()');
  assert.equal(a.run('remaining'), 0); assert.equal(a.run('deadline'), null);
  assert.match(a.node('message').textContent, /終了/);
  a.node('message').textContent = ''; a.run('render()'); assert.equal(a.node('message').textContent, '');
});
test('pause and resume retain remaining time', () => {
  const a = app(); a.run('setDuration(10000)'); a.node('timer-toggle').onclick(); a.advance(3000); a.node('timer-toggle').onclick();
  a.advance(20000); a.run('render()'); assert.equal(a.run('remaining'), 7000);
  a.node('timer-toggle').onclick(); a.advance(2000); a.run('render()'); assert.equal(a.run('remaining'), 5000);
});
test('running timer restores from persisted deadline', () => {
  const a = app({ duration: 10000, remaining: 10000, deadline: 1004000 });
  assert.equal(a.run('remaining'), 4000); assert.equal(a.run('mode'), 'timer');
});
test('stopwatch excludes paused duration and resets', () => {
  const a = app(); a.node('stopwatch-toggle').onclick(); a.advance(1250); a.node('stopwatch-toggle').onclick(); a.advance(5000);
  assert.equal(a.run('currentElapsed()'), 1250);
  a.node('stopwatch-toggle').onclick(); a.advance(750); assert.equal(a.run('currentElapsed()'), 2000);
  a.node('stopwatch-reset').onclick(); assert.equal(a.run('currentElapsed()'), 0);
});

test('timer completes while settings are open', async () => {
  const a = app(); await Promise.resolve();
  a.run('setDuration(1000)'); a.node('timer-toggle').onclick(); a.run("select('settings')");
  assert.equal(a.node('stage').hidden, true);
  assert.equal(a.node('settings').hidden, false);
  a.advance(2000); a.run('render()');
  assert.equal(a.run('deadline'), null);
  assert.equal(a.node('alarm-banner').hidden, false);
  a.run("select('timer')"); assert.equal(a.node('settings').hidden, true);
});

test('valid MP3 can be selected, saved, restored and removed', async () => {
  const a = app(); await Promise.resolve();
  a.run("let storedSound; soundStore = async (action, value) => { if (action === 'write') storedSound = value; return storedSound; }; audio = { decodeAudioData: async () => ({ duration: 2 }) };");
  a.node('sound-file').files = [new File(['mp3 fixture'], 'my-alarm.mp3', { type: 'audio/mpeg' })];
  await a.node('sound-file').onchange();
  assert.equal(a.run('selectedSound'), 'custom');
  assert.equal(a.node('custom-option').textContent, 'my-alarm.mp3');
  assert.equal(a.run('storedSound.customSound.blob.size'), 11);
  a.run("customSound = undefined; selectedSound = 'default'");
  await a.run('restoreSound()');
  assert.equal(a.run('selectedSound'), 'custom');
  assert.equal(a.node('sound-choice').value, 'custom');
  a.node('sound-choice').value = 'default'; a.node('sound-choice').onchange();
  assert.equal(a.run('selectedSound'), 'default');
  assert.equal(a.run('customSound.name'), 'my-alarm.mp3');
  a.node('remove-sound').onclick();
  assert.equal(a.run('customSound'), undefined);
  assert.equal(a.node('custom-option').disabled, true);
});

test('invalid or undecodable imports preserve the selected sound', async () => {
  const a = app(); await Promise.resolve();
  a.run("customSound = { name: 'working.mp3', blob: new Blob(['audio']) }; selectedSound = 'custom'; audio = { decodeAudioData: async () => { throw new Error('Invalid audio'); } };");
  a.node('sound-file').files = [new File(['bad'], 'bad.txt')];
  await a.node('sound-file').onchange();
  assert.match(a.node('import-status').textContent, /MP3/);
  a.node('sound-file').files = [new File(['bad'], 'bad.mp3')];
  await a.node('sound-file').onchange();
  assert.equal(a.run('customSound.name'), 'working.mp3');
  assert.equal(a.run('selectedSound'), 'custom');
  assert.match(a.node('import-status').textContent, /読み込めません/);
});

test('all five built-in choices have captions and restore their selection', async () => {
  const a = app(); await Promise.resolve();
  a.run("let savedPreset; soundStore = async (action, value) => { if (action === 'write') savedPreset = value; return savedPreset; };");
  for (const id of ['default', 'warning', 'chime', 'digital', 'bell']) {
    a.node('sound-choice').value = id; a.node('sound-choice').onchange();
    assert.equal(a.run('selectedSound'), id);
    assert.ok(a.node('sound-caption').textContent.length > 10);
    a.run("selectedSound = 'custom'"); await a.run('restoreSound()');
    assert.equal(a.run('selectedSound'), id);
  }
});

test('synthesized presets contain distinct non-clipping audio', () => {
  const a = app();
  const signatures = new Set();
  for (const kind of ['warning', 'chime', 'digital', 'bell']) {
    const samples = a.run(`synthesizeAlarm({ sampleRate: 22050, createBuffer: (channels, length) => { const data = new Float32Array(length); return { getChannelData: () => data }; } }, '${kind}').getChannelData(0)`);
    let peak = 0, energy = 0;
    for (const value of samples) { assert.ok(Number.isFinite(value)); peak = Math.max(peak, Math.abs(value)); energy += value * value; }
    assert.ok(peak > .1 && peak <= 1);
    signatures.add(Math.round(energy));
  }
  assert.equal(signatures.size, 4);
});

test('rendered sound dropdown includes five built-ins and a separate custom option', () => {
  const a = app();
  const markup = a.node('app').innerHTML;
  const select = markup.match(/<select id="sound-choice"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select, 'Sound dropdown must be rendered');
  const options = [...select.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)];
  assert.equal(options.length, 6);
  assert.deepEqual(options.map(option => option[1].match(/value="([^"]+)"/)[1]), ['default', 'warning', 'chime', 'digital', 'bell', 'custom']);
  assert.deepEqual(options.slice(0, 5).map(option => option[2]), ['標準アラーム', '警告音', 'やさしいチャイム', '電子ビープ', 'ベル']);
  assert.match(options[5][1], /id="custom-option"/);
});

test('world clocks handle midnight, fractional offsets, and daylight saving', () => {
  const a = app();
  const clock = (zone, instant) => a.run(`cityTime('${zone}', new Date('${instant}'))`);
  assert.equal(clock('Asia/Tokyo', '2026-01-01T15:00:00Z').time, '00:00:00');
  assert.match(clock('Asia/Tokyo', '2026-01-01T15:00:00Z').date, /1月2日/);
  assert.equal(clock('Asia/Kolkata', '2026-01-01T00:00:00Z').time, '05:30:00');
  assert.equal(clock('Asia/Kathmandu', '2026-01-01T00:00:00Z').offset, 'UTC+05:45');
  assert.equal(clock('America/New_York', '2026-03-08T06:59:59Z').time, '01:59:59');
  assert.equal(clock('America/New_York', '2026-03-08T07:00:00Z').time, '03:00:00');
  assert.match(clock('Europe/London', '2026-01-01T12:00:00Z').offset, /^UTC(?:\+00:00)?$/);
  assert.equal(clock('Europe/London', '2026-07-01T12:00:00Z').offset, 'UTC+01:00');
  assert.equal(clock('Australia/Sydney', '2026-01-01T12:00:00Z').offset, 'UTC+11:00');
  assert.equal(clock('Australia/Sydney', '2026-07-01T12:00:00Z').offset, 'UTC+10:00');
  for (const zone of a.run('cities.map(city => city[1])')) assert.match(clock(zone, '2026-09-06T00:00:00Z').time, /^\d{2}:\d{2}:\d{2}$/);
});

test('main city selection updates time and storage; world clocks only appear on clock tab', () => {
  const a = app();
  a.node('world-clock-toggle').checked = true;
  a.node('world-clock-toggle').onchange();
  a.node('primary-city').value = 'America/New_York';
  a.node('primary-city').onchange();
  assert.equal(a.run('primaryCity'), 'America/New_York');
  assert.equal(a.node('digits').textContent, a.run("cityTime('America/New_York', new Date()).time"));
  assert.equal(a.run("JSON.parse(localStorage.getItem('tempo-world-clock')).primaryCity"), 'America/New_York');
  assert.match(a.node('city-time-0').textContent, /^\d{2}:\d{2}:\d{2}$/);
  a.run("select('timer')");
  assert.equal(a.node('world-clocks').hidden, true);
  assert.equal(a.node('world-map').hidden, true);
  a.run("select('clock')");
  assert.equal(a.node('world-clocks').hidden, false);
  assert.equal(a.node('primary-city-control').hidden, false);
});

test('lap history keeps all records and pages without a scrolling list', () => {
  const a = app();
  a.node('stopwatch-toggle').onclick();
  for (let i = 0; i < 8; i++) { a.advance(1000); a.node('lap').onclick(); }
  assert.equal(a.run('laps.length'), 8);
  assert.equal((a.node('laps').innerHTML.match(/<li>/g) || []).length, 3);
  assert.match(a.node('laps').innerHTML, /LAP 08/);
  assert.equal(a.node('lap-page').textContent, '1 / 3');
  a.node('laps-older').onclick();
  assert.match(a.node('laps').innerHTML, /LAP 05/);
  assert.doesNotMatch(a.node('laps').innerHTML, /LAP 08/);
  a.node('laps-older').onclick();
  assert.match(a.node('laps').innerHTML, /LAP 01/);
  assert.equal(a.node('laps-older').disabled, true);
  a.node('laps-newer').onclick();
  assert.equal(a.node('lap-page').textContent, '2 / 3');
  a.advance(1000); a.node('lap').onclick();
  assert.equal(a.node('lap-page').textContent, '1 / 3');
  assert.match(a.node('laps').innerHTML, /LAP 09/);
  a.node('stopwatch-reset').onclick();
  assert.equal(a.node('laps').innerHTML, '');
  assert.equal(a.node('lap-pages').hidden, true);
});

 test('world clock checkbox switches local and world views and persists across tabs', () => {
  const a = app();
  assert.equal(a.node('world-clocks').hidden, true);
  assert.equal(a.node('primary-city-control').hidden, true);
  assert.equal(a.node('digits').textContent, a.run('cityTime(zone, new Date()).time'));
  a.node('world-clock-toggle').checked = true;
  a.node('world-clock-toggle').onchange();
  assert.equal(a.node('world-clocks').hidden, false);
  assert.equal(a.node('world-map').hidden, false);
  assert.equal(a.run("JSON.parse(localStorage.getItem('tempo-world-clock')).showWorldClock"), true);
  a.run("select('stopwatch')");
  assert.equal(a.node('world-clock-control').hidden, true);
  assert.equal(a.node('world-clocks').hidden, true);
  a.run("select('clock')");
  assert.equal(a.node('world-clock-toggle').checked, true);
  assert.equal(a.node('world-clocks').hidden, false);
  a.node('world-clock-toggle').checked = false;
  a.node('world-clock-toggle').onchange();
  assert.equal(a.node('world-clocks').hidden, true);
  assert.equal(a.node('world-map').hidden, true);
  assert.equal(a.node('digits').textContent, a.run('cityTime(zone, new Date()).time'));
  assert.equal(a.run("JSON.parse(localStorage.getItem('tempo-world-clock')).showWorldClock"), false);
});
