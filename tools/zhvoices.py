"""喵喵录音机的“稳定声音”（不是 Qwen 的那几个）：每个声音用哪个模型、在哪个环境里跑、参考录音是哪段。

手机上显示的名字在 zhreader/index.html 的 LB_VOICES 里，编号要和这里一致（只能是小写字母、数字、下划线；
组合声音“旁白_x_对话”整个不能超过 24 个字，所以编号尽量短）。

- CosyVoice 2：模仿一段参考录音（零样本克隆）。同一个参考录音 + 每句固定随机种子 → 每句都是同一个人、同一种念法。
  参考录音放在 tools/voices/<编号>.wav，旁边 <编号>.txt 是这段录音念的字（要一字不差）。
  cv_nv 没放文件时用 CosyVoice 自带的 asset/zero_shot_prompt.wav（试听时你喜欢的那个女声）。
- ChatTTS：随机种子决定是哪个人（4099 是试听时你喜欢的那个）。
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE_DIR = os.path.join(HERE, "voices")

VOICES = {
    "cv_nv": {"engine": "cosy", "name": "晓雅", "desc": "女声·稳", "builtin": ("asset/zero_shot_prompt.wav", "希望你以后能够做的比我还好呦。")},
    "cv_fu": {"engine": "cosy", "name": "福伯·稳", "desc": "男声·稳"},       # 参考录音用 make_voice_ref.py 从福伯录过的句子里挑
    "ct_4099": {"engine": "chattts", "name": "阿七", "desc": "ChatTTS", "seed": 4099},
}

# 每个模型用哪个 conda 环境（试听时建好的），可以用环境变量 MIAO_ENV_COSY / MIAO_ENV_CHATTTS 改
ENGINES = {
    "cosy": {"env": os.environ.get("MIAO_ENV_COSY", "tts-cosy")},
    "chattts": {"env": os.environ.get("MIAO_ENV_CHATTTS", "tts-chattts")},
}
COSY_REPO = os.environ.get("MIAO_COSY_REPO", r"C:\ai\CosyVoice")


def is_stable(k): return k in VOICES


def ref_of(k, repo=COSY_REPO):
    """CosyVoice 声音的参考录音 → (wav 路径, 录音里念的字)；没有就报错说明怎么做"""
    v = VOICES[k]; wav, txt = os.path.join(VOICE_DIR, k + ".wav"), os.path.join(VOICE_DIR, k + ".txt")
    if os.path.exists(wav) and os.path.exists(txt):
        return wav, open(txt, encoding="utf-8").read().strip()
    if v.get("builtin"):
        return os.path.join(repo, v["builtin"][0]), v["builtin"][1]
    raise RuntimeError("声音 %s 还没有参考录音：先运行 python make_voice_ref.py %s" % (k, k))
