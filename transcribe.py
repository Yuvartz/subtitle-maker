import sys
import os
import io
import json
import subprocess
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# Patch torchaudio.save to use soundfile instead of torchcodec
# (torchcodec DLL fails to load on some Windows setups)
try:
    import soundfile as sf
    import torchaudio
    _original_save = torchaudio.save
    def _patched_save(uri, src, sample_rate, **kwargs):
        try:
            return _original_save(uri, src, sample_rate, **kwargs)
        except (ImportError, OSError):
            # Fallback: use soundfile
            import torch
            data = src.cpu()
            if data.dim() == 2:
                data = data.t()  # (channels, samples) -> (samples, channels)
            sf.write(str(uri), data.numpy(), sample_rate)
    torchaudio.save = _patched_save
except ImportError:
    pass

import whisper

def extract_audio(input_path, output_path):
    subprocess.run([
        "ffmpeg", "-y", "-i", input_path,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        output_path
    ], check=True, capture_output=True)

def isolate_vocals(input_path, output_dir):
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    import torch
    import torchaudio

    model = get_model("htdemucs")
    model.eval()

    wav, sr = torchaudio.load(input_path)
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)  # mono -> stereo for demucs
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()
    sources = apply_model(model, wav[None], device="cpu")[0]
    sources = sources * ref.std() + ref.mean()

    # Find vocals index
    vocals_idx = model.sources.index("vocals")
    vocals = sources[vocals_idx]

    name = os.path.splitext(os.path.basename(input_path))[0]
    out_dir = os.path.join(output_dir, "htdemucs", name)
    os.makedirs(out_dir, exist_ok=True)
    vocals_path = os.path.join(out_dir, "vocals.wav")
    torchaudio.save(vocals_path, vocals, sr)
    return vocals_path

def transcribe(audio_path, language="he"):
    model = whisper.load_model("base")
    result = model.transcribe(audio_path, language=language, word_timestamps=True)
    return result

def to_srt(segments):
    lines = []
    for i, seg in enumerate(segments, 1):
        start = format_time(seg["start"])
        end = format_time(seg["end"])
        text = seg["text"].strip()
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)

def format_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python transcribe.py <file> [--isolate] [--language he]"}))
        sys.exit(1)

    input_path = sys.argv[1]
    isolate = "--isolate" in sys.argv
    language = "he"

    if "--language" in sys.argv:
        idx = sys.argv.index("--language")
        if idx + 1 < len(sys.argv):
            language = sys.argv[idx + 1]

    with tempfile.TemporaryDirectory() as tmpdir:
        print(json.dumps({"status": "extracting_audio"}), flush=True)
        audio_wav = os.path.join(tmpdir, "audio.wav")
        extract_audio(input_path, audio_wav)

        if isolate:
            print(json.dumps({"status": "isolating_vocals"}), flush=True)
            vocals_path = isolate_vocals(audio_wav, tmpdir)
            audio_wav = vocals_path

        print(json.dumps({"status": "transcribing"}), flush=True)
        result = transcribe(audio_wav, language)

        segments = []
        for seg in result["segments"]:
            segments.append({
                "start": round(seg["start"], 3),
                "end": round(seg["end"], 3),
                "text": seg["text"].strip()
            })

        srt = to_srt(result["segments"])

        output = {
            "status": "done",
            "segments": segments,
            "srt": srt,
            "language": result.get("language", language)
        }
        print(json.dumps(output, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
