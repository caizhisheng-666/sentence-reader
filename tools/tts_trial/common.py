"""试听脚本共用的部分：读 samples.json，列出要念的每一条，存成 wav。

每个模型一个文件夹：试听/<模型>-<声音>/，里面的文件名是
  en01.wav … en20.wav、en01-2.wav（同一句第 2 遍）、w01-the.wav …、zh01.wav …
已经录好的文件会跳过，中途停了再运行会接着录。
"""
import json, os, re, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("TTS_TRIAL_OUT") or os.path.join(HERE, "试听")


def load():
    with open(os.path.join(HERE, "samples.json"), encoding="utf-8") as f: return json.load(f)


def jobs(langs=("en", "words", "zh")):
    """[(文件名不带 .wav, 文字, 种类)]，种类是 en / word / zh"""
    s = load(); out = []
    for kind, key in (("en", "en"), ("word", "words"), ("zh", "zh")):
        if key not in langs: continue
        rep = set(s["repeat"].get(key, []))
        for i, t in enumerate(s[key]):
            base = ("w%02d-%s" % (i + 1, re.sub(r"[^a-z]+", "", t.lower()))) if kind == "word" else "%s%02d" % (kind, i + 1)
            out.append((base, t, kind))
            if i in rep: out += [(base + "-2", t, kind), (base + "-3", t, kind)]
    return out


def outdir(name):
    d = os.path.join(OUT, name); os.makedirs(d, exist_ok=True); return d


def save(path, sr, wav):
    import numpy as np, soundfile as sf
    w = np.asarray(wav, dtype="float32").reshape(-1)
    sf.write(path, w, int(sr), subtype="PCM_16")


def run(name, items, synth):
    """synth(文字, 种类) → (采样率, 波形)。逐条录，打印进度和每条用时（看速度）"""
    d = outdir(name); todo = [(b, t, k) for b, t, k in items if not os.path.exists(os.path.join(d, b + ".wav"))]
    print("%s：共 %d 条，还要录 %d 条" % (name, len(items), len(todo)), flush=True)
    t0 = time.time(); secs = 0.0
    for n, (b, t, k) in enumerate(todo, 1):
        try:
            sr, wav = synth(t, k)
            save(os.path.join(d, b + ".wav"), sr, wav); secs += len(wav) / float(sr)
        except KeyboardInterrupt: print("已停止，下次运行会接着录"); sys.exit(0)
        except Exception as e: print("  %s 失败：%s" % (b, e), flush=True)
        if n % 10 == 0 or n == len(todo): print("  %d/%d" % (n, len(todo)), flush=True)
    el = time.time() - t0
    if todo and secs:                                  # 录 1 秒声音要花几秒：越小越快
        with open(os.path.join(d, "speed.json"), "w", encoding="utf-8") as f: json.dump({"wall": el, "audio": secs}, f)
        print("%s：用了 %.0f 秒，录出 %.0f 秒声音（每秒声音花 %.2f 秒）" % (name, el, secs, el / secs), flush=True)
