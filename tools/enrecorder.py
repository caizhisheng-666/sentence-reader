#!/usr/bin/env python3
"""一句一读·英文录音机：把英文书丢进文件夹，它自动上架到“学习材料”（免费），再用本机的 Kokoro 录句子和单词、边录边传。

用法：双击「英文录音机.bat」（或在 tts-kokoro 环境里运行 python enrecorder.py）。
它做的事：
  1. 盯着「放这里自动录的英文书」文件夹（txt / md / epub / docx），发现新书：
  2. 先把文字上架到学习材料，读者马上能读（还没录到的句子暂时用手机自带的声音）；
  3. 录这本书里的单词：先问服务器公共单词库缺哪些，只录缺的（同一个词所有书只录一次），再挂到这本书下面；
  4. 按顺序录句子，每录一批就上传一批；全部录完整理“下载全部语音”的总包；
  5. 录完把书移到「已完成」，出错的移到「出错」并留一份说明。只移动，不删除。
切句、切词用的是和手机同一个 split.js（同一份文件），所以录的句子和手机上看到的一一对上。
它和中文的喵喵录音机互不影响，可以同时开着：显卡被占满时它自动改用 CPU（Kokoro 很小，CPU 也录得动）。
电脑关机或关掉窗口就停了；下次开着它，没录完的会接着录（已经上传的自动跳过，录好没传的在 ~/enrecorder_cache 里）。
口令和喵喵录音机共用（~/.miaobook）。

需要（tts-kokoro 环境）：pip install "kokoro>=0.9.4" soundfile mini-racer
"""
import argparse, hashlib, io, json, os, re, shutil, sys, time, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import miaobook as mb

VOICES = {"af_heart": "美音女声 Heart", "am_michael": "美音男声 Michael", "bf_emma": "英音女声 Emma", "bm_george": "英音男声 George"}
SR = 24000
BOOK_EXT = (".txt", ".md", ".markdown", ".epub", ".docx")


def log(m): print(time.strftime("%H:%M:%S "), m, flush=True)


BASE_VOICE = "af_heart"                                    # 书的主声音：语音放在书自己的目录；别的声音放在“编号--am-michael”


def vp_hash(t, vk=""):                                     # 和手机上的 vpKey / vpKeyAs 一样：第二个声音的文件名里多带声音名
    return hashlib.sha256(("vp1\n" + (vk + "\n" if vk else "") + t.strip()).encode("utf-8")).hexdigest()


def voice_dir(bid, voice): return bid if voice == BASE_VOICE else bid + "--" + voice.replace("_", "-")


# ---------------- 切句、切词：直接运行手机上的 split.js ----------------
class Split:
    def __init__(self):
        from py_mini_racer import MiniRacer
        self.js = MiniRacer()
        self.js.eval("var window = this;")
        for f in ("split.js", "lexlevel.js"):                 # 和本文件放在一起；仓库里在上一层目录
            p = next((x for x in (os.path.join(HERE, f), os.path.join(HERE, "..", f)) if os.path.exists(x)), None)
            if not p: raise SystemExit("找不到 %s，请把它和 enrecorder.py 放在同一个文件夹" % f)
            self.js.eval(open(p, encoding="utf-8").read())
        self.js.eval("""function srPrepare(raw, fileName, epubTitle) {
            const cl = devClean(raw), meta = devMeta(cl.text, fileName, cl.htmlTitle || epubTitle || '');
            const d = devParse(cl.text), sents = storySentences(cl.text);
            return JSON.stringify({ text: cl.text, en: meta.en, zh: meta.zh, preview: d.preview, sents, words: storyWords(sents), level: levelOf(sents, window.LEXLV).label || '' });
        }
        function srStore(text) { const sents = storySentences(fixStoryHeadings(text)); return JSON.stringify({ sents, words: storyWords(sents) }); }""")

    def prepare(self, raw, file_name, epub_title=""):
        return json.loads(self.js.call("srPrepare", raw, file_name, epub_title or "", timeout=600000))   # 传 JSON 文字回来，不依赖 mini-racer 的对象转换


def slug(t): return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", str(t or "").lower()))[:40]   # 和手机上的 devSlug 一样


# ---------------- 录音：Kokoro ----------------
class Kokoro:
    def __init__(self, device="cpu"):                         # 默认 CPU：已经够快，而且中文录音机随时会把显卡占满，抢显卡反而慢到一分钟一个词
        from kokoro import KPipeline
        log("Kokoro 用 %s 录音" % ("显卡" if device == "cuda" else "CPU"))
        self.pipes, self.device, self.KPipeline = {}, device, KPipeline

    def __call__(self, text, voice):
        import numpy as np
        lang = voice[0]                                        # 声音名第一个字母就是口音：a 美音、b 英音
        if lang not in self.pipes: self.pipes[lang] = self.KPipeline(lang_code=lang, device=self.device)
        parts = [np.asarray(r[2], dtype="float32").reshape(-1) for r in self.pipes[lang](text, voice=voice, speed=1)]
        if not parts: raise RuntimeError("没有念出声音")
        return np.concatenate(parts)


def polish(w, sr=None):
    """切掉头尾的静音（各留 60 毫秒），音量统一：每句、每个词听起来一样响"""
    import numpy as np
    w = np.asarray(w, dtype="float32")
    if not len(w): return w
    a = np.abs(w); thr = max(a.max() * 0.02, 1e-4); idx = np.where(a > thr)[0]
    if len(idx): pad = int(0.06 * (sr or SR)); w = w[max(0, idx[0] - pad): idx[-1] + pad]
    rms = float(np.sqrt((w ** 2).mean()) or 1e-6); w = w * min(10 ** (-20 / 20) / rms, 0.95 / (np.abs(w).max() or 1))   # 目标 -20 dB，不削顶
    return w


def to_mp3(w, path, sr=None):
    import soundfile as sf
    tmp = path + ".tmp.mp3"
    with sf.SoundFile(tmp, "w", samplerate=sr or SR, channels=1, format="MP3") as f: f.write(w)
    os.replace(tmp, path)


# ---------------- 上传 ----------------
def zip_clips(items):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for h, p in items: z.write(p, "clips/%s.mp3" % h)
    return buf.getvalue()


def batches(items, limit=12 * 1048576):
    cur, sz = [], 0
    for h, p in items:
        n = os.path.getsize(p)
        if cur and sz + n > limit: yield cur; cur, sz = [], 0
        cur.append((h, p)); sz += n
    if cur: yield cur


def catalog():
    import urllib.request
    req = urllib.request.Request(mb.API + "/catalog?t=%d" % time.time(), headers={"Origin": os.environ.get("MIAO_ORIGIN", "https://app.miaomiaosw.com")})
    with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read().decode("utf-8")).get("items", [])


# ---------------- 一本书 ----------------
STATE = os.path.expanduser("~/.enrecorder.json")         # 本机记着：哪个文件（按指纹）上架成了哪个编号


def state_load():
    try: return json.load(open(STATE, encoding="utf-8"))
    except Exception: return {}


def state_save(s):
    with open(STATE + ".tmp", "w", encoding="utf-8") as f: json.dump(s, f, ensure_ascii=False)
    os.replace(STATE + ".tmp", STATE)


class Recorder:
    def __init__(self, a):
        self.a = a; self.tok = mb.token(); self.split = Split(); self.tts = None

    def say(self, text, voice):
        if self.a.fake: import numpy as np; return np.sin(np.arange(int(SR * (0.3 + 0.05 * len(text)))) / 8).astype("float32") * 0.3
        if self.tts is None: log("正在加载 Kokoro（第一次要下载模型，几百 MB）…"); self.tts = Kokoro(self.a.device)
        return self.tts(text, voice)

    def record(self, todo, cache, label, on_batch, voice, every=40):
        """todo = [(哈希, 文字)]；录到 cache/<哈希>.mp3，每 every 条交给 on_batch 上传一次"""
        os.makedirs(cache, exist_ok=True); ready, t0, done = [], time.time(), 0
        for h, t in todo:
            p = os.path.join(cache, h + ".mp3")
            if not (os.path.exists(p) and os.path.getsize(p) > 100):
                try: to_mp3(polish(self.say(t, voice)), p)
                except KeyboardInterrupt: raise
                except Exception as e: log("  跳过（%s）：%s" % (e, t[:60])); continue
            ready.append((h, p)); done += 1
            if len(ready) >= every: on_batch(ready); ready = []; el = time.time() - t0; log("%s %d/%d，预计还要 %.0f 分钟" % (label, done, len(todo), el / done * (len(todo) - done) / 60))
        if ready: on_batch(ready)
        return done

    def do_book(self, path):
        a, tok = self.a, self.tok
        raw, title0, _author = mb.read_book(path)
        b = self.split.prepare(raw, os.path.basename(path), title0 if path.lower().endswith(".epub") else "")
        sents, words = b["sents"], b["words"]
        if len(sents) < 3: raise RuntimeError("没有识别到英文句子（只读出 %d 句）" % len(sents))
        title = (title0 if path.lower().endswith(".epub") and re.search(r"[A-Za-z]", title0 or "") else b["en"]) or os.path.splitext(os.path.basename(path))[0]
        fp = hashlib.sha256(b["text"].encode("utf-8")).hexdigest()[:24]
        st = state_load(); bid = st.get(fp)
        items = {x["id"]: x for x in catalog()}
        if not bid or bid not in items:                          # 新书：起编号（和别的书重名就加 -2、-3）并上架
            base = slug(title) or ("en-" + fp[:8]); bid = base; k = 2
            while bid in items or bid in st.values(): bid = "%s-%d" % (base, k); k += 1
            man = {"format": "sr-story", "v": 1, "id": bid, "title": title, "level": b["level"], "voice": "Kokoro " + a.voices[0], "count": len(sents)}
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("manifest.json", json.dumps(man, ensure_ascii=False)); z.writestr("book.txt", b["text"])
            mb.call("PUT", "/admin/file/%s.srbook" % bid, buf.getvalue(), "application/zip", tok)
            entry = {"id": bid, "kind": "story", "title": title, "titleZh": b["zh"], "level": b["level"], "count": len(sents), "voice": True,
                     "desc": (b["zh"] + "。") if b["zh"] else "", "preview": b["preview"], "file": "api:files/%s.srbook" % bid}
            mb.call("POST", "/admin/item", json.dumps(entry, ensure_ascii=False).encode("utf-8"), "application/json", tok)
            st[fp] = bid; state_save(st)
            log("《%s》已上架到学习材料（编号 %s，%d 句，%d 个不同的词，%s）" % (title, bid, len(sents), len(words), b["level"] or "等级未知"))
        else: log("《%s》已经上架过（编号 %s），接着录缺的语音" % (title, bid))
        for v in a.voices: self.voice_book(bid, title, sents, words, v)

    def voice_book(self, bid, title, sents, words, voice):
        """给一本已上架的书录一个声音：单词（公共单词库里没有的）+ 句子（服务器上没有的）"""
        tok, vk = self.tok, "" if voice == BASE_VOICE else voice
        did = voice_dir(bid, voice); cache = os.path.join(os.path.expanduser("~/enrecorder_cache"), voice)
        log("—— 声音：%s ——" % VOICES.get(voice, voice))
        # —— 单词：公共单词库里没有的才录 ——
        wh = [(vp_hash(w, vk), w) for w in words]
        miss = set(mb.call("POST", "/admin/words/missing", json.dumps({"voice": voice, "hashes": [h for h, _ in wh]}).encode(), "application/json", tok).get("missing", []))
        todo = [(h, w) for h, w in wh if h in miss]
        log("单词：共 %d 个，公共单词库里已有 %d 个，要录 %d 个" % (len(wh), len(wh) - len(todo), len(todo)))
        def up_words(items):
            for g in batches(items): mb.call("PUT", "/admin/words?voice=%s" % voice, zip_clips(g), "application/zip", tok)
        self.record(todo, os.path.join(cache, "words"), "单词", up_words, voice, every=200)
        r = mb.call("POST", "/admin/words/link/%s" % did, json.dumps({"voice": voice, "hashes": [h for h, _ in wh]}).encode(), "application/json", tok)
        if r.get("missing"): log("  有 %d 个单词没录成，点它时会用手机自带的声音" % len(r["missing"]))
        # —— 句子：按顺序录，服务器上已有的跳过 ——
        have = set(mb.call("GET", "/admin/clips/%s" % did, tok=tok).get("have", []))
        seen, todo = set(), []
        for t in sents:
            h = vp_hash(t, vk)
            if h not in have and h not in seen: seen.add(h); todo.append((h, t))
        uniq = len(set(vp_hash(t, vk) for t in sents))
        log("句子：共 %d 句（不重复的 %d 句），服务器上已有 %d 句，要录 %d 句" % (len(sents), uniq, uniq - len(todo), len(todo)))
        def up_sents(items):
            for g in batches(items): mb.call("PUT", "/admin/file/%s.voice.zip?last=0" % did, zip_clips(g), "application/zip", tok)
        self.record(todo, os.path.join(cache, did), "句子", up_sents, voice)
        r = mb.call("POST", "/admin/repack/%s" % did, b"", None, tok)
        if vk: mb.call("POST", "/admin/voices/%s" % bid, json.dumps({"voice": voice}).encode(), "application/json", tok)   # 学习材料里记上：这本书有这个声音
        log("《%s》%s录完了：%s" % (title, VOICES.get(voice, voice), "“下载全部语音”的包已整理好（%d 份）" % r.get("parts", 0) if not r.get("tooBig") else "语音太多，没打“下载全部语音”的包，读者边读边取"))

    def do_store_book(self, bid):
        """给学习材料里已有的书（比如以前用微软声音录的）补录声音：从服务器取书的正文，按手机上的办法切句"""
        it = next((x for x in catalog() if x["id"] == bid), None)
        if not it: raise SystemExit("学习材料里没有编号 %s 的书" % bid)
        if it.get("price"): raise SystemExit("《%s》是收费书，第二个声音暂时只支持免费书" % it["title"])
        import urllib.request
        req = urllib.request.Request(mb.API + "/files/%s.srbook" % bid, headers={"Origin": os.environ.get("MIAO_ORIGIN", "https://app.miaomiaosw.com")})
        with urllib.request.urlopen(req, timeout=120) as r, zipfile.ZipFile(io.BytesIO(r.read())) as z: text = z.read("book.txt").decode("utf-8")
        b = json.loads(self.split.js.call("srStore", text, timeout=600000))
        log("《%s》：%d 句，%d 个不同的词" % (it["title"], len(b["sents"]), len(b["words"])))
        for v in self.a.voices: self.voice_book(bid, it["title"], b["sents"], b["words"], v)

    def watch(self):
        a = self.a; d = a.folder; os.makedirs(d, exist_ok=True)
        log("英文录音机已开启，盯着文件夹：%s（声音：%s）" % (d, "、".join(VOICES.get(v, v) for v in a.voices)))
        tries = {}
        while True:
            books = sorted((f for f in os.listdir(d) if f.lower().endswith(BOOK_EXT) and os.path.isfile(os.path.join(d, f))), key=lambda f: os.path.getmtime(os.path.join(d, f)))
            for f in books:
                p = os.path.join(d, f)
                try:
                    self.do_book(p); move(p, os.path.join(d, "已完成"))
                except KeyboardInterrupt: raise
                except BaseException as e:                      # mb.read_book 不认识的格式会 SystemExit
                    tries[f] = tries.get(f, 0) + 1; log("《%s》出错（第 %d 次）：%s" % (f, tries[f], e))
                    if tries[f] >= 3 or isinstance(e, SystemExit):
                        q = move(p, os.path.join(d, "出错"))
                        with open(q + ".出错原因.txt", "w", encoding="utf-8") as fh: fh.write(str(e))
                    else: time.sleep(10)
                break                                            # 每本书录完重新看一遍文件夹
            if a.once and not books: return
            if not books: time.sleep(10)


def move(p, folder):
    os.makedirs(folder, exist_ok=True); q = os.path.join(folder, os.path.basename(p)); k = 2
    while os.path.exists(q): r, e = os.path.splitext(os.path.basename(p)); q = os.path.join(folder, "%s(%d)%s" % (r, k, e)); k += 1
    shutil.move(p, q); return q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", default=os.path.join(HERE, "放这里自动录的英文书"))
    ap.add_argument("--voices", default="af_heart,am_michael", help="录哪几个声音，逗号隔开；第一个 af_heart 是书的主声音（默认女声 + 男声）")
    ap.add_argument("--book", default="", help="不看文件夹，给学习材料里已有的书补录声音：编号，逗号隔开（比如 --book little-prince --voices am_michael）")
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda"], help="默认 CPU；cuda 只在中文录音机没开时用")
    ap.add_argument("--once", action="store_true", help="文件夹里的书录完就退出（测试用）")
    ap.add_argument("--fake", action="store_true", help="不真录音，用假声音（测试用）")
    a = ap.parse_args()
    a.voices = [v.strip() for v in a.voices.split(",") if v.strip()]
    bad = [v for v in a.voices if v not in VOICES]
    if bad or not a.voices: raise SystemExit("不认识的声音：%s（可以用：%s）" % ("、".join(bad), "、".join(sorted(VOICES))))
    if not a.book and a.voices[0] != BASE_VOICE: raise SystemExit("新书的第一个声音必须是 %s（书的主声音）" % BASE_VOICE)
    r = Recorder(a)
    try:
        if a.book:
            for bid in [x.strip() for x in a.book.split(",") if x.strip()]: r.do_store_book(bid)
        else: r.watch()
    except KeyboardInterrupt: log("已停止。下次打开会接着录。")
    finally: r.split.js.close()                              # 不关掉的话，程序退出时会卡住


if __name__ == "__main__": main()
