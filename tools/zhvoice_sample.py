#!/usr/bin/env python3
"""稳定声音试听：拿一本真书里连续的几十句，用每个稳定声音录一遍，排成网页（像在手机上一样一句接一句连着放），
再算“句子之间起伏多大”的数。

用法（在 qwen3-tts 环境里，和录音机同一个文件夹）：
    python zhvoice_sample.py --txt 某本书.txt                  从书的第 1 句开始录 40 句
    python zhvoice_sample.py --book b1234567890 --from 200     书库里的书（编号见手机上），从第 200 句开始
    python zhvoice_sample.py --txt 书.txt --voices cv_nv,cv_fu --n 60 --cpu
结果在 试听稳定声音\\试听.html。中途停了再运行会接着录。
"""
import argparse, html, json, os, re, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import miaobook as mb
import zhvoices as zv
import miaorecorder as mr


def analyse(path):
    import numpy as np, soundfile as sf
    w, sr = sf.read(path, dtype="float32", always_2d=True); w = w.mean(axis=1)
    n, h = int(0.04 * sr), int(0.01 * sr)
    if len(w) < n * 3: return None
    fr = np.lib.stride_tricks.sliding_window_view(w, n)[::h]
    rms = np.sqrt((fr ** 2).mean(axis=1) + 1e-12); db = 20 * np.log10(rms); act = db > db.max() - 35
    idx = np.where(act)[0]; loud = 10 * np.log10((rms[act] ** 2).mean())
    lo, hi = int(sr / 400), int(sr / 60); f0 = []
    for x in fr[act & (db > db.max() - 25)][::2]:
        x = x - x.mean(); ac = np.fft.irfft(np.abs(np.fft.rfft(x, 2 * n)) ** 2)[:n]
        if ac[0] <= 0 or hi >= n: continue
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] / ac[0] > 0.4: f0.append(sr / k)
    return {"speech": (idx[-1] - idx[0]) * 0.01 + 0.04, "loud": loud, "pitch": float(np.median(f0)) if len(f0) > 5 else None}


def stats(rows):
    import numpy as np
    rows = [(t, A) for t, A in rows if A]
    if len(rows) < 3: return {}
    L = np.array([A["loud"] for _, A in rows]); P = np.array([12 * np.log2(A["pitch"]) for _, A in rows if A["pitch"]])
    R = np.array([max(1, len(re.findall(r"[一-鿿]", t))) / A["speech"] for t, A in rows])
    # 相邻两句的跳动：这是耳朵最容易听出来的“忽高忽低”
    J = np.abs(np.diff(P)) if len(P) > 2 else None
    return {"音量起伏 dB": L.std(), "音高起伏 半音": P.std() if len(P) > 2 else None, "相邻句音高跳动 半音": J.mean() if J is not None else None,
            "语速起伏 %": 100 * R.std() / R.mean()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--txt"); ap.add_argument("--book"); ap.add_argument("--from", dest="start", type=int, default=1)
    ap.add_argument("--n", type=int, default=40); ap.add_argument("--voices", default=",".join(zv.VOICES))
    ap.add_argument("--out", default=os.path.join(HERE, "试听稳定声音")); ap.add_argument("--cpu", action="store_true"); ap.add_argument("--bitrate", default="48k")
    a = ap.parse_args()
    if a.txt: text, title, _ = mb.read_book(a.txt); sents = mb.split(text)[0]
    elif a.book: b = mr.get_book(a.book); sents, title = b["s"], b.get("title", a.book)
    else: raise SystemExit("用 --txt 指定一本书，或 --book 指定书库里的书")
    sents = [s for s in sents[a.start - 1:] if s.strip()][: a.n]
    print("《%s》第 %d 句起，共 %d 句" % (title, a.start, len(sents)), flush=True)
    voices = [v.strip() for v in a.voices.split(",") if v.strip()]
    order = sorted(voices, key=lambda v: zv.VOICES[v]["engine"])            # 同一个模型的声音挨着录，少换几次模型
    w = None; speed = {}
    for v in order:
        d = os.path.join(a.out, v); os.makedirs(d, exist_ok=True)
        todo = [(t, os.path.join(d, "%03d.mp3" % i)) for i, t in enumerate(sents, 1) if not os.path.exists(os.path.join(d, "%03d.mp3" % i))]
        print("%s（%s）：还要录 %d 句" % (v, zv.VOICES[v]["name"], len(todo)), flush=True)
        if not todo: continue
        eng = zv.VOICES[v]["engine"]
        if w and w.engine != eng: w.close(); w = None
        if not w: w = mr.Worker(eng, a)
        t0 = time.time()
        for i in range(0, len(todo), 8):
            try: w.tts(v, todo[i:i + 8])
            except Exception as e: print("  这一批失败：%s" % e, flush=True)
            print("  %d/%d" % (min(i + 8, len(todo)), len(todo)), flush=True)
        speed[v] = time.time() - t0
    if w: w.close()
    S, lists = {}, {}
    for v in voices:
        d = os.path.join(a.out, v); rows = []; lists[v] = []
        for i, t in enumerate(sents, 1):
            p = os.path.join(d, "%03d.mp3" % i)
            if os.path.exists(p): rows.append((t, analyse(p))); lists[v].append("%s/%03d.mp3" % (v, i))
        S[v] = stats(rows)
    f = lambda x: "—" if x is None else "%.1f" % x
    keys = ["音量起伏 dB", "音高起伏 半音", "相邻句音高跳动 半音", "语速起伏 %"]
    trs = "".join("<tr><td><b>%s</b> %s</td>%s<td><button onclick='play(%s)'>▶ 连着放</button></td></tr>" % (
        html.escape(zv.VOICES[v]["name"]), v, "".join("<td>%s</td>" % f(S[v].get(k)) for k in keys), json.dumps(v)) for v in voices)
    grid = "".join("<tr><td class=t>%d. %s</td>%s</tr>" % (i, html.escape(t), "".join(
        "<td><audio controls preload=none src='%s/%03d.mp3'></audio></td>" % (v, i) for v in voices)) for i, t in enumerate(sents, 1))
    page = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>稳定声音试听</title>
<style>body{font:15px system-ui,sans-serif;margin:16px;color:#222}table{border-collapse:collapse;margin:8px 0 20px}td,th{border:1px solid #ddd;padding:4px 8px}th{background:#f4f1ea}
td.t{max-width:420px}audio{width:180px;height:32px}#now{margin:10px 0;padding:10px;background:#fbf6e9;border-radius:8px;min-height:1.5em}button{font-size:15px;padding:4px 10px}</style>
<h2>稳定声音试听：《%s》</h2>
<p>点“连着放”就像在手机上听书一样一句接一句播放，最能听出句子之间稳不稳。数字越小越稳（相邻句音高跳动就是“这句高、下句低”的程度）。</p>
<table><tr><th>声音</th>%s<th></th></tr>%s</table>
<div id=now></div><button onclick="stop()">■ 停</button>
<h3>逐句对比</h3><table><tr><th>句子</th>%s</tr>%s</table>
<script>const L=%s,S=%s;let au=new Audio(),q=[],k=0,cur='';
function play(v){cur=v;q=L[v];k=0;next()}function next(){if(k>=q.length){document.getElementById('now').textContent='放完了';return}
document.getElementById('now').textContent=cur+'  '+(k+1)+'. '+S[k];au.src=q[k++];au.play()}au.onended=next;function stop(){au.pause();q=[]}</script>""" % (
        html.escape(title), "".join("<th>%s</th>" % k for k in keys), trs, "".join("<th>%s</th>" % html.escape(zv.VOICES[v]["name"]) for v in voices), grid,
        json.dumps(lists, ensure_ascii=False), json.dumps(sents, ensure_ascii=False))
    p = os.path.join(a.out, "试听.html")
    with open(p, "w", encoding="utf-8") as fh: fh.write(page)
    for v in voices: print("%s：%s" % (v, "  ".join("%s %s" % (k, f(S[v].get(k))) for k in keys)))
    print("已生成：" + p)


if __name__ == "__main__": main()
