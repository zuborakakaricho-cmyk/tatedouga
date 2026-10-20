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
for (const f of ['make.mjs', 'server.mjs', 'doctor.mjs']) {
	test(`${f} の書き方に誤りが無い`, () => {
		assert.strictEqual(spawnSync(process.execPath, ['--check', f]).status, 0);
	});
}
