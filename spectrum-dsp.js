/*!
 * spectrum-dsp.js — dependency-free DSP helpers for WebAudioSpectrum.
 *
 * Loaded as a plain <script> it exposes window.SpectrumDSP; loaded through
 * require() (Node tests) it exports the same API.
 *
 * Everything here is pure math on typed arrays: no DOM, no audio nodes.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SpectrumDSP = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var DEFAULT_OPTIONS = Object.freeze({
    fftSize: 2048,
    minDb: -90,
    maxDb: 0,
    smoothing: 0.8
  });

  function isPowerOfTwo(value) {
    return value > 1 && (value & (value - 1)) === 0;
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  /**
   * Build an in-place radix-2 Cooley–Tukey FFT of `size` points.
   * Twiddle factors and the bit-reversal table are computed once, so the
   * returned transform allocates nothing and does no trigonometry per call.
   */
  function createFFT(size) {
    if (!isPowerOfTwo(size)) {
      throw new Error('FFT size must be a power of two, got ' + size);
    }
    var levels = Math.round(Math.log2(size));
    var reversed = new Uint32Array(size);
    var i;
    for (i = 0; i < size; i++) {
      var index = i;
      var value = 0;
      for (var bit = 0; bit < levels; bit++) {
        value = (value << 1) | (index & 1);
        index >>>= 1;
      }
      reversed[i] = value;
    }

    var halfSize = size >> 1;
    var cosTable = new Float64Array(halfSize);
    var sinTable = new Float64Array(halfSize);
    for (i = 0; i < halfSize; i++) {
      cosTable[i] = Math.cos((TWO_PI * i) / size);
      sinTable[i] = Math.sin((TWO_PI * i) / size);
    }

    return function transform(real, imag) {
      if (real.length !== size || imag.length !== size) {
        throw new Error('FFT buffers must both have length ' + size);
      }

      // Bit-reversal permutation.
      for (i = 0; i < size; i++) {
        var j = reversed[i];
        if (j > i) {
          var tmp = real[i];
          real[i] = real[j];
          real[j] = tmp;
          tmp = imag[i];
          imag[i] = imag[j];
          imag[j] = tmp;
        }
      }

      // Butterflies, stage by stage.
      for (var width = 2; width <= size; width <<= 1) {
        var half = width >> 1;
        var step = size / width;
        for (var start = 0; start < size; start += width) {
          for (var n = 0, k = 0; n < half; n++, k += step) {
            var wr = cosTable[k];
            var wi = -sinTable[k];
            var a = start + n;
            var b = a + half;
            var tr = wr * real[b] - wi * imag[b];
            var ti = wr * imag[b] + wi * real[b];
            real[b] = real[a] - tr;
            imag[b] = imag[a] - ti;
            real[a] += tr;
            imag[a] += ti;
          }
        }
      }
    };
  }

  /**
   * Hamming window with coherent-gain compensation (mean weight = 1), so a
   * full-scale sine still reads 0 dBFS after windowing.
   */
  function createWindow(size) {
    var weights = new Float64Array(size);
    var sum = 0;
    var n;
    for (n = 0; n < size; n++) {
      var w = size > 1 ? 0.54 - 0.46 * Math.cos((TWO_PI * n) / (size - 1)) : 1;
      weights[n] = w;
      sum += w;
    }
    var gain = sum > 0 ? size / sum : 1;
    for (n = 0; n < size; n++) weights[n] *= gain;
    return weights;
  }

  /** Map a dB value to the 0..255 display level used across the app. */
  function dbToByte(db, minDb, maxDb) {
    if (!isFinite(db)) db = minDb;
    var span = maxDb - minDb;
    var t = span > 0 ? (db - minDb) / span : 0;
    return Math.round(clamp(t, 0, 1) * 255);
  }

  /** X coordinate of `freq` inside a plot of `width` px starting at `x0`. */
  function frequencyToX(freq, sampleRate, mode, x0, width, logMinFrequency) {
    var nyquist = sampleRate / 2;
    if (!(nyquist > 0)) return x0;
    var minF = logMinFrequency || 20;
    if (mode === 'log' && nyquist > minF) {
      var clamped = clamp(freq, minF, nyquist);
      var t = (Math.log10(clamped) - Math.log10(minF)) / (Math.log10(nyquist) - Math.log10(minF));
      return x0 + t * width;
    }
    return x0 + clamp(freq / nyquist, 0, 1) * width;
  }

  /**
   * Map a time-domain sample in [-1, 1] to a display amplitude in [-1, 1].
   * 'log' and 'compand' both amplify quiet signals while keeping full scale
   * at ±1 (mu-law companding, mu = 10).
   */
  function toDisplayAmplitude(sample, mode) {
    var v = clamp(sample, -1, 1);
    var magnitude = Math.abs(v);
    var shaped;
    if (mode === 'log') {
      shaped = magnitude > 0 ? Math.log10(1 + 9 * magnitude) : 0;
    } else if (mode === 'compand') {
      shaped = Math.log1p(10 * magnitude) / Math.log1p(10);
    } else {
      return v;
    }
    return v < 0 ? -shaped : shaped;
  }

  /** "21.5" -> "22", "21500" -> "21.5k" (axis labels). */
  function formatHz(freq) {
    if (freq >= 1000) {
      var k = freq / 1000;
      return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + 'k';
    }
    return String(Math.round(freq));
  }

  /**
   * Spectrum analyzer: time-domain floats in, 0..255 magnitude bins out.
   *
   * The returned function reuses its internal buffers, so callers that keep
   * the result must copy it (createFrameRing does).
   */
  function createSpectrumAnalyzer(options) {
    var opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
    var size = opts.fftSize;
    if (!isPowerOfTwo(size)) {
      throw new Error('fftSize must be a power of two, got ' + size);
    }
    var half = size >> 1;
    var span = opts.maxDb - opts.minDb;
    if (!(span > 0)) throw new Error('maxDb must be greater than minDb');

    var fft = createFFT(size);
    var windowWeights = createWindow(size);
    var real = new Float64Array(size);
    var imag = new Float64Array(size);
    var levels = new Float32Array(half);
    var bytes = new Uint8Array(half);
    var reference = size / 2;
    var hasHistory = false;
    var alpha = clamp(opts.smoothing, 0, 1);

    function analyze(timeData, useWindow, useSmoothing) {
      if (timeData.length < size) {
        throw new Error('time data must contain at least ' + size + ' samples');
      }
      var i;
      for (i = 0; i < size; i++) {
        var sample = timeData[i];
        real[i] = (useWindow ? sample * windowWeights[i] : sample) || 0;
      }
      imag.fill(0);
      fft(real, imag);

      for (var bin = 0; bin < half; bin++) {
        var magnitude = Math.hypot(real[bin], imag[bin]) / reference;
        var db = 20 * Math.log10(magnitude + 1e-12);
        if (db < opts.minDb) db = opts.minDb;
        else if (db > opts.maxDb) db = opts.maxDb;
        var level = ((db - opts.minDb) / span) * 255;

        if (!hasHistory) {
          levels[bin] = level;
        } else if (useSmoothing) {
          levels[bin] = alpha * levels[bin] + (1 - alpha) * level;
        } else {
          levels[bin] = level;
        }
        bytes[bin] = Math.round(levels[bin]);
      }
      hasHistory = true;
      return bytes;
    }

    analyze.reset = function () {
      hasHistory = false;
      levels.fill(0);
    };

    return analyze;
  }

  /**
   * Fixed-size ring buffer of spectrum frames, newest first.
   * dataAt(0) is the newest frame; dataAt(count - 1) the oldest.
   */
  function createFrameRing(capacity, frameSize) {
    if (!(capacity > 0)) throw new Error('capacity must be positive');
    var frames = new Array(capacity);
    for (var i = 0; i < capacity; i++) frames[i] = new Uint8Array(frameSize);
    var times = new Float64Array(capacity);
    var head = -1;
    var count = 0;

    return {
      capacity: capacity,
      frameSize: frameSize,
      get count() {
        return count;
      },
      push: function (data, time) {
        head = (head + 1) % capacity;
        var target = frames[head];
        if (data.length > frameSize) target.set(data.subarray(0, frameSize));
        else target.set(data);
        times[head] = time;
        if (count < capacity) count++;
      },
      dataAt: function (age) {
        if (age < 0 || age >= count) return null;
        return frames[(head - age + capacity * 2) % capacity];
      },
      timeAt: function (age) {
        if (age < 0 || age >= count) return 0;
        return times[(head - age + capacity * 2) % capacity];
      },
      clear: function () {
        head = -1;
        count = 0;
      }
    };
  }

  return {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    createFFT: createFFT,
    createWindow: createWindow,
    createSpectrumAnalyzer: createSpectrumAnalyzer,
    createFrameRing: createFrameRing,
    dbToByte: dbToByte,
    frequencyToX: frequencyToX,
    toDisplayAmplitude: toDisplayAmplitude,
    formatHz: formatHz
  };
});
