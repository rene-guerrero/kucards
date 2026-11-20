r"""Turn one raw voice recording into the ten KuCards voice clips (female voice).

Chain: ffmpeg decode -> DeepFilterNet denoise -> Praat "Change gender"
(formant-aware pitch shift) -> per-clip trim/fade/EQ -> equal loudness (-15 LUFS).

Setup (all on D:):
  D:\tools\deepfilter\deep-filter.exe   (github.com/Rikorose/DeepFilterNet releases, v0.5.6)
  python -m venv D:\tools\kuvoice-venv
  D:\tools\kuvoice-venv\Scripts\python -m pip install --cache-dir D:\cache\pip praat-parselmouth numpy soundfile pyloudnorm
Run:
  D:\tools\kuvoice-venv\Scripts\python tools\voices\process_voices.py <recording> [workdir]
Edit SPANS below for a new recording (ffmpeg -af silencedetect=n=-35dB:d=0.25 helps).
"""
import subprocess, sys, os, shutil, tempfile
import numpy as np, soundfile as sf, pyloudnorm as pyln, parselmouth
from parselmouth.praat import call

FFMPEG = r"D:\Databank\ffmpeg\bin\ffmpeg.exe"
DEEPFILTER = r"D:\tools\deepfilter\deep-filter.exe"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "voices")
PREVIEW = os.path.join(ROOT, "voices-preview.wav")

# clip -> (start, end) seconds of speech in the source; listed in preview order
SPANS = [
    ("draw-two", 0.44, 1.18), ("draw-four", 2.19, 3.02), ("draw-six", 4.06, 5.10),
    ("draw-cards", 6.06, 7.18), ("skip", 8.39, 9.27), ("reverse", 10.42, 11.41),
    ("red", 13.04, 13.35), ("blue", 14.69, 15.52),
    ("yellow", 18.24, 18.66), ("green", 16.48, 16.91),  # spoken green-then-yellow
]
SR = 48000
PRE, POST = 0.04, 0.09          # padding around each span (s)
FADE_IN, FADE_OUT = 0.008, 0.05
FORMANT_RATIO = 1.16            # Praat Change gender: formant shift ratio
PITCH_MEDIAN = 200.0            # new pitch median (Hz)
PITCH_RANGE = 1.05              # pitch range factor
TARGET_LUFS, PEAK = -15.0, 0.89 # -1 dBFS ceiling

def run(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def median_f0(snd):
    p = snd.to_pitch_ac(time_step=0.005, pitch_floor=70, pitch_ceiling=500)
    f = p.selected_array["frequency"]; f = f[f > 0]
    return float(np.median(f)) if len(f) else 0.0

def gap_floor_db(x):
    """RMS (dBFS) over the silence gaps between the phrases."""
    ts = sorted((a, b) for _, a, b in SPANS)
    segs = [x[int((ts[i][1] + 0.15) * SR):int((ts[i + 1][0] - 0.15) * SR)] for i in range(len(ts) - 1)]
    g = np.concatenate(segs)
    return 20 * np.log10(np.sqrt(np.mean(g ** 2)) + 1e-12)

def lufs(x):
    meter = pyln.Meter(SR)
    return meter.integrated_loudness(np.tile(x, int(np.ceil(3.0 * SR / len(x))) + 1))  # loop short clips

def main():
    src = sys.argv[1]
    work = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="kuvoice")
    os.makedirs(work, exist_ok=True)
    raw = os.path.join(work, "raw.wav")
    run(FFMPEG, "-y", "-i", src, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", raw)
    dfdir = os.path.join(work, "df")
    run(DEEPFILTER, "-D", "--pf", "-o", dfdir, raw)
    clean = os.path.join(dfdir, "raw.wav")

    x_raw, _ = sf.read(raw); x_clean, _ = sf.read(clean)
    print(f"noise floor (gaps): raw {gap_floor_db(x_raw):.1f} dBFS -> denoised {gap_floor_db(x_clean):.1f} dBFS")

    snd = parselmouth.Sound(clean)
    f0_in = median_f0(snd)
    fem = call(snd, "Change gender", 70, 500, FORMANT_RATIO, PITCH_MEDIAN, PITCH_RANGE, 1.0)
    print(f"pitch median: {f0_in:.0f} Hz -> {median_f0(fem):.0f} Hz")
    y = fem.values[0]
    n = min(len(y), len(x_clean))
    femwav = os.path.join(work, "female.wav"); sf.write(femwav, y[:n], SR, subtype="FLOAT")

    eq = ("highpass=f=110,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1.2:g=2.5,"
          "highshelf=f=8000:g=2,acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=2")
    clips = {}
    for name, a, b in SPANS:
        s, d = max(0, a - PRE), (b + POST) - max(0, a - PRE)
        tmp = os.path.join(work, name + ".wav")
        run(FFMPEG, "-y", "-ss", f"{s:.3f}", "-t", f"{d:.3f}", "-i", femwav, "-af",
            f"{eq},afade=t=in:d={FADE_IN},afade=t=out:st={d - FADE_OUT:.3f}:d={FADE_OUT}",
            "-c:a", "pcm_f32le", tmp)
        c, _ = sf.read(tmp)
        c = c * 10 ** ((TARGET_LUFS - lufs(c)) / 20)
        over = np.abs(c) > PEAK * 0.8          # soft-knee limiter for the few peaks above the ceiling
        k = PEAK * 0.8
        c[over] = np.sign(c[over]) * (k + (PEAK - k) * np.tanh((np.abs(c[over]) - k) / (PEAK - k)))
        clips[name] = c
        sf.write(os.path.join(OUT, name + ".wav"), c, SR, subtype="PCM_16")
        print(f"{name:11s} {len(c)/SR:.2f}s  {lufs(c):6.1f} LUFS  peak {20*np.log10(np.abs(c).max()):5.1f} dBFS")
    gap = np.zeros(SR // 2)
    parts = []
    for name, _, _ in SPANS:
        parts += [clips[name], gap]
    sf.write(PREVIEW, np.concatenate(parts[:-1]), SR, subtype="PCM_16")

if __name__ == "__main__":
    main()
