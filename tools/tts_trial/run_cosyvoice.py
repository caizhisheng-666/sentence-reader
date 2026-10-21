"""试听：CosyVoice 2（中英文）。它没有固定的“声音列表”，而是模仿一段参考录音的声音（零样本克隆）。
安装（照官方说明，新建一个环境；Windows 上 pynini 要用 conda 装）：
    git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git C:\\ai\\CosyVoice
    conda create -n tts-cosy python=3.10 -y && conda activate tts-cosy
    conda install -y -c conda-forge pynini==2.1.5
    cd C:\\ai\\CosyVoice && pip install -r requirements.txt
    python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice2-0.5B', local_dir='pretrained_models/CosyVoice2-0.5B')"
运行：python run_cosyvoice.py --repo C:\\ai\\CosyVoice

参考录音：
- 中文：用 CosyVoice 自带的 asset/zero_shot_prompt.wav（一个女声）。
- 英文：如果已经先跑过 run_kokoro.py，就拿 Kokoro af_heart 念的第 2 句当参考，这样两个模型是“同一个人”，好比较；
        没跑过就用中文参考录音跨语种念英文。
"""
import os, sys
import numpy as np
import common

ZH_PROMPT_TEXT = "希望你以后能够做的比我还好呦。"

def main():
    repo = sys.argv[sys.argv.index("--repo") + 1] if "--repo" in sys.argv else r"C:\ai\CosyVoice"
    os.chdir(repo); sys.path.insert(0, repo); sys.path.insert(0, os.path.join(repo, "third_party", "Matcha-TTS"))
    from cosyvoice.cli.cosyvoice import CosyVoice2
    from cosyvoice.utils.file_utils import load_wav
    cv = CosyVoice2(os.path.join(repo, "pretrained_models", "CosyVoice2-0.5B"), load_jit=False, load_trt=False, fp16=False)

    def wav_of(gen):
        return cv.sample_rate, np.concatenate([np.asarray(j["tts_speech"]).reshape(-1) for j in gen])

    def zero_shot(text, prompt_text, prompt_path):
        try: return wav_of(cv.inference_zero_shot(text, prompt_text, load_wav(prompt_path, 16000), stream=False))
        except (TypeError, AttributeError): return wav_of(cv.inference_zero_shot(text, prompt_text, prompt_path, stream=False))   # 新版直接收文件路径

    def cross(text, prompt_path):
        try: return wav_of(cv.inference_cross_lingual(text, load_wav(prompt_path, 16000), stream=False))
        except (TypeError, AttributeError): return wav_of(cv.inference_cross_lingual(text, prompt_path, stream=False))

    zh_prompt = os.path.join(repo, "asset", "zero_shot_prompt.wav")
    s = common.load(); ref = os.path.join(common.OUT, "kokoro-af_heart", "en02.wav")
    if os.path.exists(ref):
        print("英文参考录音：Kokoro af_heart 第 2 句", flush=True)
        common.run("cosyvoice-像kokoro女声", common.jobs(("en", "words")), lambda t, k: zero_shot(t, s["en"][1], ref))
    else:
        print("没找到 Kokoro 的录音，英文改用中文参考录音跨语种念", flush=True)
        common.run("cosyvoice-跨语种女声", common.jobs(("en", "words")), lambda t, k: cross(t, zh_prompt))
    common.run("cosyvoice-中文女声", common.jobs(("zh",)), lambda t, k: zero_shot(t, ZH_PROMPT_TEXT, zh_prompt))

if __name__ == "__main__": main()
