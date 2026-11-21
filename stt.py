# Speech to text for voice notes from the phone. Runs on the PC only (faster-whisper, offline, CPU).
# Usage: stt.py <audio file>   -> prints JSON {"text": ..., "lang": ...}
import json, os, sys
from faster_whisper import WhisperModel
HINTS = ("Claude, GitHub, tmux, commit, push. " + os.environ.get("STT_HINTS", "")).strip()
model = WhisperModel(os.environ.get("STT_MODEL", "small"), device="cpu", compute_type="int8", local_files_only=True)
segs, info = model.transcribe(sys.argv[1], vad_filter=True, beam_size=5,
                              initial_prompt=HINTS)
text = " ".join(s.text.strip() for s in segs).strip()
print(json.dumps({"text": text, "lang": info.language, "p": round(info.language_probability, 2)}, ensure_ascii=False))
