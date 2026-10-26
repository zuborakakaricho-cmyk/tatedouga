// 記事のURLから、出力フォルダの名前を決める（make.mjs と server.mjs で同じ名前になるように、ここ1か所で決める）
// プレビューURL（?p=123）なら記事の番号を名前にする
export const slugOf = u => new URL(u).searchParams.get('p') || (new URL(u).pathname.split('/').filter(Boolean).pop() || 'video').replace(/\.html?$/, '');
