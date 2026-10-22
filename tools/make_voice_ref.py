#!/usr/bin/env python3
"""给 CosyVoice 的声音挑一段参考录音（它会模仿这段录音的音色和念法）。

用法（在 qwen3-tts 环境里，和录音机同一个文件夹）：
    python make_voice_ref.py cv_fu                 从福伯（uncle_fu）录过的句子里自动挑一句最合适的
    python make_voice_ref.py cv_fu --list          只列出前 10 个候选，不写文件
    python make_voice_ref.py cv_fu --pick 3        用第 3 个候选
    python make_voice_ref.py cv_xx --wav 某段录音.wav --text "录音里念的字"     用你自己的一段录音

结果写到 voices/<编号>.wav 和 voices/<编号>.txt。挑的标准：6～11 秒、一句完整的旁白（不带引号、数字、英文）、
语速接近福伯的平均语速（太快太慢的都不要）。挑好以后可以先用 zhtts_worker.py --test 听一句。
"""
import argparse, glob, json, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import miaobook as mb
import zhvoices as zv

SRC = {"cv_fu": "uncle_fu"}


def candidates(src):
    import soundfile as sf, urllib.request
    root = os.path.join(os.path.expanduser("~/miaobook_cache"))
    out = []
    for d in glob.glob(os.path.join(root, "*", src)):
        bid = os.path.basename(os.path.dirname(d))
        try:
            req = urllib.request.Request(mb.API + "/zl/%s/book.json" % bid, headers={"Origin": os.environ.get("MIAO_ORIGIN", "https://app.miaomiaosw.com")})
            with urllib.request.urlopen(req, timeout=60) as r: book = json.loads(r.read().decode("utf-8"))
        except Exception as e: print("（跳过 %s：%s）" % (bid, e)); continue
        text = {mb.zl_hash(t): t.strip() for t in book.get("s", [])}
        for f in glob.glob(os.path.join(d, "*.mp3")):
            t = text.get(os.path.basename(f)[:-4])
            if not t or not t.endswith("。") or re.search(r"[“”「」『』\"'0-9A-Za-z…—]", t): continue
            n = len(re.findall(r"[一-鿿]", t))
            if n < 18: continue
            try: info = sf.info(f); dur = info.frames / float(info.samplerate)
            except Exception: continue
            if 6 <= dur <= 11: out.append({"path": f, "text": t, "dur": dur, "rate": n / dur, "book": book.get("title", bid)})
    if not out: return out
    rates = sorted(c["rate"] for c in out); med = rates[len(rates) // 2]
    for c in out: c["score"] = abs(c["rate"] / med - 1) * 3 + abs(c["dur"] - 8.5) / 8.5
    return sorted(out, key=lambda c: c["score"])


def write(k, wav_src, text):
    import soundfile as sf
    os.makedirs(zv.VOICE_DIR, exist_ok=True); dst = os.path.join(zv.VOICE_DIR, k + ".wav")
    w, sr = sf.read(wav_src, dtype="float32", always_2d=True); sf.write(dst, w.mean(axis=1), sr, subtype="PCM_16")
    with open(os.path.join(zv.VOICE_DIR, k + ".txt"), "w", encoding="utf-8") as f: f.write(text.strip())
    print("已写：%s\n念的字：%s" % (dst, text.strip()))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("voice")
    ap.add_argument("--list", action="store_true"); ap.add_argument("--pick", type=int, default=1)
    ap.add_argument("--wav"); ap.add_argument("--text")
    a = ap.parse_args()
    if a.wav:
        if not a.text: raise SystemExit("要用 --text 写上录音里念的字")
        return write(a.voice, a.wav, a.text)
    src = SRC.get(a.voice) or raise_(a.voice)
    cs = candidates(src)
    if not cs: raise SystemExit("~/miaobook_cache 里没找到 %s 录过的合适句子" % src)
    for i, c in enumerate(cs[:10], 1): print("%2d. %.1f 秒  每秒 %.1f 字  《%s》%s" % (i, c["dur"], c["rate"], c["book"], c["text"]))
    if a.list: return
    c = cs[min(a.pick, len(cs)) - 1]; print("用第 %d 个" % min(a.pick, len(cs)))
    write(a.voice, c["path"], c["text"])


def raise_(k): raise SystemExit("不知道 %s 该从哪个声音里挑；用 --wav 和 --text 指定一段录音" % k)


if __name__ == "__main__": main()
