#!/usr/bin/env python3
"""喵喵录音机：开着它，手机上点“开始录这个声音”，它就自动录、自动上传。

用法：双击「喵喵录音机.bat」（或在装了 Qwen3-TTS 的环境里运行 python miaorecorder.py）。
它做的事：
  1. 每隔几秒问服务器：有没有人点了“开始录某本书的某个声音”？
  2. 有 → 从你在手机上听到的那一句开始往后录（录完最后一句再回到开头补前面的），
         每录一小批就上传一次，手机上马上就能听到；
  3. 全部录完 → 告诉服务器“这个声音录好了”，接着看有没有下一个；没有就等着。
另外它还会盯着一个文件夹（默认是这个文件夹里的「放这里自动录的书」）：把电子书（txt/md/epub/docx）丢进去，
它会先看书库里有没有这本书（按书名+内容的指纹判断），没有就先上架，然后马上用默认声音（晓雅，CosyVoice 女声）边录边传；
录完把文件移到该文件夹里的「已完成」。手机上点的“开始录这个声音”优先，处理完才轮到文件夹里的书。
电脑关机或关掉这个窗口时它就停了；下次开着它，没录完的会接着录（已经上传的句子自动跳过）。
声音：Qwen 的五个（十三、苏瑶、福伯、晓东、程川）在本环境里录；“稳定声音”（晓雅、福伯·稳、阿七，见 zhvoices.py）
交给 tts-cosy / tts-chattts 环境里的 zhtts_worker.py 录。一次只开一个模型，换模型时先把上一个卸下来。
第一次运行会问一次开发者口令（输在你自己电脑上，记在 ~/.miaobook）。
"""
import argparse, re, os, sys, time, json, hashlib, shutil, subprocess, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import miaobook as mb
import zhvoices as zv

# 手机上显示的声音 → Qwen 模型里的名字
SPEAKERS = {"vivian": "Vivian", "serena": "Serena", "uncle_fu": "Uncle_Fu", "dylan": "Dylan", "eric": "Eric"}
CN = {"vivian": "十三", "serena": "苏瑶", "uncle_fu": "福伯", "dylan": "晓东", "eric": "程川"}
CN.update({k: v["name"] for k, v in zv.VOICES.items()})
FIRST_BATCHES = [6, 10]          # 刚开始先录小批，让你更快听到第一句


def log(m): print(time.strftime("%H:%M:%S "), m, flush=True)


def ping(tok, job="", msg=""):
    try: mb.call("POST", "/admin/worker/ping", json.dumps({"job": job, "msg": msg}).encode("utf-8"), "application/json", tok)
    except SystemExit: raise
    except Exception: pass


def get_queue(tok):
    return mb.call("GET", "/admin/queue", tok=tok).get("jobs", [])


def get_book(bid):
    req = urllib.request.Request(mb.API + "/zl/%s/book.json" % bid, headers={"Origin": os.environ.get("MIAO_ORIGIN", "https://app.miaomiaosw.com")})
    with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read().decode("utf-8"))


def split_key(vk):
    """声音编号 → (旁白声音, 对话声音)。"福伯+程川"这种组合的编号是 uncle_fu_x_eric；单一声音就没有对话声音"""
    if "_x_" in vk: n, d = vk.split("_x_", 1); return n, d
    return vk, None


def spk_name(k): return CN.get(k) if zv.is_stable(k) else (SPEAKERS.get(k) or k.capitalize())


def conda_python(env):
    """conda 环境 env 里的 python。录音机自己在 qwen3-tts 环境里跑，别的环境和它在同一个 conda 下面"""
    o = os.environ.get("MIAO_PY_" + env.upper().replace("-", "_"))
    if o: return o
    roots = []
    if os.environ.get("CONDA_EXE"): roots.append(os.path.dirname(os.path.dirname(os.environ["CONDA_EXE"])))
    p = os.path.abspath(sys.prefix)
    if os.path.basename(os.path.dirname(p)).lower() == "envs": roots.append(os.path.dirname(os.path.dirname(p)))
    roots.append(p)
    for r in roots:
        for py in (os.path.join(r, "envs", env, "python.exe"), os.path.join(r, "envs", env, "bin", "python")):
            if os.path.exists(py): return py
    raise RuntimeError("找不到 conda 环境 %s（试听时建的那个）" % env)


class Worker:
    """在别的 conda 环境里开一个 zhtts_worker.py（CosyVoice / ChatTTS），模型一直留在里面，一批一批交给它录"""
    def __init__(self, engine, a):
        self.engine = engine
        cmd = [conda_python(zv.ENGINES[engine]["env"]), "-u", os.path.join(os.path.dirname(os.path.abspath(__file__)), "zhtts_worker.py"), "--engine", engine, "--bitrate", a.bitrate]
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        if a.cpu: env["CUDA_VISIBLE_DEVICES"] = ""
        log("启动 %s（第一次加载要一两分钟）…" % engine)
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, encoding="utf-8", errors="replace", bufsize=1)
        self.read()                                             # 等它说“模型加载好了”

    def read(self):
        while True:
            line = self.p.stdout.readline()
            if not line: raise RuntimeError("%s 帮手意外退出了（看上面的报错）" % self.engine)
            if line.startswith("@@ZHTTS "):
                r = json.loads(line[8:])
                if r.get("err"): raise RuntimeError(r["err"])
                return r
            print(line, end="", flush=True)

    def tts(self, voice, items):
        self.p.stdin.write(json.dumps({"voice": voice, "texts": [t for t, _ in items], "paths": [p for _, p in items]}, ensure_ascii=False) + "\n"); self.p.stdin.flush()
        r = self.read()
        if r.get("errs") and len(r["errs"]) == len(items): raise RuntimeError(r["errs"][0])

    def close(self):
        try: self.p.stdin.close(); self.p.wait(15)
        except Exception:
            try: self.p.kill()
            except Exception: pass


def dialogue_flags(sents, pst):
    """哪些句子是“人物说的话”（引号里的字占一半以上）。引号跨句时接着算；每个自然段开头重置，防止少一个引号后面全错"""
    OPEN = {"“": "”", "「": "」", "『": "』"}; starts = set(pst or []); stack = []; out = []
    for i, t in enumerate(sents):
        if i in starts: stack = []
        inside = total = 0
        for ch in t:
            if ch.isspace(): continue
            total += 1
            if ch in OPEN: stack.append(OPEN[ch]); inside += 1
            elif stack and ch == stack[-1]: stack.pop(); inside += 1
            elif ch == '"':
                if stack and stack[-1] == '"': stack.pop()
                else: stack.append('"')
                inside += 1
            elif stack: inside += 1
        out.append(total > 0 and inside * 2 >= total)
    return out


class Recorder:
    def __init__(self, a):
        self.a = a; self.tok = mb.token(); self.model = None; self.q = None; self.worker = None; self.bad = {}; self.pre = set(); self.cur_file = ""

    def free_qwen(self):
        if self.model is None: return
        log("先把 Qwen 模型从显卡上卸下来，腾地方给新声音"); self.model = None
        try:
            import gc, torch; gc.collect(); torch.cuda.empty_cache()
        except Exception: pass

    def free_worker(self):
        if self.worker: log("关掉 %s 帮手" % self.worker.engine); self.worker.close(); self.worker = None

    def stable_tts(self, items, voice):
        """稳定声音（CosyVoice / ChatTTS）：交给对应环境里的帮手录。一次只开一个模型，显卡不打架"""
        eng = zv.VOICES[voice]["engine"]
        if self.worker and self.worker.engine != eng: self.free_worker()
        if not self.worker: self.free_qwen(); self.worker = Worker(eng, self.a)
        try: self.worker.tts(voice, items)
        finally:
            if self.worker.p.poll() is not None: self.worker = None      # 帮手退出了：下次重新开一个

    def tts_for(self):
        """返回 tts(列表[(句子, mp3路径)], 声音编号)"""
        a = self.a
        if a.fake:
            src = os.environ.get("MIAO_FAKE_MP3"); blob = open(src, "rb").read() if src else b"ID3" + bytes(600)     # 测试用：不真录音，写一个现成的小 mp3
            def fake(items, speaker=None):
                for _, path in items: open(path, "wb").write(blob); time.sleep(float(os.environ.get("MIAO_FAKE_DELAY", "0")))
            return fake
        import qwen_batch as q
        self.q = q
        def real(items, voice):
            if zv.is_stable(voice): return self.stable_tts(items, voice)
            self.free_worker()
            if self.model is None:
                ping(self.tok, "", "正在加载模型…"); log("正在加载 Qwen 模型（第一次要一两分钟）…")
                self.model = q.load_model(a.model or q.default_model())
            speaker = spk_name(voice)
            ins = None if speaker in ("Dylan", "Eric") else (a.instruct or None)      # 北京话、四川话本来就是方言，不要压它
            res = q.synth_batch(self.model, [t for t, _ in items], speaker, "Chinese", ins, a.temp)
            for (_, path), (sr, wav) in zip(items, res): q.to_mp3(sr, wav, path, a.bitrate)
        return real

    def run_job(self, job):
        a, tok = self.a, self.tok
        bid, vk = job["id"], job["voice"]; nk, dk = split_key(vk); speaker = spk_name(nk) + ("+" + spk_name(dk) if dk else "")
        label = "%s|%s" % (bid, vk); local = bool(job.get("local"))
        book = get_book(bid); sents = book["s"]; n = len(sents)
        have = set(mb.call("GET", "/admin/zl/%s/have?voice=%s" % (bid, vk), tok=tok).get("have", []))
        start = max(0, min(n - 1, int(job.get("from", 0))))
        order = list(range(start, n)) + list(range(0, start))          # 从听到的那句往后，再回到开头
        flags = dialogue_flags(sents, book.get("p")) if dk else [False] * n
        seen, todo = set(), []
        for i in order:
            t = sents[i]; h = mb.zl_hash(t)
            if not t.strip() or h in seen: continue
            seen.add(h)
            if h not in have: todo.append((t, h, dk if flags[i] else nk))
        log("《%s》声音 %s：共 %d 句，从第 %d 句开始，还要录 %d 句" % (job.get("title", bid), speaker, n, start + 1, len(todo)))
        if todo:
            tts = self.tts_for()
            cache = os.path.join(os.path.expanduser("~/miaobook_cache"), bid, vk); os.makedirs(cache, exist_ok=True)
            done = 0; bi = 0; t0 = time.time(); skipped = 0
            while todo:
                size = FIRST_BATCHES[bi] if bi < len(FIRST_BATCHES) else a.gen; bi += 1
                grp, todo = todo[:size], todo[size:]
                need = {}
                for t, h, sp in grp:
                    p = os.path.join(cache, h + ".mp3")
                    if not (os.path.exists(p) and os.path.getsize(p) > 100): need.setdefault(sp, []).append((t, p))
                for sp, lst in need.items():                    # 旁白、对话是不同的声音：分开录
                    try: tts(lst, sp)
                    except KeyboardInterrupt: raise
                    except Exception as e:
                        log("这一批失败（%s），改成一句一句录" % e)
                        for it in lst:
                            try: tts([it], sp)
                            except KeyboardInterrupt: raise
                            except Exception as e2: log("  这一句跳过：%s" % e2)
                items = []
                for t, h, sp in grp:
                    p = os.path.join(cache, h + ".mp3")
                    if os.path.exists(p) and os.path.getsize(p) > 100: items.append((h, p))
                    else: skipped += 1
                if items: mb.put_clips(bid, items, tok, vk)
                done += len(grp); el = time.time() - t0
                msg = "%d/%d" % (done, done + len(todo)); ping(tok, label, msg)
                log("%s  已用 %.1f 分钟" % (msg, el / 60))
                self.preupload()
                # 每批之后看一眼：有没有人换了新的要求（点了别的书/声音，或在这本书里跳到了别处）
                jobs = get_queue(tok)
                if local:
                    if jobs: log("手机上有新的要求，先去处理它（这本书下次接着录）"); return False
                    continue
                if not jobs or jobs[0]["id"] != bid or jobs[0]["voice"] != vk or int(jobs[0].get("from", 0)) != int(job.get("from", 0)):
                    log("有新的要求，先去处理它（这个声音录了一部分，下次接着录）"); return False
        if not local: mb.call("POST", "/admin/queue/done", json.dumps({"id": bid, "voice": vk}).encode("utf-8"), "application/json", tok)
        log("✅ 《%s》的声音 %s 录好了" % (job.get("title", bid), speaker)); return True


    # ---------- 盯文件夹：丢进来的新书自动上架、自动录 ----------
    BOOK_EXT = (".txt", ".md", ".epub", ".docx")

    def scan_watch(self):
        """处理文件夹里的一本书。返回 True 表示做了点事（让主循环马上再看一遍队列）"""
        a = self.a; d = a.watch
        if not d: return False
        os.makedirs(d, exist_ok=True); done_dir = os.path.join(d, "已完成")
        files = [f for f in sorted(os.listdir(d)) if f.lower().endswith(self.BOOK_EXT) and os.path.isfile(os.path.join(d, f)) and not f.startswith("~$")]
        for f in files:
            if self.bad.get(f, 0) >= 3: continue
            path = os.path.join(d, f)
            try:
                if self.run_book(path): 
                    os.makedirs(done_dir, exist_ok=True); dst = os.path.join(done_dir, f)
                    if os.path.exists(dst): dst = os.path.join(done_dir, time.strftime("%Y%m%d%H%M%S_") + f)
                    shutil.move(path, dst); log("文件已移到「已完成」：%s" % f)
                return True
            except KeyboardInterrupt: raise
            except SystemExit: raise
            except Exception as e:
                self.bad[f] = self.bad.get(f, 0) + 1; log("这本书处理出错（%s）：%s（第 %d 次）" % (f, e, self.bad[f]))
                if self.bad[f] >= 3: log("多次出错，先跳过它：%s（把文件改个名或重启录音机可再试）" % f)
                return True
        return False

    def prepare(self, path):
        """确认书在书库里（没有就上架），返回 job 信息；已经上架过的同一个文件不重复检查"""
        a, tok = self.a, self.tok
        text, title, author = mb.read_book(path); sents, pst = mb.split(text)
        if len(sents) < 3: log("跳过（没读到文字）：%s" % os.path.basename(path)); self.bad[os.path.basename(path)] = 99; return None
        fp = hashlib.sha1((title + "\n" + "\n".join(sents)).encode("utf-8")).hexdigest()
        vk = re.sub(r"[^a-z0-9_]", "", a.watch_voice.lower())[:24]
        if a.watch_dialogue: vk = (vk + "_x_" + re.sub(r"[^a-z0-9_]", "", a.watch_dialogue.lower()))[:24]
        nk, dk = split_key(vk); speaker = (CN.get(nk, nk) + "+" + CN.get(dk, dk)) if dk else spk_name(nk)
        bid = "b" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:10]
        try:
            old = get_book(bid); ofp = hashlib.sha1((old.get("title", "") + "\n" + "\n".join(old.get("s", []))).encode("utf-8")).hexdigest()
            exists = True
        except Exception: old = None; ofp = ""; exists = False
        if exists and ofp != fp:                    # 书名一样但内容不同：当成另一本，另起一个编号
            bid = "b" + fp[:10]
            try: get_book(bid); exists = True
            except Exception: exists = False
        if exists: log("《%s》书库里已经有了，不重复上传" % title)
        else:
            log("《%s》书库里还没有，先上架（%d 句）" % (title, len(sents)))
            mb.put_book(bid, title, author, speaker, sents, pst, tok, vk)
        return {"id": bid, "voice": vk, "from": 0, "title": title, "local": True}

    def run_book(self, path):
        job = self.prepare(path)
        if not job: return False
        self.cur_file = os.path.basename(path)
        try: return self.run_job(job)
        finally: self.cur_file = ""

    def preupload(self):
        """每录完一小批顺便看一眼文件夹：把排在最前面、还没上架的下一本书先上架（一次只上一本），读者先能读"""
        d = self.a.watch
        if not d or not os.path.isdir(d): return
        try:
            for f in sorted(os.listdir(d)):
                path = os.path.join(d, f)
                if not (f.lower().endswith(self.BOOK_EXT) and os.path.isfile(path)) or f.startswith("~$") or f == self.cur_file: continue
                if self.bad.get(f, 0) >= 3: continue
                sig = (f, os.path.getsize(path), int(os.path.getmtime(path)))
                if sig in self.pre: continue
                self.pre.add(sig)
                self.prepare(path); return                 # 一次只提前上一本
        except KeyboardInterrupt: raise
        except SystemExit: raise
        except Exception as e: log("提前上架出错（%s），稍后再说" % e)

    def loop(self):
        a = self.a
        if a.watch:
            try: os.makedirs(a.watch, exist_ok=True); log("盯着文件夹：%s（把电子书丢进去就会自动录）" % a.watch)
            except Exception as e: log("没能建文件夹（%s）" % e)
        log("喵喵录音机已开启，在等手机上点“开始录这个声音”…（关掉这个窗口就停止）")
        while True:
            try:
                jobs = get_queue(self.tok)
                if not jobs:
                    if self.scan_watch(): continue
                    ping(self.tok, "", "空闲")
                    if a.once: return
                    time.sleep(a.poll); continue
                self.run_job(jobs[0])
            except KeyboardInterrupt:
                log("已停止；再开着它会接着录"); return
            except SystemExit: raise
            except Exception as e:
                log("出错了（%s），10 秒后重试" % e); time.sleep(10)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--watch", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "放这里自动录的书"), help="盯着的文件夹；传空字符串 \"\" 就不盯")
    ap.add_argument("--watch-dialogue", default="", help="文件夹里的书：对话用另一个声音（比如 eric），不填就全书一个声音")
    ap.add_argument("--watch-voice", default=os.environ.get("MIAO_WATCH_VOICE", "cv_nv"), help="文件夹里的书用哪个声音录（默认 CosyVoice 女声“晓雅”；以前是 uncle_fu 福伯）")
    ap.add_argument("--model"); ap.add_argument("--bitrate", default="48k")
    ap.add_argument("--gen", type=int, default=int(os.environ.get("MIAO_GEN", "16")), help="每批同时录几句，显存够可以调大")
    ap.add_argument("--poll", type=float, default=5, help="多少秒问一次服务器")
    ap.add_argument("--instruct", default="请用标准普通话朗读，发音清晰自然，不要带任何方言或地方口音。")
    ap.add_argument("--temp", type=float, default=0.6)
    ap.add_argument("--cpu", action="store_true", help="CosyVoice / ChatTTS 用 CPU 录（慢，显卡被别的程序占着时用）")
    ap.add_argument("--fake", action="store_true", help="测试用：不真录音"); ap.add_argument("--once", action="store_true", help="测试用：清单空了就退出")
    Recorder(ap.parse_args()).loop()


if __name__ == "__main__": main()
