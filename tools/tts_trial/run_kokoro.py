"""试听：Kokoro-82M（英文）。
安装（新建一个环境，不碰 qwen3-tts）：
    conda create -n tts-kokoro python=3.11 -y && conda activate tts-kokoro
    pip install "kokoro>=0.9.4" soundfile
运行：python run_kokoro.py            （默认两个声音：af_heart 美音女声、am_michael 美音男声）
      python run_kokoro.py bf_emma bm_george   （换英音女声、男声）
加 --zh 顺便试中文（要先 pip install "misaki[zh]"，声音 zf_xiaobei）。
"""
import sys
import numpy as np
import common

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    voices = args or ["af_heart", "am_michael"]
    from kokoro import KPipeline
    pipes = {}
    def pipe(lang):
        if lang not in pipes: pipes[lang] = KPipeline(lang_code=lang)
        return pipes[lang]
    for v in voices:
        lang = v[0]                                     # 声音名第一个字母就是口音：a 美音、b 英音
        def synth(text, kind, v=v, lang=lang):
            parts = [np.asarray(a) for _, _, a in pipe(lang)(text, voice=v, speed=1)]
            return 24000, np.concatenate(parts)
        common.run("kokoro-" + v, common.jobs(("en", "words")), synth)
    if "--zh" in sys.argv:
        def synth_zh(text, kind):
            parts = [np.asarray(a) for _, _, a in pipe("z")(text, voice="zf_xiaobei", speed=1)]
            return 24000, np.concatenate(parts)
        common.run("kokoro-zf_xiaobei", common.jobs(("zh",)), synth_zh)

if __name__ == "__main__": main()
