// 記事のURLを1つ入れると、話し手が解説する1分の縦動画（1080×1920・字幕と声つき）を作る
// 使い方: node make.mjs <記事のURL> [--config 設定.json] [--no-ai] [--no-images] [--redo] [--out 出力先]
//   出力: out/<記事の名前>/<記事の名前>.mp4（--out で出力先を変えられる）
//   台本.json がすでにあれば、それを使う（作り直すときは --redo）
//   下書きなど公開前の記事は、本文のHTMLを保存して --html 本文.html [--title 題名] で渡す（URLは ?p=123 のプレビューURLでよい）
//   記事に動画（<video>）があれば、その場面の間に早送りで流す（--no-videos で使わない）
// 流れ: 記事を取る → 台本（Claude Code があれば頼む。無ければ見出しと太字から作る）→ 声（Macの say か VOICEVOX）→ 画面（Playwright）→ つなぐ（ffmpeg）
// Mac と Windows（試験的）で動く。自分の記事のURLで使ってください。他人の記事を動画にするのは、著作権の面で問題になることがあります。
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { slugOf } from './slug.mjs';

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

const slug = slugOf(url);
const out = join(resolve(opt('--out') || join(here, 'out')), slug); mkdirSync(join(out, 'scene'), { recursive: true });
const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
const strip = s => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// 1. 記事を取る（WordPress なら公開API、それ以外はページの本文）
async function getArticle() {
	if (opt('--html')) {
		const html = readFileSync(resolve(opt('--html')), 'utf8');
		return { title: opt('--title') || strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || html.match(/<title>([\s\S]*?)<\/title>/) || ['', slug])[1]), html };
	}
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
// 画像と動画を、記事に出てくる順に並べる（動画の説明は、すぐ後の figcaption）
const images = [...clean.matchAll(/<img[^>]+>|<video[\s\S]*?<\/video>/g)].map(m => {
	if (m[0].startsWith('<img')) return { src: (m[0].match(/src="([^"]+)"/) || [])[1], alt: decode((m[0].match(/alt="([^"]*)"/) || ['', ''])[1]), at: m.index };
	const cap = clean.slice(m.index + m[0].length, m.index + m[0].length + 600).match(/^\s*<figcaption[^>]*>([\s\S]*?)<\/figcaption>/);
	return { src: (m[0].match(/src="([^"]+\.(?:mp4|mov|webm|m4v)[^"]*)"/i) || [])[1], alt: cap ? strip(cap[1]) : '', at: m.index, video: true };
})
	.filter(m => m.src && !/avatar|icon|logo|emoji/i.test(m.src))
	.filter(m => !(m.video && args.includes('--no-videos')))
	// 画像は、記事と同じサイトに置いてあるものだけ使う（他のサイトの画像は、動画に使ってよいかわからない）
	.filter(m => { try { return new URL(m.src, url).host === new URL(url).host; } catch { return false; } })
	.filter(m => m.video || !args.includes('--no-images'));
// 「まとめて選ぶと」のような見出しは飛ばさない
const skip = /よくある質問|まとめ(?![てたるれ])|出典|参考|関連|目次|書いた人|プロフィール/;
const sections = [...clean.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/g)].map(m => {
	const head = strip(m[1]);
	const ans = strip((m[2].match(/<strong[^>]*>([\s\S]*?)<\/strong>/) || m[2].match(/<p[^>]*>([\s\S]*?)<\/p>/) || ['', ''])[1]);
	const img = images.findIndex(im => im.at > m.index && im.at < m.index + m[0].length);
	return { head, ans, img: img >= 0 ? img : null };
}).filter(s => s.head && !skip.test(s.head) && s.ans);
const summary = (() => { const m = clean.match(/<h2[^>]*>[^<]*まとめ(?![てたるれ])[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>/); return m ? strip(m[1]) : ''; })();

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
${images.map((m, i) => `${i}：${m.video ? '【動画】' : ''}${m.alt.slice(0, 120)}`).join('\n')}
${images.some(m => m.video) ? '【動画】と付いたものは、その場面のあいだ早送りで流れる。【動画】が何本あっても、1本ずつ別の場面で使う（imgにその番号。同じ動画を2回使わない）。その場面の say は、動画で何が起きているかを話す。' : ''}
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
		// 文は -f でファイルから渡す（「-l ja」のように - で始まる文がオプションと読まれて落ちるため）
		const txt = file + '.txt';
		writeFileSync(txt, text);
		execFileSync('say', ['-v', v.name || 'Kyoko', '-r', String(v.rate || 205), '-o', file, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', txt]);
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
.media img+.big,.media .vidbox+.big{font-size:62px}
.vidbox{display:flex;flex-direction:column;align-items:center;gap:14px}
.vid{background:#000}
.media.side{flex-direction:row;gap:40px}
.media.side .big{flex:1;font-size:56px;text-align:left;text-wrap:balance}
.speed{font-size:30px;font-weight:700;color:var(--soft)}
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
// 動画の場面：動画を手元に落とし、長さと大きさを測って、早送りの倍率を決める（最大 video_max_speed 倍。超える分は頭から切る）
const probe = f => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', f], { encoding: 'utf8' });
for (const [i, s] of scenes.entries()) {
	const m = Number.isInteger(s.img) && images[s.img];
	if (!m || !m.video) continue;
	// 手元の名前は動画のURLから決める（場面の番号で決めると、台本を直して別の動画になっても古い動画を使ってしまう）
	const src = new URL(m.src, url).href;
	const file = join(out, 'scene', `src-${createHash('sha1').update(src).digest('hex').slice(0, 12)}${(m.src.match(/\.(mp4|mov|webm|m4v)/i) || ['.mp4'])[0]}`);
	if (!existsSync(file)) {
		const r = await fetch(src);
		if (!r.ok) throw new Error(`記事の動画を取れませんでした（${r.status}）：${src}`);
		writeFileSync(file, Buffer.from(await r.arrayBuffer()));
	}
	const j = JSON.parse(probe(file));
	const W = j.streams[0].width, H = j.streams[0].height, dur = parseFloat(j.format.duration);
	// 横長は幅いっぱい（高さ600まで）。縦長は高さを取って左に置き、要点は右に並べる
	const tall = H > W;
	const w = Math.round(Math.min(tall ? 560 : 960, (tall ? 940 : 600) * W / H) / 2) * 2, h = Math.round(w * H / W / 2) * 2;
	const speed = Math.min(Math.max(dur / s.sec, 1), cfg.video_max_speed || 6);
	s.video = { file, w, h, tall, speed, use: s.sec * speed };   // use＝元の動画から使う秒数
	console.log(`STEP 動画 ${i + 1}場面目：${dur.toFixed(1)}秒 → ${s.sec.toFixed(1)}秒（${speed.toFixed(1)}倍速）`);
}

const b = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const pg = await b.newPage({ viewport: { width: 1080, height: 1920 } });
for (const [i, s] of scenes.entries()) {
	const im = s.video ? `<div class="vidbox"><div class="vid" style="width:${s.video.w}px;height:${s.video.h}px"></div>${s.video.speed > 1.05 ? `<div class="speed">▶ ${s.video.speed.toFixed(1)}倍速</div>` : ''}</div>`
		: Number.isInteger(s.img) && images[s.img] ? `<img src="${new URL(images[s.img].src, url).href}">` : '';
	await pg.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style><div class="wrap">
<div class="top"><b>${i + 1}/${scenes.length}</b>${esc(cfg.site || '')}</div>
<div class="title">${esc(main)}</div>
<div class="media${s.video?.tall ? ' side' : ''}">${im}<div class="big"><mark>${esc(s.show)}</mark></div></div>
<div class="cap">${esc(s.say)}</div>
<div class="face"><img src="${faceSrc(s.face)}"></div>
<div class="foot"><span>${esc(cfg.speaker.name)}</span><span>${esc(new URL(url).host)}</span></div></div>`, { waitUntil: 'networkidle' });
	if (s.video) Object.assign(s.video, await pg.$eval('.vid', e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; }));
	await pg.screenshot({ path: join(out, 'scene', `${i}.png`) });
	console.log(`STEP 画面 ${i + 1}/${scenes.length}`);
}
await b.close();

// 5. つなぐ
const parts = [];
for (const [i, s] of scenes.entries()) {
	const v = join(out, 'scene', `${i}.mp4`);
	const enc = ['-af', 'apad', '-t', String(s.sec), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-ar', '44100', v];
	if (s.video) {   // 画面の黒い枠の位置に、早送りした動画を重ねる（動画が短ければ最後の絵で止める）
		const { file, w, h, x, y, speed, use } = s.video;
		execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-t', String(s.sec), '-i', join(out, 'scene', `${i}.png`), '-t', String(use), '-i', file, '-i', join(out, 'scene', `${i}.wav`),
			'-filter_complex', `[1:v]setpts=(PTS-STARTPTS)/${speed},fps=30,scale=${w}:${h},setsar=1,tpad=stop_mode=clone:stop_duration=${s.sec}[m];[0:v][m]overlay=${x}:${y}:shortest=0,format=yuv420p[v]`,
			'-map', '[v]', '-map', '2:a', ...enc]);
	} else {
		execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-t', String(s.sec), '-i', join(out, 'scene', `${i}.png`), '-i', join(out, 'scene', `${i}.wav`), ...enc]);
	}
	parts.push(`file '${v}'`);
}
writeFileSync(join(out, 'list.txt'), parts.join('\n'));
console.log('STEP 動画をつないでいます');
const mp4 = join(out, `${slug}.mp4`);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(out, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', mp4]);
console.log(`DONE ${slug}`);
console.log(`${mp4}（${scenes.length}場面・${scenes.reduce((t, s) => t + s.sec, 0).toFixed(1)}秒・台本は${script.by === 'claude' ? 'Claude Code' : '見出しと太字'}から）`);
