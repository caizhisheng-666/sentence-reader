#!/usr/bin/env python3
"""喵喵录音机：开着它，手机上点“开始录这个声音”，它就自动录、自动上传。

用法：双击「喵喵录音机.bat」（或在装了 Qwen3-TTS 的环境里运行 python miaorecorder.py）。
它做的事：
  1. 每隔几秒问服务器：有没有人点了“开始录某本书的某个声音”？
  2. 有 → 从你在手机上听到的那一句开始往后录（录完最后一句再回到开头补前面的），
         每录一小批就上传一次，手机上马上就能听到；
  3. 全部录完 → 告诉服务器“这个声音录好了”，接着看有没有下一个；没有就等着。
电脑关机或关掉这个窗口时它就停了；下次开着它，没录完的会接着录（已经上传的句子自动跳过）。
第一次运行会问一次开发者口令（输在你自己电脑上，记在 ~/.miaobook）。
"""
import argparse, os, sys, time, json, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import miaobook as mb

# 手机上显示的声音 → Qwen 模型里的名字
SPEAKERS = {"vivian": "Vivian", "serena": "Serena", "uncle_fu": "Uncle_Fu", "dylan": "Dylan", "eric": "Eric"}
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


class Recorder:
    def __init__(self, a):
        self.a = a; self.tok = mb.token(); self.model = None; self.q = None

    def tts_for(self, speaker):
        """返回 tts(列表[(句子, mp3路径)])"""
        a = self.a
        if a.fake:
            src = os.environ.get("MIAO_FAKE_MP3"); blob = open(src, "rb").read() if src else b"ID3" + bytes(600)     # 测试用：不真录音，写一个现成的小 mp3
            def fake(items):
                for _, path in items: open(path, "wb").write(blob); time.sleep(float(os.environ.get("MIAO_FAKE_DELAY", "0")))
            return fake
        import qwen_batch as q
        self.q = q
        if self.model is None:
            ping(self.tok, "", "正在加载模型…"); log("正在加载模型（第一次要一两分钟）…")
            self.model = q.load_model(a.model or q.default_model())
        def real(items):
            ins = None if speaker in ("Dylan", "Eric") else (a.instruct or None)      # 北京话、四川话本来就是方言，不要压它
            res = q.synth_batch(self.model, [t for t, _ in items], speaker, "Chinese", ins, a.temp)
            for (_, path), (sr, wav) in zip(items, res): q.to_mp3(sr, wav, path, a.bitrate)
        return real

    def run_job(self, job):
        a, tok = self.a, self.tok
        bid, vk = job["id"], job["voice"]; speaker = SPEAKERS.get(vk) or vk.capitalize()
        label = "%s|%s" % (bid, vk)
        book = get_book(bid); sents = book["s"]; n = len(sents)
        have = set(mb.call("GET", "/admin/zl/%s/have?voice=%s" % (bid, vk), tok=tok).get("have", []))
        start = max(0, min(n - 1, int(job.get("from", 0))))
        order = list(range(start, n)) + list(range(0, start))          # 从听到的那句往后，再回到开头
        seen, todo = set(), []
        for i in order:
            t = sents[i]; h = mb.zl_hash(t)
            if not t.strip() or h in seen: continue
            seen.add(h)
            if h not in have: todo.append((t, h))
        log("《%s》声音 %s：共 %d 句，从第 %d 句开始，还要录 %d 句" % (job.get("title", bid), speaker, n, start + 1, len(todo)))
        if todo:
            tts = self.tts_for(speaker)
            cache = os.path.join(os.path.expanduser("~/miaobook_cache"), bid, vk); os.makedirs(cache, exist_ok=True)
            done = 0; bi = 0; t0 = time.time(); skipped = 0
            while todo:
                size = FIRST_BATCHES[bi] if bi < len(FIRST_BATCHES) else a.gen; bi += 1
                grp, todo = todo[:size], todo[size:]
                need = []
                for t, h in grp:
                    p = os.path.join(cache, h + ".mp3")
                    if not (os.path.exists(p) and os.path.getsize(p) > 100): need.append((t, p))
                if need:
                    try: tts(need)
                    except KeyboardInterrupt: raise
                    except Exception as e:
                        log("这一批失败（%s），改成一句一句录" % e)
                        for it in need:
                            try: tts([it])
                            except KeyboardInterrupt: raise
                            except Exception as e2: log("  这一句跳过：%s" % e2)
                items = []
                for t, h in grp:
                    p = os.path.join(cache, h + ".mp3")
                    if os.path.exists(p) and os.path.getsize(p) > 100: items.append((h, p))
                    else: skipped += 1
                if items: mb.put_clips(bid, items, tok, vk)
                done += len(grp); el = time.time() - t0
                msg = "%d/%d" % (done, done + len(todo)); ping(tok, label, msg)
                log("%s  已用 %.1f 分钟" % (msg, el / 60))
                # 每批之后看一眼：有没有人换了新的要求（点了别的书/声音，或在这本书里跳到了别处）
                jobs = get_queue(tok)
                if not jobs or jobs[0]["id"] != bid or jobs[0]["voice"] != vk or int(jobs[0].get("from", 0)) != int(job.get("from", 0)):
                    log("有新的要求，先去处理它（这个声音录了一部分，下次接着录）"); return False
        mb.call("POST", "/admin/queue/done", json.dumps({"id": bid, "voice": vk}).encode("utf-8"), "application/json", tok)
        log("✅ 《%s》的声音 %s 录好了" % (job.get("title", bid), speaker)); return True

    def loop(self):
        a = self.a; log("喵喵录音机已开启，在等手机上点“开始录这个声音”…（关掉这个窗口就停止）")
        while True:
            try:
                jobs = get_queue(self.tok)
                if not jobs:
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
    ap.add_argument("--model"); ap.add_argument("--bitrate", default="48k")
    ap.add_argument("--gen", type=int, default=16, help="每批同时录几句，显存够可以调大")
    ap.add_argument("--poll", type=float, default=5, help="多少秒问一次服务器")
    ap.add_argument("--instruct", default="请用标准普通话朗读，发音清晰自然，不要带任何方言或地方口音。")
    ap.add_argument("--temp", type=float, default=0.6)
    ap.add_argument("--fake", action="store_true", help="测试用：不真录音"); ap.add_argument("--once", action="store_true", help="测试用：清单空了就退出")
    Recorder(ap.parse_args()).loop()


if __name__ == "__main__": main()
