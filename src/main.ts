import './style.css';
import alertUrl from '../alert.mp3';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Mode = 'clock' | 'timer' | 'stopwatch' | 'settings';
let mode: Mode = 'clock';
let duration = 25 * 60_000;
let remaining = duration;
let deadline: number | null = null;
let elapsed = 0;
let started: number | null = null;
let laps: number[] = [];
let sound = true;
let audio: AudioContext | undefined;
let registration: ServiceWorkerRegistration | undefined;
let notificationReady: Promise<void> = Promise.resolve();
let alarmNodes: AudioBufferSourceNode[] = [];
let alarmBuffer: Promise<AudioBuffer> | undefined;
let alarmPlaying = false;
let alarmGeneration = 0;
let customSound: { name: string; blob: Blob } | undefined;
const builtInSounds = [
  { id: 'default', name: '標準アラーム', caption: 'いつもの終了音。これまでの alert.mp3 を再生します。' },
  { id: 'warning', name: '警告音', caption: '高低2つの鋭い音を交互に繰り返す、気づきやすいアラーム。' },
  { id: 'chime', name: 'やさしいチャイム', caption: '3つの澄んだ音がゆっくり響く、落ち着いたお知らせ。' },
  { id: 'digital', name: '電子ビープ', caption: '短い「ピピピッ」を繰り返す、シンプルな電子音。' },
  { id: 'bell', name: 'ベル', caption: '余韻のあるベルを2回。作業の区切りに。' },
] as const;
type SoundChoice = typeof builtInSounds[number]['id'] | 'custom';
let selectedSound: SoundChoice = 'default';
function validSound(value: unknown): SoundChoice {
  if (value === 'custom' && customSound) return 'custom';
  return builtInSounds.find(item => item.id === value)?.id ?? 'default';
}
let soundRevision = 0;
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const cityGroups = [
  { region: '東アジア', cities: [['東京', 'Asia/Tokyo'], ['ソウル', 'Asia/Seoul'], ['北京', 'Asia/Shanghai'], ['香港', 'Asia/Hong_Kong'], ['台北', 'Asia/Taipei']] },
  { region: 'アジア・中東', cities: [['シンガポール', 'Asia/Singapore'], ['バンコク', 'Asia/Bangkok'], ['ジャカルタ', 'Asia/Jakarta'], ['マニラ', 'Asia/Manila'], ['ニューデリー', 'Asia/Kolkata'], ['カトマンズ', 'Asia/Kathmandu'], ['ドバイ', 'Asia/Dubai'], ['リヤド', 'Asia/Riyadh']] },
  { region: 'ヨーロッパ', cities: [['ロンドン', 'Europe/London'], ['パリ', 'Europe/Paris'], ['ベルリン', 'Europe/Berlin'], ['ローマ', 'Europe/Rome'], ['マドリード', 'Europe/Madrid'], ['アテネ', 'Europe/Athens'], ['イスタンブール', 'Europe/Istanbul'], ['モスクワ', 'Europe/Moscow']] },
  { region: 'アフリカ', cities: [['カイロ', 'Africa/Cairo'], ['ヨハネスブルク', 'Africa/Johannesburg'], ['ナイロビ', 'Africa/Nairobi'], ['ラゴス', 'Africa/Lagos'], ['カサブランカ', 'Africa/Casablanca']] },
  { region: '南北アメリカ', cities: [['ニューヨーク', 'America/New_York'], ['シカゴ', 'America/Chicago'], ['デンバー', 'America/Denver'], ['ロサンゼルス', 'America/Los_Angeles'], ['バンクーバー', 'America/Vancouver'], ['トロント', 'America/Toronto'], ['メキシコシティ', 'America/Mexico_City'], ['サンパウロ', 'America/Sao_Paulo'], ['ブエノスアイレス', 'America/Argentina/Buenos_Aires'], ['リマ', 'America/Lima']] },
  { region: 'オセアニア・太平洋', cities: [['シドニー', 'Australia/Sydney'], ['アデレード', 'Australia/Adelaide'], ['パース', 'Australia/Perth'], ['オークランド', 'Pacific/Auckland'], ['ホノルル', 'Pacific/Honolulu'], ['スバ', 'Pacific/Fiji']] },
];
const cities = cityGroups.flatMap(group => group.cities);
const validCity = (value: unknown): value is string => cities.some(city => city[1] === value);
let showWorldClock = false;
let primaryCity = 'Asia/Tokyo';
let worldCities = ['Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'Africa/Johannesburg', 'Australia/Sydney'];
try {
  const saved = JSON.parse(localStorage.getItem('tempo-world-clock') || 'null');
  if (typeof saved?.showWorldClock === 'boolean') showWorldClock = saved.showWorldClock;
  if (validCity(saved?.primaryCity)) primaryCity = saved.primaryCity;
  if (Array.isArray(saved?.worldCities) && saved.worldCities.length === 6 && saved.worldCities.every(validCity)) worldCities = saved.worldCities;
} catch { /* Ignore unavailable storage or invalid saved cities. */ }
function cityOptions(selected: string) {
  return cityGroups.map(group => `<optgroup label="${group.region}">${group.cities.map(([name, timeZone]) => `<option value="${timeZone}"${timeZone === selected ? ' selected' : ''}>${name}</option>`).join('')}</optgroup>`).join('');
}
const clockFormats = new Map<string, { time: Intl.DateTimeFormat; date: Intl.DateTimeFormat; offset: Intl.DateTimeFormat }>();
function cityTime(timeZone: string, now: Date) {
  let formats = clockFormats.get(timeZone);
  if (!formats) {
    formats = {
      time: new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
      date: new Intl.DateTimeFormat('ja-JP', { timeZone, month: 'long', day: 'numeric', weekday: 'short' }),
      offset: new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' }),
    };
    clockFormats.set(timeZone, formats);
  }
  return { time: formats.time.format(now), date: formats.date.format(now), offset: formats.offset.formatToParts(now).find(part => part.type === 'timeZoneName')!.value.replace('GMT', 'UTC') };
}
function saveCities() {
  try { localStorage.setItem('tempo-world-clock', JSON.stringify({ primaryCity, worldCities, showWorldClock })); } catch { /* Storage is optional. */ }
}

$('app').innerHTML = `
<header><a class="brand" href="./" aria-label="TEMPO ホーム"><span class="brand-icon">◷</span> TEMPO<span class="brand-dot">.</span></a><div class="header-right"><span class="local" id="time-label"><i></i> WORLD TIME</span><button id="fullscreen" class="icon-button" aria-label="全画面表示">⛶</button></div></header>
<div id="world-map" class="world-map" aria-hidden="true"></div><main><nav aria-label="表示切り替え"><button data-mode="clock" class="selected" aria-pressed="true">◷ <span>時計</span></button><button data-mode="timer" aria-pressed="false">◴ <span>タイマー</span></button><button data-mode="stopwatch" aria-pressed="false">⏱ <span>ストップウォッチ</span></button><button data-mode="settings" aria-pressed="false">⚙ <span>設定</span></button></nav>
<section id="stage" class="stage" aria-label="時間表示"><p id="eyebrow" class="eyebrow">MAKE TIME FOR WHAT MATTERS</p><label id="world-clock-control" class="world-clock-control"><input id="world-clock-toggle" type="checkbox" aria-controls="world-clocks primary-city-control world-map"${showWorldClock ? ' checked' : ''}>世界時計を表示</label><div id="primary-city-control" class="primary-city-control"><label for="primary-city">メインの都市</label><select id="primary-city">${cityOptions(primaryCity)}</select></div><p id="date" class="date"></p><div id="digits" class="digits" role="timer" aria-label="現在時刻"></div><p id="caption" class="caption"></p><div id="progress" class="progress" hidden><div></div></div></section>
<section id="world-clocks" class="world-clocks" aria-labelledby="world-title"><div class="world-heading"><h2 id="world-title">世界時計 <span>WORLD CLOCK</span></h2><p>都市を選んで、世界の今を。</p></div><div class="city-grid">${worldCities.map((timeZone, i) => `<article class="city-card"><label for="city-${i}">都市 ${i + 1}</label><select id="city-${i}" data-city="${i}">${cityOptions(timeZone)}</select><p id="city-time-${i}" class="city-time"></p><div class="city-detail"><span id="city-date-${i}"></span><span id="city-offset-${i}"></span></div></article>`).join('')}</div></section>
<section id="timer-controls" class="controls" hidden><div class="presets"><button data-minutes="5">5分</button><button data-minutes="15">15分</button><button data-minutes="25" class="active">25分</button><button data-minutes="60">60分</button></div><label class="timer-details-control"><input id="timer-details-toggle" type="checkbox" aria-controls="custom">詳細設定</label><form id="custom" hidden><label>時間 <input id="hours" type="number" min="0" max="99" value="0" required></label><label>分 <input id="minutes" type="number" min="0" max="59" value="25" required></label><label>秒 <input id="seconds" type="number" min="0" max="59" value="0" required></label><button type="submit">設定</button></form><div class="actions"><button id="timer-reset">リセット</button><button id="timer-toggle" class="primary">スタート</button></div></section>
<section id="stopwatch-controls" class="controls" hidden><div class="actions"><button id="stopwatch-reset">リセット</button><button id="stopwatch-toggle" class="primary">スタート</button><button id="lap" disabled>ラップ</button></div><ol id="laps" aria-label="ラップ記録"></ol><div id="lap-pages" class="lap-pages" hidden><button id="laps-newer" aria-label="新しいラップへ">← 新しい</button><span id="lap-page" role="status"></span><button id="laps-older" aria-label="古いラップへ">古い →</button></div></section>
<div id="message" role="status" class="message"></div>
<div id="alarm-banner" class="alarm-banner" role="alert" hidden><strong>タイマーが終了しました</strong><button id="alarm-dismiss">確認・音を止める</button></div>
<section id="settings" hidden class="settings" aria-labelledby="settings-title">
<div class="settings-heading"><h2 id="settings-title">タイマー終了のお知らせ</h2><p>画面への通知と、終了音をそれぞれ設定できます。</p></div>
<div class="settings-tabs" aria-label="設定項目"><button data-setting="notification" aria-pressed="true">通知</button><button data-setting="sound" aria-pressed="false">終了音</button><button data-setting="source" aria-pressed="false">音源・MP3</button></div>
<div id="setting-notification" class="setting-row"><div class="setting-copy"><h3>画面に通知する <span id="notification-badge" class="status-badge" role="status"></span></h3><p id="notification-status"></p></div><button id="notifications" aria-describedby="notification-status">通知を許可する</button><button id="notification-test" hidden>通知を試す</button></div>
<div id="setting-sound" class="setting-row" hidden><div class="setting-copy"><h3>終了音を鳴らす</h3><p>選択した音を再生します。音量は端末側でも調整できます。</p></div><div class="sound-control"><button id="sound-test">音を試す</button><span id="sound-status">オン</span><button id="sound" class="switch" role="switch" aria-checked="true" aria-label="終了音を鳴らす"><span></span></button></div></div>
<div id="setting-source" class="setting-row sound-picker" hidden><div class="setting-copy"><h3><label for="sound-choice">終了音を選ぶ</label></h3><select id="sound-choice" aria-describedby="sound-caption">${builtInSounds.map(item => `<option value="${item.id}">${item.name}</option>`).join('')}<option id="custom-option" value="custom" disabled>インポートしたMP3（未登録）</option></select><p id="sound-caption"></p><p id="import-status" role="status">MP3はこのブラウザ内に保存されます。サーバーには送信しません。</p></div><div class="import-actions"><button id="import-sound">MP3をインポート</button><button id="remove-sound" hidden>取り込んだ音を削除</button><input id="sound-file" type="file" accept=".mp3,audio/mpeg" hidden></div></div>
<p class="notification-note">このタブは開いたままにしてください。別のタブを見ている間も通知できますが、ブラウザの休止や端末のスリープで遅れる場合があります。</p>
</section>
</main><footer><span>LESS DISTRACTION. MORE FOCUS.</span><span id="zone"></span></footer>`;
$('zone').textContent = zone;
document.querySelectorAll<HTMLButtonElement>('[data-setting]').forEach(button => button.onclick = () => {
  const selected = button.dataset.setting;
  for (const name of ['notification', 'sound', 'source']) $(`setting-${name}`).hidden = selected !== name;
  document.querySelectorAll<HTMLButtonElement>('[data-setting]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
});
$('world-clock-toggle').onchange = () => {
  showWorldClock = $<HTMLInputElement>('world-clock-toggle').checked;
  saveCities();
  select(mode);
};
$('primary-city').onchange = () => {
  const value = $<HTMLSelectElement>('primary-city').value;
  if (validCity(value)) { primaryCity = value; saveCities(); render(); }
};
document.querySelectorAll<HTMLSelectElement>('[data-city]').forEach(control => control.onchange = () => {
  if (validCity(control.value)) { worldCities[Number(control.dataset.city)] = control.value; saveCities(); render(); }
});
const pad = (n: number) => String(n).padStart(2, '0');
function format(ms: number, fraction = false) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const base = `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  return fraction ? `${base}.${pad(Math.floor(ms / 10) % 100)}` : base;
}
function persist() {
  try { localStorage.setItem('tempo-timer', JSON.stringify({ duration, remaining, deadline })); } catch { /* Storage is optional. */ }
}
try {
  const saved = JSON.parse(localStorage.getItem('tempo-timer') || 'null');
  if (saved && Number.isFinite(saved.duration) && saved.duration > 0 && saved.duration <= 359_999_000 && Number.isFinite(saved.remaining) && saved.remaining >= 0 && (saved.deadline === null || Number.isFinite(saved.deadline))) {
    ({ duration, remaining, deadline } = saved);
  }
} catch { /* Ignore invalid saved state. */ }
function message(text: string) { $('message').textContent = text; }
// Generate short presets on demand; no extra audio downloads are needed.
function synthesizeAlarm(context: AudioContext, kind: Exclude<SoundChoice, 'default' | 'custom'>) {
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.ceil(rate * 4), rate);
  const samples = buffer.getChannelData(0);
  function tone(start: number, duration: number, frequency: number, volume: number, bright = false, decay = false) {
    const count = Math.floor(duration * rate);
    for (let i = 0; i < count; i++) {
      const index = Math.floor(start * rate) + i;
      if (index >= samples.length) break;
      const t = i / rate;
      const phase = 2 * Math.PI * frequency * t;
      const wave = bright
        ? (Math.sin(phase) + .33 * Math.sin(phase * 3) + .2 * Math.sin(phase * 5)) / 1.53
        : Math.sin(phase) * .8 + Math.sin(phase * 2.01) * .2;
      const envelope = Math.min(1, t / .008, (duration - t) / .025) * (decay ? Math.exp(-4 * t / duration) : 1);
      samples[index] += wave * volume * envelope;
    }
  }
  if (kind === 'warning') {
    for (let i = 0; i < 8; i++) tone(i * .45, .34, i % 2 ? 1175 : 880, .8, true);
  } else if (kind === 'chime') {
    [523.25, 659.25, 783.99].forEach((hz, i) => tone(i * .55, 1.8, hz, .48, false, true));
  } else if (kind === 'digital') {
    for (let group = 0; group < 3; group++) for (let i = 0; i < 3; i++) tone(group * 1.1 + i * .2, .12, 1000, .65, true);
  } else {
    for (const start of [0, 1.7]) {
      tone(start, 2.2, 740, .6, false, true);
      tone(start, 1.4, 1483, .18, false, true);
    }
  }
  return buffer;
}
function loadAlarm(context: AudioContext) {
  if (alarmBuffer) return alarmBuffer;
  const revision = soundRevision;
  if (selectedSound !== 'default' && selectedSound !== 'custom') {
    alarmBuffer = Promise.resolve(synthesizeAlarm(context, selectedSound));
    return alarmBuffer;
  }
  const data = selectedSound === 'custom' && customSound
    ? customSound.blob.arrayBuffer()
    : fetch(alertUrl).then(response => {
      if (!response.ok) throw new Error('Alarm download failed');
      return response.arrayBuffer();
    });
  alarmBuffer ??= data.then(bytes => context.decodeAudioData(bytes))
    .catch(error => { if (revision === soundRevision) alarmBuffer = undefined; throw error; });
  return alarmBuffer;
}
function stopAlarm() {
  alarmGeneration++;
  alarmPlaying = false;
  for (const source of alarmNodes) {
    try { source.stop(); } catch { /* Already ended. */ }
    source.disconnect();
  }
  alarmNodes = [];
  $('sound-test').textContent = '音を試す';
}
async function playAlarm() {
  stopAlarm();
  const generation = alarmGeneration;
  alarmPlaying = true;
  $('sound-test').textContent = '音を止める';
  try {
    audio ??= new AudioContext();
    const context = audio;
    const [, buffer] = await Promise.all([context.resume(), loadAlarm(context)]);
    if (generation !== alarmGeneration) return;
    if (context.state !== 'running') throw new Error('Audio suspended');
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      source.disconnect();
      alarmNodes = alarmNodes.filter(node => node !== source);
      if (generation === alarmGeneration) {
        alarmPlaying = false;
        $('sound-test').textContent = '音を試す';
      }
    };
    alarmNodes.push(source);
    source.start();
  } catch {
    if (generation !== alarmGeneration) return;
    stopAlarm();
    message('終了音を再生できませんでした。「音を試す」を押して確認してください。');
  }
}
async function showSystemNotification(test = false) {
  await notificationReady;
  const title = test ? 'TEMPO — 通知テスト' : 'TEMPO — タイマー終了';
  const options = { body: test ? '通知を受け取れました。タイマー終了時もここに表示します。' : '設定した時間になりました。', tag: test ? 'tempo-test' : 'tempo-timer' };
  if (registration) await registration.showNotification(title, options);
  else new Notification(title, options);
}
async function notify() {
  message('タイマーが終了しました。おつかれさまでした！');
  $('alarm-banner').hidden = false;
  if (sound) void playAlarm();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { await showSystemNotification(); }
    catch { message('タイマーが終了しました。システム通知は表示できませんでした。'); }
  }
}
$('alarm-dismiss').onclick = () => { stopAlarm(); $('alarm-banner').hidden = true; };
$('sound-test').onclick = () => { if (alarmPlaying) stopAlarm(); else void playAlarm(); };
$('notification-test').onclick = async () => {
  const button = $('notification-test') as HTMLButtonElement;
  button.disabled = true;
  try {
    await showSystemNotification(true);
    message('テスト通知を送信しました。表示されない場合は、端末の通知設定や「集中モード」を確認してください。');
  } catch { message('通知を送信できませんでした。ブラウザの通知許可と、HTTPS または localhost で開いているかを確認してください。'); }
  finally { button.disabled = false; notificationStatus(); }
};
function currentElapsed() { return elapsed + (started === null ? 0 : performance.now() - started); }
function render() {
  const now = new Date();
  if (deadline !== null) {
    remaining = Math.max(0, deadline - Date.now());
    if (!remaining) { deadline = null; persist(); void notify(); }
  }
  if (mode === 'settings') { document.title = 'TEMPO — 設定'; return; }
  let display: string;
  if (mode === 'clock') {
    const timeZone = showWorldClock ? primaryCity : zone;
    const current = cityTime(timeZone, now);
    display = current.time;
    $('date').textContent = current.date;
    $('caption').textContent = `${showWorldClock ? cities.find(city => city[1] === primaryCity)![0] : 'ローカル時刻'} · ${current.offset}${timeZone === 'Asia/Tokyo' ? ' / JST' : ''}`;
    $('zone').textContent = timeZone;
    if (showWorldClock) worldCities.forEach((timeZone, i) => {
      const current = cityTime(timeZone, now);
      $(`city-time-${i}`).textContent = current.time;
      $(`city-date-${i}`).textContent = current.date;
      $(`city-offset-${i}`).textContent = current.offset;
    });
  } else if (mode === 'timer') {
    display = format(Math.ceil(remaining / 1000) * 1000);
    $('date').textContent = 'ひとつのことに、集中する時間。';
    $('caption').textContent = deadline ? `終了予定 ${new Date(deadline).toLocaleTimeString('ja-JP')}` : remaining === 0 ? 'TIME IS UP' : 'READY WHEN YOU ARE';
    ($('progress').firstElementChild as HTMLElement).style.width = `${Math.min(100, remaining / duration * 100)}%`;
  } else {
    display = format(currentElapsed(), true);
    $('date').textContent = '積み重ねた時間を、見えるかたちに。';
    $('caption').textContent = started === null ? 'READY WHEN YOU ARE' : 'EVERY SECOND COUNTS';
  }
  if ($('digits').textContent !== display) $('digits').textContent = display;
  $('timer-toggle').textContent = deadline === null ? (remaining === 0 ? 'もう一度' : 'スタート') : '一時停止';
  $('stopwatch-toggle').textContent = started === null ? 'スタート' : '一時停止';
  ($('lap') as HTMLButtonElement).disabled = started === null;
  document.title = mode === 'timer' ? `${display} — TEMPO` : `TEMPO — ${mode === 'clock' ? '時計' : 'ストップウォッチ'}`;
}
let tick: number;
function schedule() { clearTimeout(tick); render(); tick = window.setTimeout(schedule, document.hidden ? 1000 : mode === 'stopwatch' && started !== null ? 33 : 1000 - Date.now() % 1000); }
function select(next: Mode) {
  mode = next;
  const worldVisible = mode === 'clock' && showWorldClock;
  $('app').classList.toggle('clock-view', worldVisible);
  $('app').classList.toggle('local-clock-view', mode === 'clock' && !showWorldClock);
  $('world-clock-control').hidden = mode !== 'clock';
  $<HTMLInputElement>('world-clock-toggle').checked = showWorldClock;
  $('world-map').hidden = !worldVisible;
  $('world-clocks').hidden = !worldVisible;
  $('primary-city-control').hidden = !worldVisible;
  $('time-label').innerHTML = `<i></i> ${worldVisible ? 'WORLD TIME' : 'LOCAL TIME'}`;
  if (mode !== 'clock') $('zone').textContent = zone;
  $('stage').hidden = mode === 'settings';
  $('settings').hidden = mode !== 'settings';
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => { const active = button.dataset.mode === mode; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
  $('timer-controls').hidden = mode !== 'timer'; $('stopwatch-controls').hidden = mode !== 'stopwatch'; $('progress').hidden = mode !== 'timer';
  $('digits').classList.toggle('stopwatch', mode === 'stopwatch');
  $('digits').setAttribute('aria-label', mode === 'clock' ? '現在時刻' : mode === 'timer' ? '残り時間' : '経過時間');
  $('eyebrow').textContent = mode === 'clock' ? 'MAKE TIME FOR WHAT MATTERS' : mode === 'timer' ? 'A LITTLE FOCUS GOES A LONG WAY' : 'ONE MOMENT AT A TIME';
  schedule();
}
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => select(button.dataset.mode as Mode));
function setDuration(ms: number) {
  if (deadline !== null) { message('時間を変更するには、タイマーを一時停止してください。'); return; }
  duration = remaining = ms; persist(); message('');
  updateDurationInputs(ms);
  document.querySelectorAll<HTMLButtonElement>('[data-minutes]').forEach(b => b.classList.toggle('active', Number(b.dataset.minutes) * 60000 === ms)); render();
}
document.querySelectorAll<HTMLButtonElement>('[data-minutes]').forEach(b => b.onclick = () => setDuration(Number(b.dataset.minutes) * 60000));
$('timer-details-toggle').onchange = () => {
  $('custom').hidden = !$<HTMLInputElement>('timer-details-toggle').checked;
};
function updateDurationInputs(ms: number) {
  $<HTMLInputElement>('hours').value = String(Math.floor(ms / 3_600_000));
  $<HTMLInputElement>('minutes').value = String(Math.floor(ms / 60_000) % 60);
  $<HTMLInputElement>('seconds').value = String(Math.floor(ms / 1000) % 60);
}
$('custom').onsubmit = event => {
  event.preventDefault();
  const values = ['hours', 'minutes', 'seconds'].map(id => $<HTMLInputElement>(id).value);
  const [hours, minutes, seconds] = values.map(Number);
  if (values.every(value => value.trim() !== '') && [hours, minutes, seconds].every(Number.isInteger)
      && hours >= 0 && hours <= 99 && minutes >= 0 && minutes <= 59 && seconds >= 0 && seconds <= 59
      && hours + minutes + seconds > 0) {
    setDuration((hours * 3600 + minutes * 60 + seconds) * 1000);
  } else message('時間は0〜99、分・秒は0〜59で、合計1秒以上を入力してください。');
};
$('timer-toggle').onclick = () => {
  render();
  stopAlarm(); $('alarm-banner').hidden = true;
  if (deadline !== null) { remaining = Math.max(0, deadline - Date.now()); deadline = null; }
  else { if (!remaining) remaining = duration; deadline = Date.now() + remaining; message(''); if (sound) { try { audio ??= new AudioContext(); void audio.resume().catch(() => {}); void loadAlarm(audio).catch(() => {}); } catch { /* Notification remains available. */ } } }
  persist(); schedule();
};
$('timer-reset').onclick = () => { stopAlarm(); $('alarm-banner').hidden = true; deadline = null; remaining = duration; persist(); message(''); render(); };
$('stopwatch-toggle').onclick = () => { if (started === null) started = performance.now(); else { elapsed = currentElapsed(); started = null; } schedule(); };
$('stopwatch-reset').onclick = () => { started = null; elapsed = 0; laps = []; lapPage = 0; renderLaps(); schedule(); };
let lapPage = 0;
const lapsPerPage = 3;
function renderLaps() {
  const pages = Math.max(1, Math.ceil(laps.length / lapsPerPage));
  lapPage = Math.min(lapPage, pages - 1);
  const end = laps.length - lapPage * lapsPerPage;
  const begin = Math.max(0, end - lapsPerPage);
  $('laps').innerHTML = laps.slice(begin, end).map((total, i) => {
    const index = begin + i;
    return `<li><span>LAP ${pad(index + 1)}</span><span>+ ${format(total - (laps[index - 1] ?? 0), true)}</span><span>${format(total, true)}</span></li>`;
  }).reverse().join('');
  $('lap-pages').hidden = laps.length === 0;
  $('lap-page').textContent = `${lapPage + 1} / ${pages}`;
  $<HTMLButtonElement>('laps-newer').disabled = lapPage === 0;
  $<HTMLButtonElement>('laps-older').disabled = lapPage === pages - 1;
}
$('laps-newer').onclick = () => { lapPage = Math.max(0, lapPage - 1); renderLaps(); };
$('laps-older').onclick = () => { lapPage++; renderLaps(); };
$('lap').onclick = () => { if (started === null) return; laps.push(currentElapsed()); lapPage = 0; renderLaps(); };

$('sound').onclick = () => { sound = !sound; if (!sound) stopAlarm(); $('sound').setAttribute('aria-checked', String(sound)); $('sound-status').textContent = sound ? 'オン' : 'オフ'; void saveSound(); if (sound && deadline !== null) { try { audio ??= new AudioContext(); void audio.resume().catch(() => {}); void loadAlarm(audio).catch(() => {}); } catch { message('この環境では終了音を利用できません。'); } } };
function notificationStatus() {
  const supported = 'Notification' in window && window.isSecureContext;
  const permission = supported ? Notification.permission : 'denied';
  const badge = $('notification-badge');
  badge.textContent = !supported ? '利用できません' : permission === 'granted' ? '許可済み' : permission === 'denied' ? 'ブロック中' : '未設定';
  badge.classList.toggle('enabled', supported && permission === 'granted');
  $('notification-status').textContent = !supported
    ? 'この環境では画面への通知を使えません。終了音は別に設定できます。'
    : permission === 'granted'
      ? 'タイマーが終了すると通知を表示します。届かない場合は、端末の通知設定も確認してください。'
      : permission === 'denied'
        ? 'ブラウザのこのサイトの設定で「通知」を許可し、この画面に戻ってください。'
        : '「通知を許可する」を押し、ブラウザの確認画面で「許可」を選んでください。';
  $('notification-test').hidden = !supported || permission !== 'granted';
  $('notifications').hidden = !supported || permission !== 'default';
  ($('notifications') as HTMLButtonElement).disabled = !supported || permission !== 'default';
}
$('notifications').onclick = async () => { try { await Notification.requestPermission(); } catch { message('通知の許可を取得できませんでした。'); } notificationStatus(); };
$('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { message('このブラウザでは全画面表示を利用できません。'); } };
window.addEventListener?.('focus', notificationStatus);
document.addEventListener('visibilitychange', () => { notificationStatus(); schedule(); });
if ('serviceWorker' in navigator && window.isSecureContext) notificationReady = navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(async () => { registration = await navigator.serviceWorker.ready; }).catch(() => {});
updateDurationInputs(duration);
document.querySelectorAll<HTMLButtonElement>('[data-minutes]').forEach(b => b.classList.toggle('active', Number(b.dataset.minutes) * 60000 === duration));
notificationStatus(); select(deadline !== null ? 'timer' : 'clock');

// Store the original file in IndexedDB; never upload imported audio.
function soundStore(action: 'read' | 'write', value?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tempo-sounds', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Storage blocked'));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('settings', action === 'read' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('settings');
      const operation = action === 'read' ? store.get('sound') : store.put(value, 'sound');
      transaction.oncomplete = () => { db.close(); resolve(operation.result); };
      transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
}
function updateSoundChoice() {
  ($('sound-choice') as HTMLSelectElement).value = selectedSound;
  $('sound-caption').textContent = selectedSound === 'custom' ? '取り込んだMP3を終了音として再生します。' : builtInSounds.find(item => item.id === selectedSound)!.caption;
  const option = $('custom-option') as HTMLOptionElement;
  option.disabled = !customSound;
  option.textContent = customSound ? customSound.name : 'インポートしたMP3（未登録）';
  $('remove-sound').hidden = !customSound;
}
function changeSound() {
  stopAlarm(); soundRevision++; alarmBuffer = undefined; updateSoundChoice();
}
async function saveSound() {
  try {
    await soundStore('write', { customSound, selectedSound, sound });
    $('import-status').textContent = '設定をこのブラウザに保存しました。';
  } catch {
    $('import-status').textContent = 'このブラウザに保存できませんでした。今回の画面では利用できますが、再読み込みすると元に戻ります。';
  }
}
$('sound-choice').onchange = () => {
  selectedSound = validSound(($('sound-choice') as HTMLSelectElement).value);
  changeSound(); void saveSound();
};
$('import-sound').onclick = () => ($('sound-file') as HTMLInputElement).click();
$('sound-file').onchange = async () => {
  const input = $('sound-file') as HTMLInputElement;
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  if (!/\.mp3$/i.test(file.name) || file.size === 0 || file.size > 20 * 1024 * 1024) {
    $('import-status').textContent = '20MB以下の、空でないMP3ファイルを選んでください。'; return;
  }
  ($('import-sound') as HTMLButtonElement).disabled = true;
  $('import-status').textContent = '音声ファイルを確認しています…';
  try {
    audio ??= new AudioContext();
    // Decode before replacing a working sound, to reject corrupt files.
    await audio.decodeAudioData(await file.arrayBuffer());
    customSound = { name: file.name, blob: file }; selectedSound = 'custom';
    changeSound(); await saveSound();
  } catch { $('import-status').textContent = 'このMP3を読み込めませんでした。別のファイルを選んでください。'; }
  finally { ($('import-sound') as HTMLButtonElement).disabled = false; }
};
$('remove-sound').onclick = () => {
  customSound = undefined; selectedSound = 'default'; changeSound(); void saveSound();
};
async function restoreSound() {
  const controls = ['import-sound', 'sound-choice', 'remove-sound', 'sound'];
  controls.forEach(id => ($(id) as HTMLButtonElement).disabled = true);
  try {
    const saved = await soundStore('read');
    if (saved) {
      if (saved.customSound?.blob instanceof Blob && typeof saved.customSound.name === 'string') customSound = saved.customSound;
      selectedSound = validSound(saved.selectedSound);
      if (typeof saved.sound === 'boolean') sound = saved.sound;
      $('sound').setAttribute('aria-checked', String(sound)); $('sound-status').textContent = sound ? 'オン' : 'オフ';
      changeSound();
    }
  } catch { $('import-status').textContent = 'ブラウザ内の保存を利用できません。取り込んだ音はこの画面を開いている間だけ使えます。'; }
  finally { controls.forEach(id => ($(id) as HTMLButtonElement).disabled = false); }
}
updateSoundChoice();
void restoreSound();
