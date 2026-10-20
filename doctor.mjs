// 点検：このパソコンで「記事から縦動画」が動くかを確かめ、足りないものと次に打つコマンドを出す
// 使い方: node doctor.mjs
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32', mac = process.platform === 'darwin';
const run = (c, a) => spawnSync(c, a, { encoding: 'utf8', shell: win });
const has = (c, a = ['-version']) => run(c, a).status === 0;
const rows = [];
const add = (name, ok, fix) => rows.push(`${ok ? '○' : '✕'} ${name}${ok ? '' : `　→ ${fix}`}`);
if (mac) {
	add('読み上げ（Mac の say）', has('say', ['-v', '?']), 'Mac の読み上げが使えません');
	add('日本語の声（Kyoko など）', /ja_JP/.test(run('say', ['-v', '?']).stdout || ''), 'システム設定 → アクセシビリティ → 読み上げコンテンツ → システムの声 で日本語の声を入れる');
} else if (win) {
	const v = spawnSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Culture.Name }'], { encoding: 'utf8' });
	add('読み上げ（Windows に入っている声）', v.status === 0 && v.stdout.trim() !== '', 'PowerShell から読み上げが使えません');
	add('日本語の声（Haruka など）', /ja-JP/.test(v.stdout || ''), '設定 → 時刻と言語 → 音声認識（または言語）で日本語の音声を追加する');
	rows.push('－ Windows は試験的です（日本語の声で動画を作るところまでは確かめていません）');
} else {
	add('Mac か Windows', false, 'この道具は Mac と Windows 用です');
}
add('ffmpeg（動画をつなぐ）', has('ffmpeg') && has('ffprobe'), mac ? 'brew install ffmpeg' : 'winget install Gyan.FFmpeg（入れたあとターミナルを開き直す）');
let pw = false; try { createRequire(join(here, 'package.json'))('playwright'); pw = true; } catch {}
add('Playwright（画面を作る）', pw, 'このフォルダで npm install');
const chrome = mac ? spawnSync('ls', ['/Applications/Google Chrome.app']).status === 0 : true;
add('ブラウザ（Chrome か Playwright のブラウザ）', chrome || pw, 'npx playwright install chromium');
const claude = run(win ? 'where' : 'which', ['claude']).status === 0;
rows.push(`${claude ? '○' : '－'} Claude Code（あれば台本が自然になる。無くても動く）`);
console.log(rows.join('\n'));
const ng = rows.filter(r => r.startsWith('✕')).length;
console.log(ng ? `\n足りないものが ${ng} つあります。→ の後のコマンドを打ってから、もう一度 node doctor.mjs` : '\nこのパソコンで動きます。次は npm start（画面が開きます）');
process.exit(ng ? 1 : 0);
