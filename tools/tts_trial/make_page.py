"""把 试听/ 里各个模型录的声音排成一张网页（试听/试听.html），并算几个“稳不稳”的数：
- 句子之间：连续 20 句的音量、音高、语速各自起伏多大（越小越稳，就是你说的“起伏不定”）
- 同一句念 3 遍：每遍之间差多少（越小说明每次念出来越一样）
- 单词：平均多长，有几个超过 1.5 秒（单个词念这么长，多半是拖尾音或念错了）
- 速度：录 1 秒声音要花几秒
只用 numpy + soundfile，哪个环境都能跑：python make_page.py
"""
import html, json, os, re
import numpy as np, soundfile as sf
import common

FR, HOP = 0.04, 0.01


def analyse(path):
    w, sr = sf.read(path, dtype="float32", always_2d=True); w = w.mean(axis=1)
    n, h = int(FR * sr), int(HOP * sr)
    if len(w) < n: return None
    frames = np.lib.stride_tricks.sliding_window_view(w, n)[::h]
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12); db = 20 * np.log10(rms)
    act = db > db.max() - 35                            # 有声音的帧
    idx = np.where(act)[0]; lead = idx[0] * HOP; tail = (len(db) - 1 - idx[-1]) * HOP
    loud = 10 * np.log10((rms[act] ** 2).mean())
    lo, hi = int(sr / 400), int(sr / 60); f0 = []          # 音高：每帧自相关找周期，只算响亮的帧
    for fr in frames[act & (db > db.max() - 25)][::2]:
        fr = fr - fr.mean(); ac = np.fft.irfft(np.abs(np.fft.rfft(fr, 2 * n)) ** 2)[:n]
        if ac[0] <= 0 or hi >= n: continue
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] / ac[0] > 0.4: f0.append(sr / k)
    return {"dur": len(w) / sr, "speech": (idx[-1] - idx[0]) * HOP + FR, "lead": lead, "tail": tail, "loud": loud,
            "pitch": float(np.median(f0)) if len(f0) > 5 else None}


def first(b): return not re.search(r"-[23]$", b)       # 不是“第 2、3 遍”


def units(text, kind): return max(1, len(re.findall(r"[一-鿿]", text)) if kind == "zh" else len(text.split()))


def summary(name, items):
    d = os.path.join(common.OUT, name); A = {}
    for b, t, k in items:
        p = os.path.join(d, b + ".wav")
        if os.path.exists(p): A[b] = analyse(p)
    out = {}
    for kind in ("en", "zh"):
        base = [(b, t) for b, t, k in items if k == kind and first(b) and A.get(b)]
        if len(base) < 3: continue
        L = np.array([A[b]["loud"] for b, _ in base]); R = np.array([units(t, kind) / A[b]["speech"] for b, t in base])
        P = np.array([12 * np.log2(A[b]["pitch"]) for b, _ in base if A[b]["pitch"]])
        reps = [[A.get(x) for x in (b, b + "-2", b + "-3")] for b, _ in base]
        reps = [r for r in reps if all(r)]
        out[kind] = {"音量起伏(dB)": L.std(), "音高起伏(半音)": P.std() if len(P) > 2 else None, "语速起伏(%)": 100 * R.std() / R.mean(),
                     "同句3遍时长差(%)": np.mean([100 * (max(x["dur"] for x in r) / min(x["dur"] for x in r) - 1) for r in reps]) if reps else None}
    ws = [A[b] for b, t, k in items if k == "word" and first(b) and A.get(b)]
    if ws: out["word"] = {"单词平均长(秒)": np.mean([x["speech"] for x in ws]), "超过1.5秒的单词": sum(x["speech"] > 1.5 for x in ws)}
    try: sp = json.load(open(os.path.join(d, "speed.json"), encoding="utf-8")); out["speed"] = sp["wall"] / sp["audio"]
    except Exception: pass
    return out, A


def main():
    names = sorted(x for x in os.listdir(common.OUT) if os.path.isdir(os.path.join(common.OUT, x)))
    items = common.jobs(); S = {n: summary(n, items) for n in names}
    f = lambda v, p=1: "—" if v is None else ("%." + str(p) + "f") % v
    rows = []
    for n in names:
        s = S[n][0]; en, zh, wd = s.get("en", {}), s.get("zh", {}), s.get("word", {})
        rows.append("<tr><td>%s</td>%s<td>%s</td></tr>" % (html.escape(n), "".join("<td>%s</td>" % f(d.get(k)) for d in (en, zh) for k in ("音量起伏(dB)", "音高起伏(半音)", "语速起伏(%)", "同句3遍时长差(%)")) +
                    "<td>%s</td><td>%s</td>" % (f(wd.get("单词平均长(秒)"), 2), wd.get("超过1.5秒的单词", "—")), f(s.get("speed"), 2)))
    grid = []
    for b, t, k in items:
        cells = "".join('<td>%s</td>' % ('<audio controls preload="none" src="%s/%s.wav"></audio>' % (html.escape(n), b) if os.path.exists(os.path.join(common.OUT, n, b + ".wav")) else "") for n in names)
        grid.append('<tr><td class="t"><b>%s</b> %s</td>%s</tr>' % (b, html.escape(t), cells))
    head = "".join("<th>%s</th>" % html.escape(n) for n in names)
    page = """<!doctype html><meta charset="utf-8"><title>声音试听</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#222}table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #ddd;padding:4px 6px;vertical-align:middle}
th{background:#f4f1ea;position:sticky;top:0}td.t{max-width:360px}audio{width:190px;height:32px}.n{color:#666;max-width:900px}</style>
<h2>声音试听</h2>
<p class="n">上面这张表是“稳不稳”：除了最后一列，数字都是越小越稳。音量、音高、语速起伏是连续 20 句英文（或 10 句中文）之间的差别，就是你说的“起伏不定”；同句 3 遍时长差是同一句念三遍差多少；超过 1.5 秒的单词多半是拖尾音或念错了。数字只是参考，最后还是以你的耳朵为准。</p>
<table><tr><th rowspan=2>模型-声音</th><th colspan=4>英文句子</th><th colspan=4>中文</th><th colspan=2>单词</th><th rowspan=2>录1秒花几秒</th></tr>
<tr><th>音量起伏 dB</th><th>音高起伏 半音</th><th>语速起伏 %%</th><th>同句3遍差 %%</th><th>音量起伏 dB</th><th>音高起伏 半音</th><th>语速起伏 %%</th><th>同句3遍差 %%</th><th>平均长 秒</th><th>超1.5秒</th></tr>
%s</table>
<p class="n">下面一行一句，横着对比各个模型。带“-2”“-3”的是同一句再念的第 2、3 遍。</p>
<table><tr><th>文字</th>%s</tr>%s</table>""" % ("".join(rows), head, "".join(grid))
    p = os.path.join(common.OUT, "试听.html")
    with open(p, "w", encoding="utf-8") as fh: fh.write(page)
    print("已生成：" + p)

if __name__ == "__main__": main()
