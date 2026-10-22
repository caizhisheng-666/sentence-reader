#!/usr/bin/env python3
"""喵喵录音机的帮手：在 CosyVoice / ChatTTS 自己的环境（tts-cosy / tts-chattts）里运行，模型只加载一次，一句一句录成 mp3。

录音机会自己启动它，平时不用管。它从标准输入一行一行收任务（JSON）：
    {"voice": "cv_nv", "texts": ["句子1", ...], "paths": ["...mp3", ...]}
每个任务做完回一行 "@@ZHTTS {"ok": true}"（或 {"err": "..."}）。其它输出都是给人看的日志。

为了稳：
  - 每句录之前都把随机种子设成同一个数 → 同一句每次念出来一样，句子和句子之间也不会忽高忽低；
  - CosyVoice 每句都模仿同一段参考录音；ChatTTS 每句都用同一个说话人、低 temperature、不“润色”文字；
  - 录完把每句头尾的空白剪齐，音量统一到同一个响度（不会这句大声那句小声）。

单独测试（在 tts-cosy 环境里）：python zhtts_worker.py --test cv_nv "床前明月光，疑是地上霜。"   → 写到 test-cv_nv.mp3
"""
import argparse, io, json, os, re, subprocess, sys, time, random

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import zhvoices as zv

SEED = 1986
OUT = sys.stdout                                   # 回复走这里；模型库乱打印的东西改到 stderr，免得搅乱回复
sys.stdout = sys.stderr


def reply(obj): OUT.write("@@ZHTTS " + json.dumps(obj, ensure_ascii=False) + "\n"); OUT.flush()


def log(m): print(time.strftime("%H:%M:%S "), "[帮手]", m, flush=True)


def seed_all(s):
    import numpy as np, torch
    random.seed(s); np.random.seed(s); torch.manual_seed(s)
    if torch.cuda.is_available(): torch.cuda.manual_seed_all(s)


# ---------------- 文字整理：模型自带的数字转换在 Windows 上常常装不上，这里先把常见的阿拉伯数字念法转好 ----------------
DIG = "零一二三四五六七八九"


def num_cn(s):
    """整数 → 中文读法（四位以内按“几千几百几十几”，更长的逐位念）"""
    s = s.lstrip("0") or "0"
    if len(s) > 4: return "".join(DIG[int(c)] for c in s)
    n = int(s)
    if n == 0: return "零"
    out, zero = "", False
    units = ["", "十", "百", "千"]; ds = [int(c) for c in s]; L = len(ds)
    for i, d in enumerate(ds):
        u = units[L - 1 - i]
        if d == 0: zero = True; continue
        if zero and out: out += "零"
        zero = False; out += DIG[d] + u
    if out.startswith("一十"): out = out[1:]
    return out


def norm_text(t):
    t = t.strip()
    t = re.sub(r"(\d+)\s*%", lambda m: "百分之" + num_cn(m.group(1)), t)
    t = re.sub(r"(\d{4})年", lambda m: "".join(DIG[int(c)] for c in m.group(1)) + "年", t)     # 1979年 → 一九七九年
    t = re.sub(r"(\d+)\.(\d+)", lambda m: num_cn(m.group(1)) + "点" + "".join(DIG[int(c)] for c in m.group(2)), t)
    t = re.sub(r"\d+", lambda m: num_cn(m.group(0)), t)
    t = re.sub(r"[…]+|\.{3,}", "，", t)                     # 省略号念成一个停顿
    t = re.sub(r"[—─]{1,}", "，", t)
    t = re.sub(r"[《》【】\[\]（）()]", "", t)
    return t


# ---------------- 录完的声音：剪头尾空白、统一响度 ----------------
def tidy(sr, wav, target_db=-20.0, lead=0.08, tail=0.18):
    import numpy as np
    w = np.asarray(wav, dtype="float32").reshape(-1)
    if not len(w): return w
    hop = max(1, int(0.01 * sr)); n = len(w) // hop
    if n < 3: return w
    fr = w[: n * hop].reshape(n, hop); db = 10 * np.log10((fr ** 2).mean(axis=1) + 1e-12)
    act = np.where(db > db.max() - 40)[0]
    a, b = max(0, act[0] * hop - int(lead * sr)), min(len(w), (act[-1] + 1) * hop + int(tail * sr))
    w = w[a:b]
    loud = db[act[0]: act[-1] + 1]; loud = loud[loud > db.max() - 30]          # 只按“有声音”的部分算响度
    cur = 10 * np.log10(np.mean(10 ** (loud / 10))) if len(loud) else -20.0
    g = 10 ** ((target_db - cur) / 20); w = w * g
    pk = float(np.abs(w).max()) if len(w) else 0
    if pk > 0.89: w = w * (0.89 / pk)                                         # 防止爆音（约 -1 dB）
    fade = min(len(w) // 4, int(0.01 * sr))
    if fade: w[:fade] *= np.linspace(0, 1, fade); w[-fade:] *= np.linspace(1, 0, fade)
    return np.concatenate([np.zeros(int(lead * sr) // 2, "float32"), w, np.zeros(int(tail * sr) // 2, "float32")])


def to_mp3(sr, w, path, bitrate="48k"):
    import numpy as np, soundfile as sf
    w = np.asarray(w, dtype="float32"); tmp = path + ".part"
    try:
        with sf.SoundFile(tmp, "w", samplerate=int(sr), channels=1, format="MP3") as f: f.write(w)
    except Exception:
        buf = io.BytesIO(); sf.write(buf, w, int(sr), format="WAV", subtype="PCM_16")
        p = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", "pipe:0", "-ac", "1", "-b:a", bitrate, "-f", "mp3", tmp], input=buf.getvalue(), capture_output=True)
        if p.returncode: raise RuntimeError("写 mp3 失败：" + p.stderr.decode("utf-8", "ignore")[-300:])
    os.replace(tmp, path)


# ---------------- 模型 ----------------
class Cosy:
    def __init__(self, repo=zv.COSY_REPO):
        self.repo = repo; os.chdir(repo); sys.path.insert(0, repo); sys.path.insert(0, os.path.join(repo, "third_party", "Matcha-TTS"))
        import torch
        from cosyvoice.cli.cosyvoice import CosyVoice2
        log("加载 CosyVoice 2（%s）…" % ("显卡" if torch.cuda.is_available() else "CPU，会比较慢"))
        self.cv = CosyVoice2(os.path.join(repo, "pretrained_models", "CosyVoice2-0.5B"), load_jit=False, load_trt=False, fp16=False)
        self.sr = self.cv.sample_rate; self.spk = {}
        import inspect                                          # 新版 CosyVoice 要的是录音文件路径，旧版要 16k 的声音数据
        try: self.by_path = "load_wav" in inspect.getsource(self.cv.frontend._extract_speech_feat)
        except Exception: self.by_path = False

    def _wav(self, path):
        if self.by_path: return path
        from cosyvoice.utils.file_utils import load_wav
        return load_wav(path, 16000)

    def _prompt(self, k):
        if k in self.spk: return self.spk[k]
        wav, txt = zv.ref_of(k, self.repo); log("声音 %s 的参考录音：%s「%s」" % (k, wav, txt))
        p = {"text": txt, "path": wav, "id": None}
        try:                                                    # 新版可以把参考录音先算好存起来，每句不用重算
            if self.cv.add_zero_shot_spk(txt, self._wav(wav), "miao_" + k): p["id"] = "miao_" + k
        except Exception as e: log("参考录音没能先算好（%s），每句现算" % e)
        self.spk[k] = p; return p

    def synth(self, k, text):
        import numpy as np
        p = self._prompt(k)
        if p["id"]: gen = self.cv.inference_zero_shot(text, "", "", zero_shot_spk_id=p["id"], stream=False)
        else: gen = self.cv.inference_zero_shot(text, p["text"], self._wav(p["path"]), stream=False)
        return np.concatenate([np.asarray(j["tts_speech"]).reshape(-1) for j in gen])


class ChatTTSEngine:
    def __init__(self):
        import ChatTTS, torch
        log("加载 ChatTTS（%s）…" % ("显卡" if torch.cuda.is_available() else "CPU"))
        self.ChatTTS = ChatTTS; self.chat = ChatTTS.Chat(); self.sr = 24000; self.spk = {}
        # 试听时模型下到了 huggingface 缓存里；默认的 local 是在当前文件夹找，找不到会去下载（Windows 上常失败）
        if not any(self.chat.load(compile=False, source=s) for s in ("huggingface", "local")):
            raise RuntimeError("ChatTTS 模型加载失败（huggingface 缓存和当前文件夹 asset 里都没有）")

    def synth(self, k, text):
        import numpy as np, torch
        seed = zv.VOICES[k].get("seed", 4099)
        if k not in self.spk: torch.manual_seed(seed); self.spk[k] = self.chat.sample_random_speaker()
        code = self.ChatTTS.Chat.InferCodeParams(spk_emb=self.spk[k], temperature=0.3, top_P=0.7, top_K=20)
        return np.asarray(self.chat.infer([text], skip_refine_text=True, params_infer_code=code)[0]).reshape(-1)


def make(engine): return Cosy() if engine == "cosy" else ChatTTSEngine()


def do(model, k, text, path, bitrate):
    seed_all(SEED)
    w = model.synth(k, norm_text(text))
    if len(w) < model.sr * 0.2: raise RuntimeError("录出来太短")
    to_mp3(model.sr, tidy(model.sr, w), path, bitrate)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["cosy", "chattts"]); ap.add_argument("--bitrate", default="48k")
    ap.add_argument("--test", nargs=2, metavar=("声音", "句子"))
    a = ap.parse_args()
    if a.test:
        k, t = a.test; m = make(zv.VOICES[k]["engine"]); out = os.path.join(HERE, "test-%s.mp3" % k); t0 = time.time()
        do(m, k, t, out, a.bitrate); print("已写：%s（%.1f 秒）" % (out, time.time() - t0)); return
    model = make(a.engine); reply({"ok": True, "ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            job = json.loads(line); errs = []
            for t, p in zip(job["texts"], job["paths"]):
                try: do(model, job["voice"], t, p, a.bitrate)
                except Exception as e: errs.append("%s：%s" % (t[:12], e)); log("这一句没录成（%s）：%s" % (e, t[:20]))
            reply({"ok": True, "errs": errs})
        except Exception as e:
            reply({"err": str(e)})


if __name__ == "__main__": main()
