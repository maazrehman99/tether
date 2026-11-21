# Live speech-to-text worker for voice notes. Runs on the PC only (faster-whisper "small", offline, CPU).
# One long-lived process: the model loads once. The server feeds it a growing .webm file while the phone
# is still recording; finished sentences (ending in a pause) are transcribed right away, so when the mic
# stops only the last few seconds are left.
#
# stdin  (one JSON per line): {"id": sid, "path": file, "final": bool}   or {"id": sid, "drop": true}
# stdout (one JSON per line): {"id": sid, "text": full_text_so_far, "final": bool, "lang": ..}  or {"id", "err"}
import json, os, sys, time, traceback
import numpy as np
from faster_whisper import WhisperModel, decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

SR = 16000
# Words the recogniser should expect. Add your own project names with "voice.hints" in config.json.
PROMPT = ("Claude, GitHub, tmux, commit, push. " + os.environ.get("STT_HINTS", "")).strip()
MIN_PIECE = 5.0     # transcribe a finished piece once it has at least this much audio (each call has a fixed ~1.5s cost)
FORCE_PIECE = 20.0  # no pause for this long: cut at the best gap anyway
GAP = 0.5           # a pause this long ends a sentence
TAIL_GUARD = 0.6    # never cut inside the last 0.6s (the speaker may still be mid-word)

model = WhisperModel(os.environ.get("STT_MODEL", "small"), device="cpu", compute_type="int8", cpu_threads=8, local_files_only=True)
sessions = {}       # sid -> {"done": samples already transcribed, "lang": str|None, "parts": [str], "t": last use}


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load(path):
    # The file is a webm that is still growing; the last cluster may be cut short. Decode what is readable.
    try:
        return decode_audio(path, sampling_rate=SR)
    except Exception:
        return np.zeros(0, dtype=np.float32)


def run(st, audio):
    if len(audio) < SR * 0.3:
        return ""
    prompt = PROMPT + (" " + " ".join(st["parts"])[-200:] if st["parts"] else "")
    segs, info = model.transcribe(audio, language=st["lang"], beam_size=5, vad_filter=False,
                                  without_timestamps=True, condition_on_previous_text=False, initial_prompt=prompt)
    text = " ".join(s.text.strip() for s in segs).strip()
    if st["lang"] is None and text:
        st["lang"] = info.language          # detect once per note, reuse for the rest (saves ~1.7s per piece)
    return text


def speech_cut(audio, done):
    """Where to cut the not-yet-transcribed audio: the end of the last sentence followed by a pause."""
    rest = audio[done:]
    dur = len(rest) / SR
    if dur < MIN_PIECE:
        return None
    chunks = get_speech_timestamps(rest, VadOptions(min_silence_duration_ms=int(GAP * 1000), speech_pad_ms=150))
    if not chunks:
        # nothing but silence so far: skip it, but keep the last second in case speech is starting
        return ("skip", max(0, len(rest) - SR))
    limit = len(rest) - int(TAIL_GUARD * SR)
    best = None
    for i, c in enumerate(chunks):
        nxt = chunks[i + 1]["start"] if i + 1 < len(chunks) else len(rest)
        if c["end"] <= limit and (nxt - c["end"]) >= GAP * SR and c["end"] >= MIN_PIECE * SR:
            best = (c["end"] + nxt) // 2          # cut in the middle of the pause
    if best is None and dur >= FORCE_PIECE:
        gaps = [((chunks[i + 1]["start"] - c["end"]), (c["end"] + chunks[i + 1]["start"]) // 2)
                for i, c in enumerate(chunks[:-1]) if c["end"] <= limit]
        best = max(gaps)[1] if gaps else limit
    return ("cut", best) if best else None


def handle(msg):
    sid = msg["id"]
    if msg.get("drop"):
        sessions.pop(sid, None)
        return
    st = sessions.setdefault(sid, {"done": 0, "lang": None, "parts": [], "t": time.time()})
    st["t"] = time.time()
    audio = load(msg["path"])
    if msg.get("final"):
        tail = run(st, audio[st["done"]:])
        if tail:
            st["parts"].append(tail)
        sessions.pop(sid, None)
        out({"id": sid, "text": " ".join(st["parts"]).strip(), "final": True, "lang": st["lang"]})
        return
    cut = speech_cut(audio, st["done"])
    if cut and cut[0] == "skip":
        st["done"] += cut[1]
    elif cut:
        piece = run(st, audio[st["done"]:st["done"] + cut[1]])
        if piece:
            st["parts"].append(piece)
        st["done"] += cut[1]
    out({"id": sid, "text": " ".join(st["parts"]).strip(), "final": False, "lang": st["lang"]})


out({"ready": True})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
        handle(msg)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        out({"id": (msg or {}).get("id") if isinstance(locals().get("msg"), dict) else None, "err": str(e)[:200]})
    # forget sessions the phone abandoned (no final within 10 minutes)
    now = time.time()
    for k in [k for k, v in sessions.items() if now - v["t"] > 600]:
        sessions.pop(k, None)
