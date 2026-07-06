# -*- coding: utf-8 -*-
"""青空文庫のルビ付きテキストを Darask Novel Engine のシナリオ形式に変換する"""
import io
import re
import sys
import zipfile
import urllib.request

OUT_DIR = r"C:\Users\micro\Documents\darask-novel-engine"
UA = {"User-Agent": "Mozilla/5.0 (aozora-to-novel-converter; personal use)"}

BOOKS = [
    {
        "card": "https://www.aozora.gr.jp/cards/000879/card127.html",
        "base": "https://www.aozora.gr.jp/cards/000879/files/",
        "out": "rashomon.txt",
        "title": "羅生門",
        "author": "芥川龍之介",
        "bg": "羅生門.jpg",
    },
    {
        "card": "https://www.aozora.gr.jp/cards/000148/card752.html",
        "base": "https://www.aozora.gr.jp/cards/000148/files/",
        "out": "botchan.txt",
        "title": "坊っちゃん",
        "author": "夏目漱石",
        "bg": "坊っちゃん.jpg",
    },
    {
        "card": "https://www.aozora.gr.jp/cards/000121/card628.html",
        "base": "https://www.aozora.gr.jp/cards/000121/files/",
        "out": "gongitsune.txt",
        "title": "ごん狐",
        "author": "新美南吉",
        "bg": "ごんぎつね.jpg",
    },
]

KANJI = r"一-鿿々〆ヵヶ〇"
CHAPTER_RE = re.compile(r"^[一二三四五六七八九十]{1,3}$")

def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

def get_zip_text(book):
    html = fetch(book["card"]).decode("shift_jis", errors="replace")
    m = re.search(r'href="\./files/(\d+_ruby_\d+\.zip)"', html)
    if not m:
        m = re.search(r'href="\./files/(\d+_txt_\d+\.zip)"', html)
    if not m:
        raise RuntimeError("zip link not found: " + book["card"])
    zurl = book["base"] + m.group(1)
    print("  zip:", zurl)
    data = fetch(zurl)
    zf = zipfile.ZipFile(io.BytesIO(data))
    name = [n for n in zf.namelist() if n.lower().endswith(".txt")][0]
    return zf.read(name).decode("shift_jis", errors="replace")

def strip_header_footer(text):
    lines = text.splitlines()
    # ヘッダ: 「-----」区切りが2本あればその後ろから
    seps = [i for i, ln in enumerate(lines) if ln.startswith("-----")]
    start = seps[1] + 1 if len(seps) >= 2 else 2
    # フッタ: 「底本:」以降を除去
    end = len(lines)
    for i, ln in enumerate(lines):
        if ln.strip().startswith("底本"):
            end = i
            break
    return lines[start:end]

def clean_line(ln):
    ln = re.sub(r"※?［＃[^］]*］", "", ln)      # 注記・外字指定を除去
    ln = ln.replace("※", "")
    # ルビ: ｜が無い「漢字《よみ》」に ｜ を付ける(エンジンの記法に合わせる)
    # 漢字連の途中から二重に付かないよう、直前が ｜ でも漢字でもない位置だけにマッチさせる
    ln = re.sub(r"(?<![｜%s])([%s]+)《" % (KANJI, KANJI), r"｜\1《", ln)
    ln = ln.replace("|", "｜")                   # 半角|は全角に統一
    ln = ln.replace("{", "｛").replace("}", "｝") # 変数展開と衝突させない
    ln = ln.replace("**", "")                    # 太字記法と衝突させない
    return ln.strip("　 \t")

def split_sentences(par):
    """「」内では区切らずに文単位に分割する"""
    out, buf, depth = [], "", 0
    for ch in par:
        if buf == "" and out and ch in "」』)":  # 文末直後の閉じ括弧は前の文に付ける
            out[-1] += ch
            continue
        buf += ch
        if ch in "「『": depth += 1
        elif ch in "」』": depth = max(0, depth - 1)
        if depth == 0 and ch in "。!?！?":
            out.append(buf)
            buf = ""
    if buf.strip():
        out.append(buf)
    return out

def visible_len(s):
    """ルビ記法を除いた表示文字数"""
    return len(re.sub(r"｜([^《]+)《[^》]+》", r"\1", s))

def chunk(sentences, limit=85):
    out, buf = [], ""
    for s in sentences:
        if buf and visible_len(buf) + visible_len(s) > limit:
            out.append(buf)
            buf = s
        else:
            buf += s
    if buf:
        out.append(buf)
    return out

def convert(book):
    print("converting", book["title"])
    raw = get_zip_text(book)
    lines = strip_header_footer(raw)

    body = []
    body.append("# %s %s(青空文庫より・パブリックドメイン)" % (book["title"], book["author"]))
    body.append("@title 読込用ダミー") if False else None
    body.append("@scene %s" % book["title"])
    body.append("@bg %s" % book["bg"])
    body.append("@bgm stop")
    body.append("")
    body.append("%s" % book["title"])
    body.append("%s" % book["author"])
    body.append("")

    for ln in lines:
        s = clean_line(ln)
        if not s:
            continue
        if CHAPTER_RE.match(s):  # 章見出し
            body.append("")
            body.append("@scene %s・%s" % (book["title"], s))
            body.append("")
            continue
        for piece in chunk(split_sentences(s)):
            piece = piece.strip()
            if piece:
                body.append(piece)
    body.append("")
    body.append("(おわり ―― 青空文庫より)")
    body.append("")
    body.append("@end")

    out_path = OUT_DIR + "\\" + book["out"]
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(x for x in body if x is not None))
    n_scenes = sum(1 for x in body if isinstance(x, str) and x.startswith("@scene"))
    n_lines = sum(1 for x in body if isinstance(x, str) and x and not x.startswith(("@", "#")))
    print("  -> %s  (scenes=%d, message lines=%d)" % (book["out"], n_scenes, n_lines))

for b in BOOKS:
    convert(b)
print("done")
