import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('URLが無いと使い方を出して止まる', () => {
	const r = spawnSync(process.execPath, ['make.mjs'], { encoding: 'utf8' });
	assert.notStrictEqual(r.status, 0);
	assert.match(r.stderr, /使い方/);
});
test('設定の見本は読める形で、話し手と声がある', () => {
	const c = JSON.parse(readFileSync('config.sample.json', 'utf8'));
	assert.ok(c.speaker.name && c.speaker.faces.normal && c.voice.engine);
});
for (const f of ['make.mjs', 'server.mjs', 'doctor.mjs', 'slug.mjs']) {
	test(`${f} の書き方に誤りが無い`, () => {
		assert.strictEqual(spawnSync(process.execPath, ['--check', f]).status, 0);
	});
}
test('出力フォルダの名前：プレビューURLは記事の番号、ふつうのURLは最後の部分', async () => {
	const { slugOf } = await import('../slug.mjs');
	assert.strictEqual(slugOf('https://example.com/?p=123'), '123');
	assert.strictEqual(slugOf('https://example.com/claude-code-schedule/'), 'claude-code-schedule');
	assert.strictEqual(slugOf('https://example.com/a/b.html'), 'b');
	assert.strictEqual(slugOf('https://example.com/'), 'video');
});
test('画面（server.mjs）も make.mjs と同じ名前の決め方を使う', () => {
	for (const f of ['make.mjs', 'server.mjs']) assert.match(readFileSync(f, 'utf8'), /import \{ slugOf \} from '\.\/slug\.mjs'/);
});
test('画面から保存しても、声の種類（engine）を書き換えない', () => {
	assert.doesNotMatch(readFileSync('ui/index.html', 'utf8'), /engine:\s*'say'/);
});
test('画面のAPIは、ほかのサイトからの呼び出しを断る', async () => {
	const { spawn } = await import('node:child_process');
	const PORT = '8743';
	const p = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT, NO_OPEN: '1' } });
	try {
		await new Promise(r => p.stdout.once('data', r));
		const post = headers => fetch(`http://127.0.0.1:${PORT}/api/make`, { method: 'POST', headers, body: '{"url":"x"}' }).then(r => r.status);
		assert.strictEqual(await post({}), 400);   // 手元から（Origin なし）は通る。URLが変なので400
		assert.strictEqual(await post({ Origin: `http://127.0.0.1:${PORT}` }), 400);   // 画面から
		assert.strictEqual(await post({ Origin: 'https://evil.example' }), 403);   // ほかのサイトから
		assert.strictEqual(await post({ Origin: 'null' }), 403);
		// 名前を付け替えて入ってくる（DNSリバインディング）。fetch は Host を変えられないので http で送る
		const { request } = await import('node:http');
		const viaHost = await new Promise((r, j) => request({ host: '127.0.0.1', port: PORT, path: '/api/config', headers: { Host: `evil.example:${PORT}` } }, res => { res.resume(); r(res.statusCode); }).on('error', j).end());
		assert.strictEqual(viaHost, 403);
		const bad = await fetch(`http://127.0.0.1:${PORT}/api/make`, { method: 'POST', body: '{壊れた' });
		assert.strictEqual(bad.status, 500);   // 壊れたJSONでもサーバーは落ちない
		assert.strictEqual(await post({}), 400);
	} finally { p.kill(); }
});
