// 記事のURLを1つ入れると、話し手が解説する1分の縦動画（1080×1920・字幕と声つき）を作る
// 使い方: node make.mjs <記事のURL> [--config 設定.json] [--no-ai] [--no-images] [--redo] [--out 出力先]
//   出力: out/<記事の名前>/<記事の名前>.mp4（--out で出力先を変えられる）
//   台本.json がすでにあれば、それを使う（作り直すときは --redo）
// 流れ: 記事を取る → 台本（Claude Code があれば頼む。無ければ見出しと太字から作る）→ 声（Macの say か VOICEVOX）→ 画面（Playwright）→ つなぐ（ffmpeg）
// Mac と Windows（試験的）で動く。自分の記事のURLで使ってください。他人の記事を動画にするのは、著作権の面で問題になることがあります。
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const url = args.find(a => /^https?:\/\//.test(a));
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
if (!url) { console.error('使い方: node make.mjs <記事のURL> [--config 設定.json] [--no-ai] [--redo]'); process.exit(1); }

// 設定（話し手・顔・色・声・読み替え）
const cfgPath = resolve(opt('--config') || (existsSync(join(here, 'config.json')) ? join(here, 'config.json') : join(here, 'config.sample.json')));
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const fromCfg = p => (isAbsolute(p) ? p : resolve(dirname(cfgPath), p));

// Playwright は、このフォルダか上の node_modules から読む
let chromium;
for (const base of [here, join(here, '../../theme/eyecatch')]) {
	try { chromium = createRequire(join(base, 'package.json'))('playwright').chromium; break; } catch {}
}
if (!chromium) { console.error('Playwright がありません。このフォルダで npm install を実行してください'); process.exit(1); }

const slug = (new URL(url).pathname.split('/').filter(Boolean).pop() || 'video').replace(/\.html?$/, '');
const out = join(resolve(opt('--out') || join(here, 'out')), slug); mkdirSync(join(out, 'scene'), { recursive: true });
const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
const strip = s => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// 1. 記事を取る（WordPress なら公開API、それ以外はページの本文）
async function getArticle() {
	const origin = new URL(url).origin;
	try {
		const r = await fetch(`${origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=title,content`);
		const j = r.ok ? await r.json() : [];
		if (j[0]) return { title: strip(j[0].title.rendered), html: j[0].content.rendered };
	} catch {}
	const page = await (await fetch(url)).text();
	const title = strip((page.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || page.match(/<title>([\s\S]*?)<\/title>/) || ['', slug])[1]);
	const body = (page.match(/<article[\s\S]*?<\/article>/) || page.match(/<main[\s\S]*?<\/main>/) || [page])[0];
	return { title, html: body };
}
const mine = (cfg.my_sites || []).some(h => new URL(url).host === h || new URL(url).host.endsWith('.' + h));
if (!mine) console.log('WARN このURLはあなたのブログとして登録されていません（設定の my_sites）。自分で見るだけにして、投稿や共有はしないでください。');
const { title, html } = await getArticle();
console.log(`STEP 記事を取りました：${title}`);
// 引用（blockquote）は、他の人の文章のことがあるので、台本の材料から外す
const clean = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<blockquote[\s\S]*?<\/blockquote>/g, '');
const images = [...clean.matchAll(/<img[^>]+>/g)].map(m => ({ src: (m[0].match(/src="([^"]+)"/) || [])[1], alt: decode((m[0].match(/alt="([^"]*)"/) || ['', ''])[1]), at: m.index }))
	.filter(m => m.src && !/avatar|icon|logo|emoji/i.test(m.src))
	// 画像は、記事と同じサイトに置いてあるものだけ使う（他のサイトの画像は、動画に使ってよいかわからない）
	.filter(m => { try { return new URL(m.src, url).host === new URL(url).host; } catch { return false; } })
	.filter(() => !args.includes('--no-images'));
const skip = /よくある質問|まとめ|出典|参考|関連|目次|書いた人|プロフィール/;
const sections = [...clean.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/g)].map(m => {
	const head = strip(m[1]);
	const ans = strip((m[2].match(/<strong[^>]*>([\s\S]*?)<\/strong>/) || m[2].match(/<p[^>]*>([\s\S]*?)<\/p>/) || ['', ''])[1]);
	const img = images.findIndex(im => im.at > m.index && im.at < m.index + m[0].length);
	return { head, ans, img: img >= 0 ? img : null };
}).filter(s => s.head && !skip.test(s.head) && s.ans);
const summary = (() => { const m = clean.match(/<h2[^>]*>[^<]*まとめ[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>/); return m ? strip(m[1]) : ''; })();

// 読み上げ用の読み替え（英字の名前など）
const reading = s => Object.entries(cfg.reading || {}).reduce((t, [k, v]) => t.split(k).join(v), s);
const main = title.split(/[｜|]/)[0].trim();

// 2. 台本
const scriptFile = join(out, '台本.json');
const isWin = process.platform === 'win32';
const hasClaude = !args.includes('--no-ai') && spawnSync(isWin ? 'where' : 'which', ['claude']).status === 0;
function templateScript() {
	const pick = sections.slice(0, 5);
	const sc = [{ say: `今日は「${main}」を、1分で紹介します。`, show: main.length > 22 ? main.slice(0, 21) + '…' : main, face: 'normal', img: null }];
	const short = h => { const t = (h.split(/[：:]/)[1] || h).trim(); return t.length > 20 ? t.slice(0, 19) + '…' : t; };
	for (const s of pick) sc.push({ say: s.ans, show: short(s.head), face: 'normal', img: s.img });
	sc.push({ say: `${summary ? summary + '　' : ''}詳しくは、ブログで読んでみてください。`, show: '詳しくはブログで', face: 'doya', img: null });
	return { scenes: sc, by: 'template' };
}
function aiScript() {
	const text = strip(clean).slice(0, 9000);
	const prompt = `ブログ記事から、縦動画（全体で50〜60秒）の台本をJSONだけで返して。説明やコードブロックの印は付けない。
話し手は「${cfg.speaker.name}」。${cfg.speaker.persona || ''}一人称は「${cfg.speaker.first_person || '私'}」。「筆者」とは言わない。
形：{"scenes":[{"say":"読み上げる文（1場面1〜2文・合計で日本語420字まで）","show":"画面に大きく出す要点（20字まで）","face":"normal|komari|doya","img":画像番号かnull}]}
場面は5〜7個。1場面目は見る人の困りごと、最後は「詳しくはブログで」。
数字・名前・手順は記事に書いてあるものだけを使う。記事に無いことは言わない。引用（他の人の文章）は使わない。
使える画像（番号：説明）：
${images.map((m, i) => `${i}：${m.alt.slice(0, 120)}`).join('\n')}
題名：${title}
本文：${text}`;
	const res = execFileSync('claude', ['-p', prompt, '--output-format', 'text'], { encoding: 'utf8', maxBuffer: 1 << 24, shell: isWin });
	const j = JSON.parse(res.slice(res.indexOf('{'), res.lastIndexOf('}') + 1));
	return { ...j, by: 'claude' };
}
if (args.includes('--redo') || !existsSync(scriptFile)) {
	let sc;
	try { sc = hasClaude ? aiScript() : templateScript(); } catch (e) { console.error('Claude での台本づくりに失敗したので、見出しから作ります：', e.message.split('\n')[0]); sc = templateScript(); }
	writeFileSync(scriptFile, JSON.stringify(sc, null, 2));
}
const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
console.log(`STEP 台本ができました（${script.by === 'claude' ? 'Claude Code' : '見出しと太字'}から・${script.scenes.length}場面）`);
const scenes = script.scenes;

// 3. 声（Mac は say、Windows は最初から入っている読み上げ。設定で VOICEVOX も選べる）
const PS_SPEAK = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -eq $env:TV_VOICE -or ($env:TV_VOICE -eq '' -and $_.VoiceInfo.Culture.Name -eq 'ja-JP') } | Select-Object -First 1;
if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $s.Rate = [int]$env:TV_RATE; $s.SetOutputToWaveFile($env:TV_OUT); $s.Speak($env:TV_TEXT); $s.Dispose()`;
async function speak(text, file) {
	const v = cfg.voice || {};
	const engine = !v.engine || v.engine === 'auto' ? (isWin ? 'windows' : 'say') : (v.engine === 'say' && isWin ? 'windows' : v.engine);
	if (engine === 'windows') {
		execFileSync('powershell', ['-NoProfile', '-Command', PS_SPEAK], { env: { ...process.env, TV_TEXT: text, TV_OUT: file, TV_VOICE: v.windows_name || '', TV_RATE: String(v.windows_rate ?? 1) } });
	} else if (engine === 'voicevox') {
		const base = v.url || 'http://127.0.0.1:50021', sp = v.speaker ?? 3;
		const q = await (await fetch(`${base}/audio_query?speaker=${sp}&text=${encodeURIComponent(text)}`, { method: 'POST' })).json();
		q.speedScale = v.speed || 1.15;
		const wav = Buffer.from(await (await fetch(`${base}/synthesis?speaker=${sp}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) })).arrayBuffer());
		writeFileSync(file, wav);
	} else {
		execFileSync('say', ['-v', v.name || 'Kyoko', '-r', String(v.rate || 205), '-o', file, '--file-format=WAVE', '--data-format=LEI16@22050', text]);
	}
	let sec = NaN;
	try { sec = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })); } catch {}
	if (!(sec > 0)) {   // 声が作れなかったとき（読み上げの声が入っていないパソコンなど）は、字幕だけ読める長さの無音にする
		sec = Math.max(2, [...text].length * 0.14);
		console.log('WARN 声を作れなかったので、この場面は無音にしました（読み上げの声が入っているか node doctor.mjs で確かめてください）');
		execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', String(sec), file]);
	}
	return sec;
}
for (const [i, s] of scenes.entries()) { s.sec = (await speak(reading(s.say), join(out, 'scene', `${i}.wav`))) + 0.35; console.log(`STEP 声 ${i + 1}/${scenes.length}`); }

// 4. 画面（1080×1920）
const c = cfg.colors || {};
const css = `
:root{--paper:${c.paper || '#FBF9F4'};--ink:${c.ink || '#23272F'};--soft:${c.soft || '#5A5F69'};--rule:${c.rule || '#E3DED2'};--accent:${c.accent || '#D9622B'};--marker:${c.marker || '#FFD8A6'}}
*{box-sizing:border-box;margin:0}
html,body{width:1080px;height:1920px}
body{font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Meiryo","Noto Sans JP",sans-serif;color:var(--ink);background:var(--paper)}
.wrap{position:relative;height:100%;padding:80px 60px}
.top{display:flex;gap:16px;align-items:center;font-size:30px;color:var(--soft);font-weight:700}
.top b{background:var(--accent);color:#fff;border-radius:8px;padding:6px 14px;font-size:28px}
.title{margin-top:22px;font-size:38px;font-weight:800;line-height:1.4;color:var(--soft)}
.media{position:absolute;left:60px;right:60px;top:300px;bottom:600px;display:flex;flex-direction:column;gap:36px;align-items:center;justify-content:center}
.media img{max-width:100%;max-height:640px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.12);background:#fff}
.big{font-size:84px;font-weight:900;line-height:1.3;text-align:center}
.media img+.big{font-size:62px}
.big mark{background:linear-gradient(transparent 62%,var(--marker) 62%);color:inherit}
.cap{position:absolute;left:60px;right:270px;bottom:190px;min-height:330px;display:flex;align-items:center;font-size:46px;font-weight:700;line-height:1.5;background:#fff;border:2px solid var(--rule);border-radius:18px;padding:26px 30px}
.face{position:absolute;right:48px;bottom:190px;width:200px;height:200px;border-radius:50%;background:#FFE8D4;overflow:hidden}
.face img{width:100%;height:100%;object-fit:cover}
.foot{position:absolute;left:60px;right:60px;bottom:80px;display:flex;justify-content:space-between;font-size:30px;color:var(--soft)}
`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const faceSrc = f => {
	const p = fromCfg((cfg.speaker.faces || {})[f] || (cfg.speaker.faces || {}).normal);
	const type = p.endsWith('.svg') ? 'image/svg+xml' : p.endsWith('.png') ? 'image/png' : 'image/jpeg';
	return `data:${type};base64,${readFileSync(p).toString('base64')}`;
};
const b = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const pg = await b.newPage({ viewport: { width: 1080, height: 1920 } });
for (const [i, s] of scenes.entries()) {
	const im = Number.isInteger(s.img) && images[s.img] ? `<img src="${new URL(images[s.img].src, url).href}">` : '';
	await pg.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style><div class="wrap">
<div class="top"><b>${i + 1}/${scenes.length}</b>${esc(cfg.site || '')}</div>
<div class="title">${esc(main)}</div>
<div class="media">${im}<div class="big"><mark>${esc(s.show)}</mark></div></div>
<div class="cap">${esc(s.say)}</div>
<div class="face"><img src="${faceSrc(s.face)}"></div>
<div class="foot"><span>${esc(cfg.speaker.name)}</span><span>${esc(new URL(url).host)}</span></div></div>`, { waitUntil: 'networkidle' });
	await pg.screenshot({ path: join(out, 'scene', `${i}.png`) });
	console.log(`STEP 画面 ${i + 1}/${scenes.length}`);
}
await b.close();

// 5. つなぐ
const parts = [];
for (const [i, s] of scenes.entries()) {
	const v = join(out, 'scene', `${i}.mp4`);
	execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-t', String(s.sec), '-i', join(out, 'scene', `${i}.png`), '-i', join(out, 'scene', `${i}.wav`),
		'-af', 'apad', '-t', String(s.sec), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-ar', '44100', v]);
	parts.push(`file '${v}'`);
}
writeFileSync(join(out, 'list.txt'), parts.join('\n'));
console.log('STEP 動画をつないでいます');
const mp4 = join(out, `${slug}.mp4`);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(out, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', mp4]);
console.log(`DONE ${slug}`);
console.log(`${mp4}（${scenes.length}場面・${scenes.reduce((t, s) => t + s.sec, 0).toFixed(1)}秒・台本は${script.by === 'claude' ? 'Claude Code' : '見出しと太字'}から）`);
