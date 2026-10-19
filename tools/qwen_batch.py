#!/usr/bin/env python3
"""喵喵听书：用本机的 Qwen3-TTS 把「句子清单」一句一句录成 mp3。

用法（在装了 Qwen3-TTS 的 conda 环境 qwen3-tts 里运行）：
    conda activate qwen3-tts
    python qwen_batch.py sentences.txt  语音输出文件夹  [--speaker Vivian]

sentences.txt 来自喵喵听书“上传到书库”页面里的「下载句子清单」，每行：序号<TAB>句子。
输出：语音输出文件夹/00001.mp3、00002.mp3 …（文件名 = 序号）。
可以随时中断，再运行会自动跳过已经录好的句子。
录完后回到喵喵听书的上传页，选这个文件夹，点“一键上传”。

需要：pip install soundfile numpy ；系统里有 ffmpeg（命令行能运行 ffmpeg）。
"""
import argparse, io, os, subprocess, sys, time

def load_model(model_name):
    import torch
    from qwen_tts import Qwen3TTSModel          # 和 batch_read.py 同一个调用方式
    return Qwen3TTSModel.from_pretrained(model_name, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")

DEFAULT_INSTRUCT = "请用标准普通话朗读，发音清晰自然，不要带任何方言或地方口音。"
def synth_batch(model, texts, speaker, language, instruct=None, temperature=None):
    """一次录好几句（比一句一句快得多）。instruct 是“朗读要求”，用来压住方言口音；返回 [(采样率, numpy 波形), ...]"""
    n = len(texts); kw = dict(text=list(texts), language=[language] * n, speaker=[speaker] * n)
    if instruct: kw["instruct"] = [instruct] * n
    if temperature: kw["temperature"] = float(temperature)
    try:
        wavs, sr = model.generate_custom_voice(**kw)
    except TypeError as e:                              # 这个版本不认某个参数：去掉再试，并提示一次
        for k in ("instruct", "temperature"):
            if k in kw and k in str(e): kw.pop(k); print("（这个版本的模型不支持 %s，已忽略）" % k, flush=True)
        if not any(k in str(e) for k in ("instruct", "temperature")): raise
        wavs, sr = model.generate_custom_voice(**kw)
    return [(sr, w) for w in wavs]

def synth(model, text, speaker, language):
    return synth_batch(model, [text], speaker, language)[0]

def to_mp3(sr, wav, path, bitrate="48k"):
    """优先用 soundfile 直接写 mp3（和 batch_read.py 一样，不需要 ffmpeg）；写不了再用 ffmpeg。"""
    import numpy as np, soundfile as sf
    w = np.asarray(wav, dtype="float32")
    try:
        with sf.SoundFile(path, "w", samplerate=int(sr), channels=1, format="MP3") as f: f.write(w)
        return
    except Exception:
        pass
    buf = io.BytesIO(); sf.write(buf, w, sr, format="WAV", subtype="PCM_16")
    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", "pipe:0", "-ac", "1", "-b:a", bitrate, path], input=buf.getvalue(), capture_output=True)
    if p.returncode: raise RuntimeError(p.stderr.decode("utf-8", "ignore"))

DEFAULT_LOCAL = r"C:\ai\models\Qwen3-TTS-12Hz-1.7B-CustomVoice"
def default_model(): return DEFAULT_LOCAL if os.path.isdir(DEFAULT_LOCAL) else "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sentences"); ap.add_argument("outdir")
    ap.add_argument("--model", default=default_model())
    ap.add_argument("--speaker", default="Serena"); ap.add_argument("--language", default="Chinese")
    ap.add_argument("--bitrate", default="48k")
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    rows = []
    for line in open(a.sentences, encoding="utf-8"):
        if "\t" in line:
            k, t = line.rstrip("\n").split("\t", 1)
            if k.strip().isdigit() and t.strip(): rows.append((k.strip(), t.strip()))
    todo = [(k, t) for k, t in rows if not os.path.exists(os.path.join(a.outdir, k + ".mp3"))]
    print(f"共 {len(rows)} 句，已录 {len(rows)-len(todo)} 句，还要录 {len(todo)} 句", flush=True)
    if not todo: return
    model = load_model(a.model); t0 = time.time()
    for n, (k, t) in enumerate(todo, 1):
        try:
            sr, wav = synth(model, t, a.speaker, a.language)
            to_mp3(sr, wav, os.path.join(a.outdir, k + ".mp3"), a.bitrate)
        except KeyboardInterrupt: print("已停止，下次运行会接着录"); sys.exit(0)
        except Exception as e: print(f"第 {k} 句失败：{e}", flush=True); continue
        if n % 20 == 0 or n == len(todo):
            el = time.time() - t0; print(f"{n}/{len(todo)}  已用 {el/60:.1f} 分钟，预计还要 {el/n*(len(todo)-n)/60:.1f} 分钟", flush=True)

if __name__ == "__main__": main()
