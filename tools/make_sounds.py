#!/usr/bin/env python3
"""Synthesises Festoon's two small sounds into extension/assets/sounds/.

  hung.wav    a wooden clothespin snapping shut on the line
  copied.wav  a soft tick when an item is copied

Plain Python, no dependencies: damped resonances over a burst of noise.
"""
import math
import pathlib
import random
import struct
import wave

RATE = 44100
OUT = pathlib.Path(__file__).resolve().parent.parent / "extension" / "assets" / "sounds"


def write(name, samples, peak=0.32):
    top = max(abs(s) for s in samples) or 1
    data = b"".join(struct.pack("<h", int(s / top * peak * 32767)) for s in samples)
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data)


def click(t0, length, modes, noise=0.6, decay_noise=900, seed=1):
    rnd = random.Random(seed)
    out = []
    for i in range(int(length * RATE)):
        t = i / RATE
        if t < t0:
            out.append(0.0)
            continue
        u = t - t0
        s = noise * rnd.uniform(-1, 1) * math.exp(-u * decay_noise)
        for freq, amp, decay in modes:
            s += amp * math.sin(2 * math.pi * freq * u) * math.exp(-u * decay)
        out.append(s)
    return out


def mix(*tracks):
    n = max(len(t) for t in tracks)
    return [sum(t[i] if i < len(t) else 0 for t in tracks) for i in range(n)]


def fade(samples, ms=4):
    k = int(ms / 1000 * RATE)
    for i in range(k):
        samples[-1 - i] *= i / k
    return samples


# The clothespin: the jaws knock together (bright, short), then the spring settles (a softer knock).
wood = [(1850, 0.9, 120), (2960, 0.55, 160), (4700, 0.25, 260), (820, 0.35, 70)]
hung = mix(click(0.0, 0.16, wood, noise=0.9, seed=3),
           [0.45 * s for s in click(0.038, 0.16, [(f * 1.07, a, d * 1.2) for f, a, d in wood], noise=0.5, seed=7)])
write("hung.wav", fade(hung))

# Copied: a short rising tick.
copied = []
for i in range(int(0.07 * RATE)):
    t = i / RATE
    f = 1500 + 900 * t / 0.07
    copied.append(math.sin(2 * math.pi * f * t) * math.exp(-t * 70) + 0.15 * math.sin(2 * math.pi * 2 * f * t) * math.exp(-t * 110))
write("copied.wav", fade(copied), peak=0.22)
print("sounds written to", OUT)
