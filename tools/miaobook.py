#!/usr/bin/env python3
"""喵喵听书·一条命令上架一本书：读电子书 → 切句 → 本机 Qwen3-TTS 录音 → 自动上传到书库。

用法（在装了 Qwen3-TTS 的环境里，conda activate qwen3-tts）：
    python miaobook.py 红楼梦.epub                 # 一本书
    python miaobook.py 书籍文件夹                    # 文件夹里所有书，一本接一本
    python miaobook.py 红楼梦.epub --author 曹雪芹 --speaker Vivian

支持 txt / md / epub / docx。第一次运行会问你一次开发者口令（输在你自己电脑上），之后记在 ~/.miaobook。
随时可以 Ctrl+C 中断，再运行同一条命令会接着录、接着传；已经上传过的句子会自动跳过。
录一部分就会先上架：读者能先读，没录到的句子暂时用系统声音，录完后自动变成自然人声。
录好的语音存在 ~/miaobook_cache/书名/ 里，上传失败或换电脑重传都不用重录。

需要：pip install soundfile numpy（和 batch_read.py 一样，不需要 ffmpeg）。
默认读取 C:\\ai\\models\\Qwen3-TTS-12Hz-1.7B-CustomVoice，默认声音 Serena（可用 --speaker 改）。
"""
import argparse, getpass, hashlib, html.parser, io, json, os, re, sys, time, urllib.request, urllib.error, zipfile
import xml.etree.ElementTree as ET

API = os.environ.get("MIAO_API", "https://api.miaomiaosw.com")
CFG = os.path.expanduser("~/.miaobook")

# ---------------- 读电子书 ----------------
def decode(b):
    for enc in ("utf-8-sig", "gb18030"):
        try: return b.decode(enc)
        except UnicodeDecodeError: pass
    return b.decode("utf-8", "ignore")

class _Html(html.parser.HTMLParser):
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "blockquote"}
    def __init__(s): super().__init__(); s.o = []; s.skip = 0
    def handle_starttag(s, t, a):
        if t in ("script", "style"): s.skip += 1
        if t in s.BLOCK: s.o.append("\n")
    def handle_endtag(s, t):
        if t in ("script", "style"): s.skip = max(0, s.skip - 1)
        if t in s.BLOCK: s.o.append("\n")
    def handle_data(s, d):
        if not s.skip: s.o.append(d)

def html_text(b):
    p = _Html(); p.feed(decode(b)); return "".join(p.o)

def read_epub(path):
    z = zipfile.ZipFile(path); ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container", "o": "http://www.idpf.org/2007/opf"}
    opf = ET.fromstring(z.read("META-INF/container.xml")).find(".//c:rootfile", ns).get("full-path")
    root = ET.fromstring(z.read(opf)); base = os.path.dirname(opf)
    man = {i.get("id"): i.get("href") for i in root.find("o:manifest", ns)}
    def dc(n):
        e = root.find(".//{http://purl.org/dc/elements/1.1/}" + n); return (e.text or "") if e is not None else ""
    title, author = dc("title"), dc("creator")
    out = []
    for it in root.find("o:spine", ns):
        h = man.get(it.get("idref"))
        if not h: continue
        name = os.path.normpath(os.path.join(base, h)).replace("\\", "/")
        from urllib.parse import unquote
        try: out.append(html_text(z.read(unquote(name))))
        except KeyError: pass
    return "\n\n".join(out), title.strip(), author.strip()

def read_docx(path):
    z = zipfile.ZipFile(path); root = ET.fromstring(z.read("word/document.xml")); W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    return "\n".join("".join(t.text or "" for t in p.iter(W + "t")) for p in root.iter(W + "p"))

def read_book(path):
    n = path.lower(); title = os.path.splitext(os.path.basename(path))[0]; author = ""
    if n.endswith((".txt", ".md", ".markdown")):
        text = decode(open(path, "rb").read())
        if not n.endswith(".txt"): text = re.sub(r"[#>*_`]+", "", text)
    elif n.endswith(".epub"):
        text, t, a = read_epub(path); title = t or title; author = a
    elif n.endswith(".docx"): text = read_docx(path)
    else: raise SystemExit("不支持的格式：%s（支持 txt / md / epub / docx；mobi 请先用 Calibre 转成 epub）" % path)
    return text, title, author

# ---------------- 切句（和喵喵听书里的规则一致；书库的书以服务器收到的句子为准，所以只要这里自洽就行）----------------
SPLIT = re.compile(r'[^。！？!?；;…]+(?:[。！？!?；;…]+["”’）)」』]*)?')
def split(text):
    text = text.replace("\r", "").replace("　", " ")
    paras = [re.sub(r"\s+", " ", x).strip() for x in re.split(r"\n+", text)]
    paras = [x for x in paras if x and re.search(r"[㐀-鿿A-Za-z0-9]", x)]
    sents, pst = [], []
    for para in paras:
        if len(sents) > 200000: break
        pst.append(len(sents)); out = []
        for x in (SPLIT.findall(para) or [para]):
            x = x.strip()
            if not x: continue
            if out and len(x) < 6 and len(out[-1]) < 100: out[-1] += x; continue
            while len(x) > 120:
                m = re.search(r"[，、,：:][^，、,：:]*$", x[:120]); k = m.start() if m else -1
                if k < 30: k = 119
                out.append(x[:k + 1]); x = x[k + 1:].strip()
            if x: out.append(x)
        sents.extend(out)
    return sents, pst

def zl_hash(t): return hashlib.sha256(("zl1\n" + t.strip()).encode("utf-8")).hexdigest()

# ---------------- 上传 ----------------
def token():
    t = os.environ.get("MIAO_TOKEN") or (open(CFG).read().strip() if os.path.exists(CFG) else "")
    if not t:
        t = getpass.getpass("第一次使用，请输入开发者口令（输入时不显示，只保存在这台电脑 ~/.miaobook）：").strip()
        with open(CFG, "w") as f: f.write(t)
        try: os.chmod(CFG, 0o600)
        except OSError: pass
    return t

def call(method, path, body=None, ctype=None, tok=""):
    req = urllib.request.Request(API + path, data=body, method=method, headers={"Authorization": "Bearer " + tok, "Origin": os.environ.get("MIAO_ORIGIN", "https://app.miaomiaosw.com")})
    if ctype: req.add_header("Content-Type", ctype)
    for a in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r: return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 401:
                try: os.remove(CFG)
                except OSError: pass
                raise SystemExit("口令不对，已清除，请重新运行再输入一次。")
            if e.code < 500 and e.code != 429: raise SystemExit("服务器拒绝：HTTP %d %s" % (e.code, e.read()[:200]))
        except Exception as e: err = e
        time.sleep(2 + a * 3)
    raise SystemExit("连不上服务器，请检查网络后重新运行（已录好的不会丢）。")

def put_clips(bid, items, tok):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for h, p in items: z.write(p, "clips/%s.mp3" % h)
    call("PUT", "/admin/zl/%s/clips" % bid, buf.getvalue(), "application/zip", tok)

def put_book(bid, title, author, voice, sents, pst, tok):
    return call("PUT", "/admin/zl/%s/book" % bid, json.dumps({"title": title, "author": author, "voice": voice, "s": sents, "p": pst}).encode("utf-8"), "application/json", tok)

# ---------------- 录音 ----------------
def make_tts(a):
    """返回 tts(列表[(句子, mp3路径)])：一批一批录（和 batch_read.py 一样，快很多）"""
    if a.fake:
        def fake(items):
            for _, path in items: open(path, "wb").write(b"ID3" + bytes(600))
        return fake
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import qwen_batch as q
    model = q.load_model(a.model)
    def real(items):
        res = q.synth_batch(model, [t for t, _ in items], a.speaker, a.language, a.instruct or None, a.temp)
        for (_, path), (sr, wav) in zip(items, res): q.to_mp3(sr, wav, path, a.bitrate)
    return real

def do_book(path, a, tts_holder):
    text, title, author = read_book(path); title = a.title or title; author = a.author or author
    sents, pst = split(text)
    if len(sents) < 3: print("跳过（没读到文字）：", path); return
    bid = a.id or "b" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:10]
    cache = os.path.join(os.path.expanduser("~/miaobook_cache"), bid); os.makedirs(cache, exist_ok=True)
    tok = a.tok
    print("\n《%s》 共 %d 句，书库编号 %s" % (title, len(sents), bid), flush=True)
    have = set() if a.redo else set(call("GET", "/admin/zl/%s/have" % bid, tok=tok).get("have", []))
    if a.redo:
        import shutil; shutil.rmtree(cache, ignore_errors=True); os.makedirs(cache, exist_ok=True)
    hs = [zl_hash(s) for s in sents]; seen = set(); todo = []
    for s, h in zip(sents, hs):
        if h in seen: continue
        seen.add(h)
        if h not in have: todo.append((s, h))
    print("服务器已有 %d 句语音，还要 %d 句" % (len(have & seen), len(todo)), flush=True)
    put_book(bid, title, author, a.speaker, sents, pst, tok)         # 先上架，读者马上能读（语音随后补上）
    if not todo: print("✅ 已经是完整的了"); return
    if "f" not in tts_holder: tts_holder["f"] = make_tts(a)
    tts = tts_holder["f"]; t0 = time.time(); pend = []; done = 0
    def flush():
        nonlocal pend
        if pend: put_clips(bid, pend, tok); pend = []
    for i in range(0, len(todo), a.gen):
        grp = todo[i:i + a.gen]; need = []
        for s, h in grp:
            p = os.path.join(cache, h + ".mp3")
            if not (os.path.exists(p) and os.path.getsize(p) > 100): need.append((s, p))
        if need:
            try: tts(need)
            except KeyboardInterrupt: flush(); print("已停止；再运行同一条命令会接着来"); sys.exit(0)
            except Exception as e:
                print("这一批失败（%s），改成一句一句录" % e, flush=True)
                for it in need:
                    try: tts([it])
                    except KeyboardInterrupt: flush(); print("已停止；再运行同一条命令会接着来"); sys.exit(0)
                    except Exception as e2: print("  失败：%s" % e2)
        for s, h in grp:
            p = os.path.join(cache, h + ".mp3")
            if os.path.exists(p) and os.path.getsize(p) > 100: pend.append((h, p)); done += 1
        if len(pend) >= a.batch: flush()
        n = i + len(grp); el = time.time() - t0
        print("%d/%d  已用 %.1f 分钟，预计还要 %.1f 分钟" % (n, len(todo), el / 60, el / n * (len(todo) - n) / 60), flush=True)
    flush(); r = put_book(bid, title, author, a.speaker, sents, pst, tok)
    it = r.get("item", {}); print("✅ 《%s》上架完成：%d 句，其中自然人声 %d 句" % (title, it.get("n", len(sents)), it.get("clips", done)))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("path", help="电子书文件，或装着多本书的文件夹")
    ap.add_argument("--title"); ap.add_argument("--author"); ap.add_argument("--id", help="书库编号（补语音/覆盖旧书时用）")
    ap.add_argument("--model"); ap.add_argument("--speaker", default="Serena")
    ap.add_argument("--language", default="Chinese"); ap.add_argument("--bitrate", default="48k")
    ap.add_argument("--batch", type=int, default=200, help="每录多少句就上传一次"); ap.add_argument("--gen", type=int, default=16, help="每批同时录几句，显存够可以调大"); ap.add_argument("--fake", action="store_true", help="测试用：不真录音")
    ap.add_argument("--instruct", default="请用标准普通话朗读，发音清晰自然，不要带任何方言或地方口音。", help="朗读要求；传空字符串 \"\" 表示不加")
    ap.add_argument("--temp", type=float, help="随机程度，调低更稳（比如 0.6），默认用模型自带的")
    ap.add_argument("--redo", action="store_true", help="重录：忽略已录的和服务器上已有的，全部重新录并覆盖")
    a = ap.parse_args(); a.tok = token()
    if not a.model and not a.fake:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import qwen_batch; a.model = qwen_batch.default_model()
    books = [os.path.join(a.path, f) for f in sorted(os.listdir(a.path)) if f.lower().endswith((".txt", ".md", ".epub", ".docx"))] if os.path.isdir(a.path) else [a.path]
    if not books: raise SystemExit("这个文件夹里没有 txt / md / epub / docx 电子书")
    holder = {}
    for b in books: do_book(b, a, holder)

if __name__ == "__main__": main()
