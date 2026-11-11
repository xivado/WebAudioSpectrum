# Web Audio Spectrum Analyzer

A real-time audio visualizer built on the Web Audio API: an oscilloscope, a dBFS
frequency spectrum and a time–frequency spectrogram, all rendered on plain
`<canvas>` with no build step and no external dependencies.

**Live demo:** <https://xivado.github.io/WebAudioSpectrum/> — served over HTTPS by
GitHub Pages, so the microphone works on desktop and mobile. Allow microphone
access when the browser asks.

This repository is a cleaned-up fork of
[deftio/WebAudioSpectrum](https://github.com/deftio/WebAudioSpectrum); the
upstream demo still runs the older version. For a primer on time/frequency
domains, FFTs, windowing and common waveforms, see
[AudioSpectra.md](AudioSpectra.md).

## Features

- **Oscilloscope (time domain)** — the microphone waveform with linear, log or
  μ-law companded amplitude mapping, plus a time/sample readout.
- **Frequency spectrum** — 1024 bins from a 2048-point FFT, displayed as bars
  on a linear or logarithmic frequency axis and a 0…−90 dBFS amplitude axis.
- **Spectrogram** — the last 100 spectra as a heatmap. Newest frame at the
  bottom, grid labels derived from the actual frame timestamps.
- **Rectangular or Hamming window**, with coherent-gain compensation so the
  amplitude calibration does not change when you toggle the window.
- **Temporal smoothing** (EMA) that can be switched off to see raw frames.
- **High-DPI rendering** (`devicePixelRatio`, capped at 2), debounced resize and
  orientation changes, and canvases that re-fit themselves.
- **Correct microphone lifecycle** — stopping releases the microphone and closes
  the audio context; a denied permission can be retried without reloading.
- **Accessible controls** — pressed state, focus rings and a live status line.

## Running it locally

The live demo above is the easiest entry point. To run your own copy, serve the
directory over `localhost` (a secure context) — opening the file with `file://`
will not grant microphone access in most browsers.

```bash
cd WebAudioSpectrum
python3 -m http.server 8000    # or: npm run serve
# open http://localhost:8000/
```

On a phone, serve from the same network and open `http://<your-computer-ip>:8000/`
(Chrome treats plain-HTTP LAN origins as insecure, so use the local device or a
tunnel/HTTPS host if microphone access is blocked).

Click **Start Sampling** and allow microphone access. The oscilloscope is hidden
by default; **Show Oscilloscope** adds it above the spectrum.

## Controls

| Button | Behavior |
| --- | --- |
| **Start Sampling / Stop Sampling** | Requests the microphone and starts the render loop; stopping stops the media tracks and closes the `AudioContext`. |
| **Show/Hide Oscilloscope** | Toggles the time-domain panel. |
| **Scope: Linear / Log / Compand** | Amplitude mapping for the oscilloscope. Log and μ-law companding lift quiet signals; full scale stays at ±1. |
| **Scale: Linear / Log** | Frequency axis for both the spectrum and the spectrogram (log is base-10 from 20 Hz to Nyquist). |
| **Window: Rectangular / Hamming** | Analysis window applied before the FFT. Hamming lowers spectral leakage. |
| **Smooth: Off / On** | EMA smoothing of the spectrum over time (α = 0.8). Off shows the raw frame; the rendering style is unchanged. |

## Files

| File | Purpose |
| --- | --- |
| [index.html](index.html) | Page structure, controls, three canvases. |
| [styles.css](styles.css) | Layout, light/dark theme, responsive canvas sizes. |
| [spectrum-dsp.js](spectrum-dsp.js) | Pure DSP: radix-2 FFT, Hamming window, dBFS mapping, frame ring buffer, axis math. No DOM. |
| [audioSpectrum.js](audioSpectrum.js) | Microphone lifecycle, render loop, canvas layout and drawing. |
| [AudioSpectra.md](AudioSpectra.md) | Background reading: FFTs, windows, harmonics. |
| [tests/](tests/) | Node tests for the DSP math and a fake-DOM smoke test of the UI. |
| [dev/original-web-audio-spectrum.html](dev/original-web-audio-spectrum.html) | Early prototype kept for reference. |
| [singlepage.html](singlepage.html) | Redirect to `index.html`; the old prototype was merged. |

## How it works

### Signal chain

```
getUserMedia → MediaStreamAudioSourceNode → AnalyserNode (fftSize 2048)
             → getFloatTimeDomainData → window (optional) → FFT
             → magnitude → dBFS → 0..255 level → canvas + spectrogram ring
```

The analyser is used only as a source of float time-domain samples. The FFT is
computed in [spectrum-dsp.js](spectrum-dsp.js) so the window, calibration and
smoothing are identical in every mode. `smoothingTimeConstant` is set to 0 and
all temporal smoothing is ours.

### Calibration

A full-scale sine reads 0 dBFS; the bottom of the plot is −90 dBFS. The mapping
is `20·log10(magnitude / (N/2))`, clamped to the display range. Because the
Hamming window is normalized to unit mean gain, switching windows changes
leakage, not the level of a steady tone.

### Spectrogram timing

Every rendered frame is pushed into a 100-frame ring buffer together with its
`performance.now()` timestamp. Rows are ordered oldest (top) to newest (bottom),
and the time axis labels are computed from the timestamps of the frames actually
on screen. At ~60 fps the buffer therefore covers roughly 1.5–2 seconds; the
axis shows the real value. Frame rate does not affect the labels.

The heatmap is built in an `ImageData` buffer at CSS resolution (100 frames ×
1024 bins would otherwise cost ~100k `fillRect` calls per frame) and drawn with
nearest-neighbour scaling.

### FFT and resolution

- FFT size: 2048 samples, 1024 displayed bins.
- Bin spacing: `sampleRate / 2048` ≈ 21.5 Hz at 44.1 kHz, 23.4 Hz at 48 kHz.
- Time window: `2048 / sampleRate` ≈ 46 ms at 44.1 kHz, 43 ms at 48 kHz.
- Larger FFT sizes improve frequency resolution but blur transients; smaller
  sizes do the opposite.

### Windowing

Cutting a signal into 2048-sample blocks is itself a rectangular window. If the
block does not contain a whole number of cycles, energy spreads into nearby
bins (spectral leakage). The Hamming window tapers the block edges:

```
w(n) = 0.54 − 0.46·cos(2πn/(N−1))
```

The implementation divides by the window's mean (coherent gain) so a steady tone
keeps its level. The trade-off is a slightly wider main lobe, i.e. a little less
frequency resolution.

## Testing

```bash
npm test
```

The suite uses Node's built-in test runner:

- **DSP tests** — FFT against a naive DFT, window normalization, dBFS levels,
  smoothing behavior, leakage reduction, ring-buffer wrap-around, axis mapping,
  companding curves.
- **UI smoke test** — loads both scripts in a fake DOM and exercises start, stop,
  permission denial, every toggle, resize and visibility changes. Canvas calls
  and the spectrogram `ImageData` are inspected, including a check that the
  newest frame is at the bottom.

No browser or network access is required.

## Browser support

Chromium-based browsers, Firefox and Safari (current versions) on desktop and
mobile. Requirements: `getUserMedia`, Web Audio API, typed arrays, `async`/`await`
and `ResizeObserver` (optional; resize falls back to the `resize` event).

## Known limitations

- The oscilloscope is not trigger-synchronized, so the waveform can drift
  horizontally at low frame rates.
- Log-frequency bars use a minimum width of one pixel, so the lowest bins
  overlap visually.
- The spectrogram rows are spaced by frame index, not by exact arrival time;
  jitter in `requestAnimationFrame` can shift rows by a fraction of a frame.
- No recording, export or peak-frequency readout yet (see
  [dev/roadmap.md](dev/roadmap.md)).

## Changes in this fork

- Merged the separate `singlepage.html` implementation into one analyzer.
- Unified the spectrum pipeline so windowing no longer changes the dBFS
  calibration or smoothing, and "Smooth: Off" really shows raw data.
- Fixed the spectrogram direction and replaced the guessed time span with
  timestamp-derived labels.
- Moved axis labels out of the data area and scaled amplitudes to the plot
  height (no more clipped bars); added decibel axis labels.
- Added device-pixel-ratio rendering, resize handling and debounced redraws.
- Precomputed FFT twiddle factors, removed per-frame allocations and replaced
  per-bin `fillRect` spectrogram drawing with `ImageData`.
- Fixed microphone teardown, retry after denied permission, and paused the loop
  when the tab is hidden.
- Removed the unused Bootstrap dependency and inline CSS.
- Added the DSP/UI split and the Node test suite.

## License

MIT. See [LICENSE.txt](LICENSE.txt). Original work © M A Chatterjee (deftio).
