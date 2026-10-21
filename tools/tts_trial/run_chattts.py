"""试听：ChatTTS（中英文）。
安装（新建一个环境）：
    conda create -n tts-chattts python=3.11 -y && conda activate tts-chattts
    pip install ChatTTS soundfile
    （第一次运行会自动下载模型，约 1GB）
运行：python run_chattts.py              （默认用随机种子 2222、4099 各挑一个说话人）
      python run_chattts.py 1234         （换一个种子＝换一个人）

为了尽量稳：说话人固定（同一个种子每次是同一个人），temperature 调低到 0.3，
并且关掉“润色文字”（不然它会往句子里加“嗯”“那个”之类的词，单词也会被改掉）。
"""
import sys
import numpy as np
import common

def main():
    seeds = [int(a) for a in sys.argv[1:] if a.isdigit()] or [2222, 4099]
    import torch, ChatTTS
    chat = ChatTTS.Chat(); chat.load(compile=False)
    for seed in seeds:
        torch.manual_seed(seed); spk = chat.sample_random_speaker()
        code = ChatTTS.Chat.InferCodeParams(spk_emb=spk, temperature=0.3, top_P=0.7, top_K=20)
        def synth(text, kind):
            w = chat.infer([text], skip_refine_text=True, params_infer_code=code)[0]
            return 24000, np.asarray(w).reshape(-1)
        common.run("chattts-%d" % seed, common.jobs(), synth)

if __name__ == "__main__": main()
