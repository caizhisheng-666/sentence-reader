# 声音试听：Kokoro / CosyVoice 2 / ChatTTS（Qwen 只当中文对照）

所有模型念同一份文字（`samples.json`），录完排成一张网页对比，网页上还有“稳不稳”的数字。

- 英文：连续 20 句的小故事（看句子之间起伏大不大）+ 50 个单词（看单独念一个词准不准）
- 中文：10 句（前 4 句是鲁迅《故乡》开头，后 6 句是另写的对话）
- 一部分句子和单词会念 3 遍，看同一句每次念得是不是一样

## 每个模型一个环境（互不影响，也不碰正在用的 qwen3-tts）

| 模型 | 环境 | 安装 | 运行 |
| --- | --- | --- | --- |
| Kokoro | tts-kokoro | `conda create -n tts-kokoro python=3.11 -y`，`pip install "kokoro>=0.9.4" soundfile` | `python run_kokoro.py` |
| ChatTTS | tts-chattts | `conda create -n tts-chattts python=3.11 -y`，`pip install ChatTTS soundfile` | `python run_chattts.py` |
| CosyVoice 2 | tts-cosy | 见 `run_cosyvoice.py` 开头（要 clone 官方仓库、conda 装 pynini、下模型） | `python run_cosyvoice.py --repo C:\ai\CosyVoice` |
| Qwen（对照） | qwen3-tts（已有） | 不用装 | `python run_qwen.py` |

GPU 上要用 PyTorch 的 CUDA 版；pip 装出来如果是 CPU 版，按 pytorch.org 的命令重装 torch。

**顺序：先跑 Kokoro**，CosyVoice 会拿 Kokoro 的录音当英文参考声音，这样两个模型是“同一个人”，好比较。

最后在任意一个环境里运行 `python make_page.py`，打开 `试听\试听.html` 听。

正在录书的喵喵录音机会占显卡。显存不够时先关掉它，试听完再打开，录好的不会丢。
