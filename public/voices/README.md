# KuCards voice clips

Drop recorded English voice clips here as WAV (16-bit mono). Each callout plays its file when it exists; otherwise the
device's speech voice is used as a fallback. File names are the phrase in lower case with dashes:

| Phrase | File |
| --- | --- |
| Draw two! | `draw-two.wav` |
| Draw four! | `draw-four.wav` |
| Draw six! | `draw-six.wav` |
| Draw cards! | `draw-cards.wav` (any other total: 3, 5, 7 and more) |
| Skip! | `skip.wav` |
| Reverse! | `reverse.wav` |
| Red! | `red.wav` |
| Blue! | `blue.wav` |
| Yellow! | `yellow.wav` |
| Green! | `green.wav` |

Keep clips short (under ~1 s) and small (mono, trimmed).

Current clips: recorded by the project owner, then processed locally by `tools/voices/process_voices.py`: DeepFilterNet 0.5.6 noise removal (`deep-filter -D --pf`), Praat "Change gender" via parselmouth (formant shift ratio 1.16, pitch median 120 → 200 Hz, range factor 1.05), tight per-clip trims with short fades, light EQ and compression, and equal loudness at −15 LUFS with a −1 dBFS ceiling (48 kHz, 16-bit mono). The script also rebuilds `voices-preview.wav`. To redo them from a new recording, adjust `SPANS` in the script and run it (setup is in its docstring).
