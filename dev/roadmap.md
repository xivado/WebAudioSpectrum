# WebAudioSpectrum Development Roadmap

Status after the 2026 cleanup: the analyzer is now a single implementation with a
pure DSP module, tests and a documented signal chain. Items below are grouped by
area; `[x]` means done in this repository, `[ ]` means still open.

## Documentation

### README.md

- [x] Prerequisites and secure-context (HTTPS/localhost) requirement
- [x] Browser compatibility note
- [x] Clarify the role of `index.html` vs the retired `singlepage.html`
- [x] Technical specifications (FFT size, bin spacing, window length)
- [x] Explain dBFS calibration, windowing and smoothing behavior
- [x] Document spectrogram direction and timestamp-derived time axis
- [x] Testing instructions
- [ ] Screenshots of the three visualizations
- [ ] Troubleshooting matrix for permission and autoplay errors

## UI/UX

### Visual design

- [x] Consistent button styling (single stylesheet, no Bootstrap)
- [x] Responsive canvas sizing instead of fixed `vh` units
- [x] Compact mobile layout
- [x] Light/dark theme via `prefers-color-scheme`
- [ ] Selectable color maps (scientific / heat / grayscale)

### Functional

- [x] Buttons show current state ("Scale: Log", "Window: Hamming", …)
- [x] Busy state while the microphone request is pending
- [x] Human-readable microphone errors with recovery hints
- [x] Axis labels and frequency markers on all panels
- [x] Decibel scale on the spectrum
- [x] Time scale on the spectrogram (from real frame timestamps)
- [ ] Peak-frequency readout
- [ ] Layout presets (spectrum only / spectrogram only)

## Technical

### Correctness

- [x] One FFT path, so the window toggle cannot change calibration or smoothing
- [x] Amplitude mapped to plot height (bars no longer clip)
- [x] Y-axis labels drawn outside the data area, after the bars
- [x] Spectrogram ordering: newest at the bottom, oldest at the top
- [x] Spectrogram time span measured rather than assumed
- [x] Microphone tracks stopped and `AudioContext` closed on stop
- [x] Retry after a denied permission without reloading
- [x] Render loop paused while the tab is hidden
- [x] High-DPI canvas backing store (`devicePixelRatio`, capped at 2)
- [x] Debounced resize handling
- [ ] Trigger-synchronized oscilloscope (stable waveform)

### Performance

- [x] Precomputed twiddle factors and bit-reversal table
- [x] No per-frame typed-array allocations in the hot path
- [x] Spectrogram rendered via `ImageData` instead of per-bin `fillRect`
- [x] Fixed-size frame ring buffer (no unbounded growth or `shift()` churn)
- [ ] FPS counter / performance panel
- [ ] Optional lower FFT size for low-end devices
- [ ] WebGL or Web Worker rendering path

### Accessibility

- [x] ARIA labels and `aria-pressed` on controls
- [x] Live status announcements
- [x] Visible focus indicators
- [ ] Keyboard shortcuts (space to start/stop, arrows for settings)
- [ ] Numeric alternative to the visualizations (peak bins)

### Code quality

- [x] External stylesheet (no inline CSS)
- [x] Module pattern (IIFE UI, UMD DSP module)
- [x] Central `CONFIG` for FFT size, dB range, frame count, DPR cap
- [x] DSP split from DOM/audio code and unit-tested
- [x] Fake-DOM smoke test for the UI
- [ ] Full JSDoc coverage
- [ ] ESLint configuration
- [ ] GitHub Actions running `npm test`

## Retired

- [x] Merge the oscilloscope from `singlepage.html` into the unified page
- [x] Replace `singlepage.html` with a redirect to `index.html`
- [x] Remove the unused Bootstrap dependency
- [x] Remove the duplicated AudioWorklet prototype code

## Future features

### Analysis

- [ ] Peak frequency detection and labels
- [ ] Note detection (musical pitch)
- [ ] Frequency-band levels (bass / mid / treble)
- [ ] Audio recording and playback
- [ ] Waterfall option for the spectrogram

### Customization

- [ ] Adjustable FFT size selector
- [ ] Frequency-range zoom
- [ ] Color-theme picker
- [ ] Export visualizations as images

### Platform

- [ ] PWA / offline installation
- [ ] MIDI input for instrument analysis
- [ ] Development server with hot reload
