"""统一旧书语音的音量：以前用微软声音录的书，单词录音比句子轻（单词后面还拖着一秒多的静音）。

把服务器上每本免费英文书的语音取下来，像英文录音机一样切掉头尾静音、音量统一到 -20 dB，
再传回去，重新打“下载全部语音”的包。英文录音机录的书本来就统一过，会自动跳过。
手机上已经下载过的书，要再点一次“下载全部语音”才会换成新的。

用法（在 tts-kokoro 环境里）：
  python fixloud.py --dry          只看看哪些书、多少条要改，不上传
  python fixloud.py                全部免费书都改
  python fixloud.py the-tale-of-peter-rabbit   只改这一本
原来的录音备份在 ~/fixloud/<书>/原来的/ 里。
"""
import argparse, io, json, os, sys, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import miaobook as mb
from enrecorder import polish, to_mp3, zip_clips, batches, catalog, log

ROOT = os.path.expanduser("~/fixloud")


def get(path):
    req = urllib.request.Request(mb.API + path, headers={"Origin": os.environ.get("MIAO_ORIGIN", "https://app.miaomiaosw.com")})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise


def pack_clips(bid):
    """这本书“下载全部语音”的所有分包 → {哈希: mp3}"""
    clips, k, n = {}, 1, 1
    while k <= n:
        b = get("/files/%s.voice%s.zip" % (bid, "" if k == 1 else k))
        if b is None: break
        with zipfile.ZipFile(io.BytesIO(b)) as z:
            for nm in z.namelist():
                if nm == "manifest.json":
                    try: n = max(n, int(json.loads(z.read(nm)).get("parts") or 1))
                    except Exception: pass
                elif nm.startswith("clips/") and nm.endswith(".mp3"): clips[nm[6:-4]] = z.read(nm)
        k += 1
    if not clips:                                                 # 语音太多没打总包：一条一条取
        for h in mb.call("GET", "/admin/clips/%s" % bid, tok=mb.token()).get("have", []):
            b = get("/files/%s/%s.mp3" % (bid, h))
            if b: clips[h] = b
    return clips


def fix_book(bid, dry):
    import numpy as np, soundfile as sf
    clips = pack_clips(bid)
    if not clips: log("《%s》服务器上没有语音包，跳过" % bid); return 0
    d = os.path.join(ROOT, bid); orig = os.path.join(d, "原来的"); new = os.path.join(d, "统一后")
    os.makedirs(orig, exist_ok=True); os.makedirs(new, exist_ok=True)
    todo = []
    for h, b in clips.items():
        try: w, sr = sf.read(io.BytesIO(b), dtype="float32")
        except Exception as e: log("  %s 读不了（%s），跳过" % (h[:8], e)); continue
        if w.ndim > 1: w = w.mean(axis=1)
        if not len(w): continue
        rms = 20 * np.log10(float(np.sqrt((w ** 2).mean())) or 1e-9)
        p = polish(w, sr); trimmed = len(w) - len(p)
        if abs(rms + 20) < 1 and trimmed < 0.3 * sr: continue      # 本来就统一过（英文录音机录的）
        with open(os.path.join(orig, h + ".mp3"), "wb") as f: f.write(b)
        out = os.path.join(new, h + ".mp3")
        if not dry: to_mp3(p, out, sr)
        todo.append((h, out))
    log("《%s》共 %d 条语音，要统一音量 %d 条" % (bid, len(clips), len(todo)))
    if dry or not todo: return len(todo)
    tok = mb.token()
    for g in batches(todo): mb.call("PUT", "/admin/file/%s.voice.zip?last=0" % bid, zip_clips(g), "application/zip", tok)
    mb.call("POST", "/admin/repack/%s" % bid, b"", None, tok)
    log("《%s》传好了，“下载全部语音”的包已重新打好" % bid)
    return len(todo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*", help="只改这几本（编号）；不写就是所有免费英文书")
    ap.add_argument("--dry", action="store_true", help="只统计，不上传")
    a = ap.parse_args()
    ids = a.ids
    if not ids:
        items = catalog()
        ids = [it["id"] for it in items if it.get("voice") and not it.get("price")]
        paid = [it["id"] for it in items if it.get("voice") and it.get("price")]
        if paid: log("收费书的语音在私有目录，这次不改：" + "、".join(paid))
    t0, total = time.time(), 0
    for bid in ids:
        try: total += fix_book(bid, a.dry)
        except Exception as e: log("《%s》出错：%s" % (bid, e))
    log("完成：一共%s %d 条，用了 %d 秒" % ("要改" if a.dry else "改了", total, time.time() - t0))


if __name__ == "__main__":
    main()
