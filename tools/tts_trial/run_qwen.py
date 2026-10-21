"""试听：用你现在的 Qwen3-TTS 念同一段中文，当作对照（英文不录了）。
运行（用现成的环境）：conda activate qwen3-tts && python run_qwen.py   （默认福伯 Uncle_Fu）
"""
import os, sys
import common

sys.path.insert(0, os.path.dirname(common.HERE))
import qwen_batch as q

def main():
    speakers = sys.argv[1:] or ["Uncle_Fu"]
    model = q.load_model(q.default_model())
    for sp in speakers:
        def synth(text, kind, sp=sp):
            return q.synth_batch(model, [text], sp, "Chinese", q.DEFAULT_INSTRUCT)[0]
        common.run("qwen-" + sp, common.jobs(("zh",)), synth)

if __name__ == "__main__": main()
