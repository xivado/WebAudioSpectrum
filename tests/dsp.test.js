'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DSP = require('../spectrum-dsp.js');

const SIZE = 2048;

function sineSamples(size, bin, amplitude) {
  const data = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    data[i] = amplitude * Math.sin((2 * Math.PI * bin * i) / size);
  }
  return data;
}

function naiveDft(real, imag) {
  const n = real.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sumRe = 0;
    let sumIm = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      sumRe += real[t] * Math.cos(angle) - imag[t] * Math.sin(angle);
      sumIm += real[t] * Math.sin(angle) + imag[t] * Math.cos(angle);
    }
    outRe[k] = sumRe;
    outIm[k] = sumIm;
  }
  return { re: outRe, im: outIm };
}

test('FFT matches a naive DFT', () => {
  const n = 128;
  const fft = DSP.createFFT(n);
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    real[i] = Math.sin((2 * Math.PI * 7 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 23 * i) / n) + 0.05;
  }
  const expected = naiveDft(real, imag);

  fft(real, imag);

  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(real[k] - expected.re[k]) < 1e-9, `real[${k}] differs`);
    assert.ok(Math.abs(imag[k] - expected.im[k]) < 1e-9, `imag[${k}] differs`);
  }
});

test('FFT rejects buffers of the wrong length', () => {
  const fft = DSP.createFFT(16);
  assert.throws(() => fft(new Float64Array(8), new Float64Array(8)), /length 16/);
  assert.throws(() => DSP.createFFT(1000), /power of two/);
});

test('Hamming window is symmetric and has unit mean gain', () => {
  const size = 1024;
  const window = DSP.createWindow(size);
  let sum = 0;
  for (let i = 0; i < size; i++) sum += window[i];
  assert.ok(Math.abs(sum / size - 1) < 1e-9, 'mean weight should be 1');
  assert.ok(Math.abs(window[0] - window[size - 1]) < 1e-12, 'window should be symmetric');
  assert.ok(Math.abs(window[0] - 0.08 / 0.54) < 1e-3, 'normalized Hamming edge should be 0.08/0.54');
});

test('spectrum analyzer reports dBFS magnitude', () => {
  const analyzer = DSP.createSpectrumAnalyzer({ fftSize: SIZE });
  const toneBin = 100;
  const amplitude = 0.5;
  const bytes = analyzer(sineSamples(SIZE, toneBin, amplitude), false, false);

  const expected = DSP.dbToByte(20 * Math.log10(amplitude), -90, 0);
  assert.ok(Math.abs(bytes[toneBin] - expected) <= 1, `peak ${bytes[toneBin]} vs ${expected}`);
  assert.ok(bytes[toneBin + 20] < 20, 'neighbouring bins should stay near the floor');
  assert.equal(bytes.length, SIZE / 2);
});

test('window smoothing is disabled on the first frame', () => {
  const analyzer = DSP.createSpectrumAnalyzer({ fftSize: SIZE });
  const bytes = analyzer(sineSamples(SIZE, 64, 1), false, true);
  const expected = DSP.dbToByte(0, -90, 0);
  assert.ok(Math.abs(bytes[64] - expected) <= 1, 'first frame must not ramp up from zero');
});

test('temporal smoothing eases peaks downward', () => {
  const analyzer = DSP.createSpectrumAnalyzer({ fftSize: SIZE, smoothing: 0.8 });
  const loud = analyzer(sineSamples(SIZE, 64, 1), false, false).slice();
  const quiet = analyzer(sineSamples(SIZE, 64, 0.01), false, true).slice();
  assert.ok(quiet[64] < loud[64], 'smoothed value should fall');
  assert.ok(quiet[64] > DSP.dbToByte(-40, -90, 0), 'but not jump to the new level instantly');
});

test('Hamming window reduces far-bin leakage', () => {
  const analyzer = DSP.createSpectrumAnalyzer({ fftSize: SIZE });
  // A tone halfway between bins leaks the most without a window.
  const offBin = 100.5;
  const samples = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * offBin * i) / SIZE);
  }
  const rectangular = analyzer(samples, false, false).slice();
  const hamming = analyzer(samples, true, false).slice();
  const farBin = 400;
  assert.ok(hamming[farBin] < rectangular[farBin], 'window should lower far leakage');
});

test('frame ring keeps the newest frames and wraps', () => {
  const ring = DSP.createFrameRing(3, 4);
  assert.equal(ring.count, 0);
  assert.equal(ring.dataAt(0), null);

  ring.push([1, 2, 3, 4], 10);
  ring.push([5, 6, 7, 8], 20);
  assert.equal(ring.count, 2);
  assert.equal(ring.dataAt(0)[0], 5);
  assert.equal(ring.dataAt(1)[0], 1);
  assert.equal(ring.timeAt(0), 20);

  ring.push([9, 9, 9, 9], 30);
  ring.push([7, 7, 7, 7], 40);
  assert.equal(ring.count, 3);
  assert.equal(ring.dataAt(0)[0], 7);
  assert.equal(ring.dataAt(1)[0], 9);
  assert.equal(ring.dataAt(2)[0], 5);
  assert.equal(ring.timeAt(2), 20);

  ring.clear();
  assert.equal(ring.count, 0);
  assert.equal(ring.dataAt(0), null);
});

test('frequencyToX maps endpoints and clamps', () => {
  const x0 = 40;
  const width = 500;
  assert.equal(DSP.frequencyToX(0, 48000, 'linear', x0, width), x0);
  assert.equal(DSP.frequencyToX(24000, 48000, 'linear', x0, width), x0 + width);
  assert.equal(DSP.frequencyToX(-100, 48000, 'linear', x0, width), x0);

  assert.ok(Math.abs(DSP.frequencyToX(20, 48000, 'log', x0, width) - x0) < 1e-9);
  assert.ok(Math.abs(DSP.frequencyToX(24000, 48000, 'log', x0, width) - (x0 + width)) < 1e-9);

  let previous = -Infinity;
  for (let f = 20; f <= 20000; f *= 1.2) {
    const x = DSP.frequencyToX(f, 48000, 'log', x0, width);
    assert.ok(x > previous, 'log mapping should increase monotonically');
    previous = x;
  }
});

test('display amplitude modes are bounded, odd and monotonic', () => {
  for (const mode of ['linear', 'log', 'compand']) {
    assert.equal(DSP.toDisplayAmplitude(0, mode), 0);
    assert.equal(DSP.toDisplayAmplitude(1, mode), 1);
    assert.equal(DSP.toDisplayAmplitude(-1, mode), -1);
    assert.equal(DSP.toDisplayAmplitude(0.3, mode), -DSP.toDisplayAmplitude(-0.3, mode));

    let previous = -Infinity;
    for (let v = -1; v <= 1.0001; v += 0.05) {
      const y = DSP.toDisplayAmplitude(v, mode);
      assert.ok(Math.abs(y) <= 1, 'output must stay in [-1, 1]');
      assert.ok(y >= previous - 1e-12, 'output must be monotonic');
      previous = y;
    }
  }
  assert.ok(DSP.toDisplayAmplitude(0.01, 'log') > 0.01, 'log amplifies quiet signals');
  assert.ok(DSP.toDisplayAmplitude(0.01, 'compand') > 0.01, 'compand amplifies quiet signals');
});

test('dbToByte clamps and rounds', () => {
  assert.equal(DSP.dbToByte(0, -90, 0), 255);
  assert.equal(DSP.dbToByte(-90, -90, 0), 0);
  assert.equal(DSP.dbToByte(-200, -90, 0), 0);
  assert.equal(DSP.dbToByte(10, -90, 0), 255);
  assert.equal(DSP.dbToByte(-45, -90, 0), 128);
});

test('formatHz uses compact kHz labels', () => {
  assert.equal(DSP.formatHz(20), '20');
  assert.equal(DSP.formatHz(500), '500');
  assert.equal(DSP.formatHz(1500), '1.5k');
  assert.equal(DSP.formatHz(2000), '2k');
  assert.equal(DSP.formatHz(20000), '20k');
});
