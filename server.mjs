// 記事から縦動画を作る画面（このMacの中だけで開く。127.0.0.1 からしか使えない）
// 使い方: node server.mjs   → ブラウザで http://127.0.0.1:8742 が開く
import { spawn, execFileSync } from 'child_process';
import { createServer } from 'http';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, normalize } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8742);
const cfgFile = join(here, 'config.json');
const loadCfg = () => JSON.parse(readFileSync(existsSync(cfgFile) ? cfgFile : join(here, 'config.sample.json'), 'utf8'));
const jobs = new Map();   // id → { lines, done, slug, error }

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
	res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
	res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = req => new Promise(r => { let d = ''; req.on('data', c => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : {})); });
const slugOf = u => (new URL(u).pathname.split('/').filter(Boolean).pop() || 'video').replace(/\.html?$/, '');

function voices() {
	if (process.platform === 'win32') {   // Windows に入っている読み上げの声
		const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }'], { encoding: 'utf8' });
		return { say: out.split(/\r?\n/).map(s => s.trim()).filter(Boolean), engine: 'windows' };
	}
	const say = execFileSync('say', ['-v', '?'], { encoding: 'utf8' }).split('\n').filter(l => /ja_JP/.test(l)).map(l => l.split(/\s{2,}/)[0].trim());
	return { say, engine: 'say' };
}

createServer(async (req, res) => {
	const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
	try {
		if (u.pathname === '/') return send(res, 200, readFileSync(join(here, 'ui', 'index.html')), 'text/html; charset=utf-8');
		if (u.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { cfg: loadCfg(), voices: voices() });
		if (u.pathname === '/api/config' && req.method === 'POST') {
			const b = await readBody(req); const cfg = loadCfg();
			cfg.site = b.site ?? cfg.site;
			if (b.my_sites) cfg.my_sites = b.my_sites.split(/[\s,、]+/).filter(Boolean);
			cfg.speaker.name = b.name || cfg.speaker.name;
			cfg.speaker.first_person = b.first_person || cfg.speaker.first_person;
			cfg.speaker.persona = b.persona ?? cfg.speaker.persona;
			if (b.face) {   // 顔の画像（1枚）を受け取ったら、3つの表情とも同じ画像にする
				const m = b.face.match(/^data:image\/(png|jpeg|svg\+xml);base64,(.+)$/);
				if (!m) return send(res, 400, { error: '顔の画像は PNG・JPEG・SVG にしてください' });
				mkdirSync(join(here, 'assets'), { recursive: true });
				const f = `assets/my-face.${m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : 'png'}`;
				writeFileSync(join(here, f), Buffer.from(m[2], 'base64'));
				cfg.speaker.faces = { normal: f, komari: f, doya: f };
			}
			cfg.voice = { ...cfg.voice, ...(b.voice || {}) };
			if (process.platform === 'win32' && b.voice?.name) { cfg.voice.windows_name = b.voice.name; delete cfg.voice.name; cfg.voice.engine = 'auto'; }
			if (b.accent) cfg.colors.accent = b.accent;
			writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
			return send(res, 200, { ok: true, cfg });
		}
		if (u.pathname === '/api/make' && req.method === 'POST') {
			const b = await readBody(req);
			if (!/^https?:\/\//.test(b.url || '')) return send(res, 400, { error: '記事のURLを入れてください' });
			const id = Date.now().toString(36);
			const job = { lines: [], done: false, slug: slugOf(b.url) };
			jobs.set(id, job);
			if (b.scenes) {   // 画面で直した台本で作り直す
				const f = join(here, 'out', job.slug, '台本.json');
				const old = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
				mkdirSync(dirname(f), { recursive: true });
				writeFileSync(f, JSON.stringify({ ...old, scenes: b.scenes }, null, 2));
			}
			const a = ['make.mjs', b.url];
			if (existsSync(cfgFile)) a.push('--config', cfgFile);
			if (b.noAi) a.push('--no-ai');
			if (b.noImages) a.push('--no-images');
			if (!b.scenes) a.push('--redo');
			const p = spawn(process.execPath, a, { cwd: here });
			const take = d => d.toString().split('\n').filter(Boolean).forEach(l => job.lines.push(l));
			p.stdout.on('data', take); p.stderr.on('data', take);
			p.on('close', code => { job.done = true; if (code) job.error = '途中で止まりました。下の記録を見てください'; });
			return send(res, 200, { id });
		}
		if (u.pathname === '/api/job') {
			const job = jobs.get(u.searchParams.get('id'));
			if (!job) return send(res, 404, { error: 'ありません' });
			const f = join(here, 'out', job.slug, '台本.json');
			return send(res, 200, { ...job, script: job.done && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null });
		}
		if (u.pathname === '/api/face') {   // 今の話し手の顔（ふつうの表情）
			const f = join(here, loadCfg().speaker.faces.normal);
			const t = f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.png') ? 'image/png' : 'image/jpeg';
			return send(res, 200, readFileSync(f), t);
		}
		if (u.pathname.startsWith('/out/')) {   // できた動画を返す（out の中だけ）
			const f = normalize(join(here, decodeURIComponent(u.pathname)));
			if (!f.startsWith(join(here, 'out')) || !existsSync(f)) return send(res, 404, 'not found', 'text/plain');
			res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': statSync(f).size });
			return createReadStream(f).pipe(res);
		}
		send(res, 404, 'not found', 'text/plain');
	} catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => {
	const addr = `http://127.0.0.1:${PORT}`;
	console.log(`画面を開きました：${addr}（止めるときは Ctrl＋C）`);
	if (!process.env.NO_OPEN) process.platform === 'win32' ? spawn('cmd', ['/c', 'start', '', addr]) : spawn('open', [addr]);
});
