"""公開するファイルに、個人の情報・パソコン固有の情報・秘密が混ざっていないかを調べる。

  python -m pytest tests -q

このファイル自体には決まりの形（メアド・ホームのパス・キーの形・画像の埋め込み情報）だけを書き、
具体的な名前は書かない。伏せたい名前（本名・会社名・取引先・アカウント名など）は、公開しない場所の
ファイルに1行1語で書き、環境変数 KOKAI_PRIVATE_TERMS でそのパスを渡す
（既定は ~/.config/kokai/伏せる言葉.txt）。ファイルが無い環境（GitHub Actions など）ではその検査だけ飛ばす。
"""
import os
import pathlib
import re
import struct

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
THIS = pathlib.Path(__file__).resolve()
SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", ".venv", "node_modules"}
SKIP_FILES = {".DS_Store"}
# 中身を文字として読まない形式。画像は埋め込み情報を別に調べる
BINARY_OK = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".m4a", ".mp3", ".wav", ".mp4", ".pdf", ".docx", ".xlsx", ".pptx", ".zip"}

EMAIL = re.compile(r"[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
ALLOWED_EMAIL = re.compile(r"@(?:example\.(?:com|org|net|invalid)|users\.noreply\.github\.com)$", re.I)
LOCAL_PATH = re.compile(r"(?<![\w.])(?:/Users/(?!<)[^/\s\"'`<>]+|/home/(?!<)[^/\s\"'`<>]+|/private/(?:tmp|var)/|/var/folders/|[A-Za-z]:\\Users\\(?!<))")
CREDENTIAL = re.compile(
    r"(?:sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}"
    r"|AIza[0-9A-Za-z_-]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)


def files():
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file() or p.name in SKIP_FILES or p.resolve() == THIS:
            continue
        if SKIP_DIRS & set(p.relative_to(ROOT).parts):
            continue
        yield p


def text_files():
    for p in files():
        if p.suffix.lower() in BINARY_OK:
            continue
        try:
            yield p, p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            pytest.fail(f"{p.relative_to(ROOT)}：文字として読めないファイル。中身を確かめ、問題なければ BINARY_OK に拡張子を足す")


def hits(pattern, allow=None):
    out = []
    for p, text in text_files():
        for m in pattern.finditer(text):
            if allow and allow.search(m.group(0)):
                continue
            line = text.count("\n", 0, m.start()) + 1
            out.append(f"{p.relative_to(ROOT)}:{line}: {m.group(0)}")
    return out


def test_メールアドレスが無い():
    assert not hits(EMAIL, ALLOWED_EMAIL), "\n".join(hits(EMAIL, ALLOWED_EMAIL))


def test_自分のパソコンのパスが無い():
    found = hits(LOCAL_PATH)
    assert not found, "~/ の形に書き直す\n" + "\n".join(found)


def test_キーや秘密鍵が無い():
    found = hits(CREDENTIAL)
    assert not found, "\n".join(found)


def png_text_chunks(data):
    pos, found = 8, []
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        if kind in (b"tEXt", b"iTXt", b"zTXt", b"eXIf"):
            found.append(kind.decode())
        pos += 12 + length
    return found


def test_画像に埋め込み情報が無い():
    found = []
    for p in files():
        data = p.read_bytes()
        if p.suffix.lower() == ".png" and data[:8] == b"\x89PNG\r\n\x1a\n":
            chunks = png_text_chunks(data)
            if chunks:
                found.append(f"{p.relative_to(ROOT)}: {','.join(chunks)}")
        elif p.suffix.lower() in (".jpg", ".jpeg") and b"Exif\x00\x00" in data[:65536]:
            found.append(f"{p.relative_to(ROOT)}: Exif")
    assert not found, "撮影情報や作成ソフトの情報を消してから入れる\n" + "\n".join(found)


def private_terms():
    path = pathlib.Path(os.environ.get("KOKAI_PRIVATE_TERMS", "~/.config/kokai/伏せる言葉.txt")).expanduser()
    if not path.is_file():
        return None
    return [t.strip() for t in path.read_text(encoding="utf-8").splitlines() if t.strip() and not t.startswith("#")]


def test_伏せる言葉が無い():
    terms = private_terms()
    if terms is None:
        pytest.skip("伏せる言葉のファイルが無い環境")
    found = []
    for p in files():
        name = str(p.relative_to(ROOT))
        body = "" if p.suffix.lower() in BINARY_OK else p.read_text(encoding="utf-8", errors="ignore")
        for t in terms:
            if t.lower() in name.lower() or t.lower() in body.lower():
                found.append(f"{name}: 「{t}」")
    assert not found, "\n".join(found)
