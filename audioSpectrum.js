/*!
 * audioSpectrum.js — microphone lifecycle and canvas rendering for
 * WebAudioSpectrum. Depends on spectrum-dsp.js (window.SpectrumDSP).
 *
 * Design notes
 * - One analysis path: every frame is windowed (or not) and FFT'd here, so the
 *   "Window" toggle can never silently change the amplitude calibration.
 * - Display calibration is dBFS: 0 dB = full scale, -90 dB = bottom of the plot.
 * - Canvases are sized for devicePixelRatio (capped at 2) and re-fit on resize.
 * - The spectrogram is rendered through ImageData at CSS resolution and scaled
 *   with nearest-neighbour sampling; that keeps 100 frames x 1024 bins cheap.
 */
(function () {
  'use strict';

  var DSP = window.SpectrumDSP;
  if (!DSP) {
    console.error('[WebAudioSpectrum] spectrum-dsp.js must be loaded before audioSpectrum.js');
    return;
  }

  var CONFIG = {
    fftSize: 2048,
    maxFrames: 100,
    minDb: -90,
    maxDb: 0,
    smoothingAlpha: 0.8,
    logMinFrequency: 20,
    maxPixelRatio: 2,
    decibelTicks: [0, -15, -30, -45, -60, -75, -90],
    timeRows: 4
  };

  var LAYOUT = { left: 44, right: 12, top: 10, bottom: 20 };
  var LOG_FREQUENCIES = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  var LABEL_FONT = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  var HINT_FONT = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  var MIN_LABEL_GAP = 38;

  var LITTLE_ENDIAN = (function () {
    var buffer = new ArrayBuffer(4);
    new Uint32Array(buffer)[0] = 1;
    return new Uint8Array(buffer)[0] === 1;
  })();

  var OPAQUE_BLACK = LITTLE_ENDIAN ? 0xff000000 : 0x000000ff;

  // ------------------------------------------------------------------ DOM

  function byId(name) {
    return document.getElementById(name);
  }

  var el = {
    toggle: byId('toggle'),
    scopeToggle: byId('toggleOscilloscope'),
    scopeScale: byId('toggleOscilloscopeScale'),
    scale: byId('toggleScale'),
    windowBtn: byId('toggleWindow'),
    smooth: byId('toggleSmooth'),
    status: byId('status'),
    scopePanel: byId('oscilloscopePanel'),
    scopeLabel: byId('oscilloscopeLabel'),
    spectrumLabel: byId('spectrumLabel'),
    spectrogramLabel: byId('spectrogramLabel'),
    scopeCanvas: byId('oscilloscopeCanvas'),
    spectrumCanvas: byId('spectrumCanvas'),
    spectrogramCanvas: byId('spectrogramCanvas')
  };

  var REQUIRED_IDS = [
    'toggle', 'scopeToggle', 'scopeScale', 'scale', 'windowBtn', 'smooth',
    'status', 'scopePanel', 'scopeLabel', 'spectrumLabel', 'spectrogramLabel',
    'scopeCanvas', 'spectrumCanvas', 'spectrogramCanvas'
  ];
  for (var r = 0; r < REQUIRED_IDS.length; r++) {
    if (!el[REQUIRED_IDS[r]]) {
      console.error('[WebAudioSpectrum] missing element #' + REQUIRED_IDS[r]);
      return;
    }
  }

  // ---------------------------------------------------------------- state

  var audioContext = null;
  var analyser = null;
  var sourceNode = null;
  var mediaStream = null;
  var analyzer = null;
  var timeData = null;

  var sampling = false;
  var starting = false;
  var rafId = 0;
  var resizeScheduled = false;

  var sampleRate = 44100;
  var freqMode = 'linear';
  var scopeMode = 'linear';
  var useWindow = false;
  var useSmoothing = false;
  var showScope = false;

  var ring = DSP.createFrameRing(CONFIG.maxFrames, CONFIG.fftSize >> 1);

  // -------------------------------------------------------------- palettes

  var SPECTRUM_PALETTE = (function () {
    var colors = new Array(256);
    for (var v = 0; v < 256; v++) {
      var t = v / 255;
      colors[v] = 'hsl(' + Math.round(190 - 150 * t) + ', 90%, ' + Math.round(46 + 16 * t) + '%)';
    }
    return colors;
  })();

  var SPECTROGRAM_PALETTE = (function () {
    var stops = [
      [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99],
      [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]
    ];
    var rgb = new Uint8Array(256 * 3);
    var packed = new Uint32Array(256);
    for (var v = 0; v < 256; v++) {
      var t = (v / 255) * (stops.length - 1);
      var index = Math.min(Math.floor(t), stops.length - 2);
      var f = t - index;
      var a = stops[index];
      var b = stops[index + 1];
      var red = Math.round(a[0] + (b[0] - a[0]) * f);
      var green = Math.round(a[1] + (b[1] - a[1]) * f);
      var blue = Math.round(a[2] + (b[2] - a[2]) * f);
      rgb[v * 3] = red;
      rgb[v * 3 + 1] = green;
      rgb[v * 3 + 2] = blue;
      packed[v] = LITTLE_ENDIAN
        ? ((255 << 24) | (blue << 16) | (green << 8) | red) >>> 0
        : ((255 << 24) | (red << 16) | (green << 8) | blue) >>> 0;
    }
    return { packed: packed, rgb: rgb };
  })();

  var specCache = null;

  // --------------------------------------------------------------- helpers

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function setStatus(text, isError) {
    el.status.textContent = text;
    el.status.classList.toggle('error', !!isError);
  }

  function describeError(error) {
    var name = error && error.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone access was blocked. Allow it in the browser site settings (HTTPS or localhost) and try again.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No microphone is available on this device.';
    }
    if (name === 'NotReadableError') {
      return 'The microphone is already in use by another app.';
    }
    return 'Could not start sampling: ' + ((error && error.message) || 'unknown error') + '.';
  }

  function fitCanvas(canvas) {
    var dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio);
    var cssWidth = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 1));
    var cssHeight = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 1));
    var pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    var pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, width: cssWidth, height: cssHeight };
  }

  function plotRect(width, height) {
    return {
      x: LAYOUT.left,
      y: LAYOUT.top,
      w: Math.max(20, width - LAYOUT.left - LAYOUT.right),
      h: Math.max(20, height - LAYOUT.top - LAYOUT.bottom)
    };
  }

  function paintBackground(ctx, width, height) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }

  function drawHint(ctx, rect, text) {
    ctx.font = HINT_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2);
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '0 s';
    if (seconds >= 1) return (Math.round(seconds * 10) / 10) + ' s';
    return Math.round(seconds * 1000) + ' ms';
  }

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // -------------------------------------------------------------- frequency

  function niceStep(range, targetTicks) {
    var raw = range / Math.max(1, targetTicks);
    var magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    var multiples = [1, 2, 2.5, 5, 10];
    var best = multiples[0] * magnitude;
    var bestError = Infinity;
    for (var i = 0; i < multiples.length; i++) {
      var candidate = multiples[i] * magnitude;
      var error = Math.abs(candidate - raw);
      if (error < bestError) {
        best = candidate;
        bestError = error;
      }
    }
    return best;
  }

  function frequencyTicks(plotWidth) {
    var nyquist = sampleRate / 2;
    var ticks = [];
    var i;
    if (freqMode === 'log') {
      for (i = 0; i < LOG_FREQUENCIES.length; i++) {
        if (LOG_FREQUENCIES[i] < nyquist) ticks.push(LOG_FREQUENCIES[i]);
      }
    } else {
      var step = niceStep(nyquist, Math.max(3, Math.round(plotWidth / 90)));
      for (var freq = step; freq < nyquist * 0.995; freq += step) ticks.push(freq);
    }
    return ticks;
  }

  function freqToX(freq, rect) {
    return DSP.frequencyToX(
      freq, sampleRate, freqMode, rect.x, rect.w, CONFIG.logMinFrequency
    );
  }

  function drawFrequencyGrid(ctx, rect, ticks) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i < ticks.length; i++) {
      var x = Math.round(freqToX(ticks[i], rect)) + 0.5;
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.h);
    }
    ctx.stroke();
  }

  function drawFrequencyLabels(ctx, rect, ticks) {
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    var lastX = -Infinity;
    for (var i = 0; i < ticks.length; i++) {
      var x = freqToX(ticks[i], rect);
      if (i > 0 && x - lastX < MIN_LABEL_GAP && i !== ticks.length - 1) continue;
      ctx.fillText(DSP.formatHz(ticks[i]), x, rect.y + rect.h + 6);
      lastX = x;
    }
  }

  function drawDecibelGrid(ctx, rect) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i < CONFIG.decibelTicks.length; i++) {
      var y = Math.round(decibelToY(CONFIG.decibelTicks[i], rect)) + 0.5;
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
    }
    ctx.stroke();
  }

  function decibelToY(db, rect) {
    var t = (db - CONFIG.minDb) / (CONFIG.maxDb - CONFIG.minDb);
    return rect.y + rect.h * (1 - clamp(t, 0, 1));
  }

  function drawDecibelLabels(ctx, rect) {
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    for (var i = 0; i < CONFIG.decibelTicks.length; i++) {
      var y = clamp(decibelToY(CONFIG.decibelTicks[i], rect), rect.y + 5, rect.y + rect.h - 5);
      ctx.fillText(String(CONFIG.decibelTicks[i]), rect.x - 8, y);
    }
  }

  function drawTimeGrid(ctx, rect) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i <= CONFIG.timeRows; i++) {
      var y = Math.round(rect.y + (rect.h * i) / CONFIG.timeRows) + 0.5;
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
    }
    ctx.stroke();
  }

  function drawTimeLabels(ctx, rect, spanSeconds) {
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    for (var i = 0; i <= CONFIG.timeRows; i++) {
      var y = rect.y + (rect.h * i) / CONFIG.timeRows;
      var secondsAgo = spanSeconds * (1 - i / CONFIG.timeRows);
      ctx.fillText(formatDuration(secondsAgo), rect.x - 8, y);
    }
  }

  function drawPlotFrame(ctx, rect) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rect.x + 0.5, rect.y);
    ctx.lineTo(rect.x + 0.5, rect.y + rect.h);
    ctx.moveTo(rect.x, rect.y + rect.h + 0.5);
    ctx.lineTo(rect.x + rect.w, rect.y + rect.h + 0.5);
    ctx.stroke();
  }

  // -------------------------------------------------------------- spectrum

  function drawSpectrumBars(ctx, rect, values) {
    var binCount = values.length;
    var nyquist = sampleRate / 2;
    for (var bin = 0; bin < binCount; bin++) {
      var level = values[bin];
      if (level <= 0) continue;
      var left = freqToX((bin * nyquist) / binCount, rect);
      var right = freqToX(((bin + 1) * nyquist) / binCount, rect);
      var barWidth = right - left;
      if (barWidth < 1) barWidth = 1;
      var barHeight = (level / 255) * rect.h;
      ctx.fillStyle = SPECTRUM_PALETTE[level];
      ctx.fillRect(left, rect.y + rect.h - barHeight, barWidth, barHeight);
    }
  }

  function drawSpectrumFrame(values) {
    var view = fitCanvas(el.spectrumCanvas);
    var ctx = view.ctx;
    paintBackground(ctx, view.width, view.height);
    var rect = plotRect(view.width, view.height);
    var ticks = frequencyTicks(rect.w);

    drawFrequencyGrid(ctx, rect, ticks);
    drawDecibelGrid(ctx, rect);
    if (values) drawSpectrumBars(ctx, rect, values);
    drawPlotFrame(ctx, rect);
    drawDecibelLabels(ctx, rect);
    drawFrequencyLabels(ctx, rect, ticks);
    if (!values) drawHint(ctx, rect, 'press “Start Sampling”');
  }

  // ----------------------------------------------------------- spectrogram

  function visibleSpanSeconds() {
    if (ring.count < 2) return 0;
    return Math.max(0, (ring.timeAt(0) - ring.timeAt(ring.count - 1)) / 1000);
  }

  function buildColumnBins(width) {
    var bins = new Int32Array(width);
    var half = CONFIG.fftSize >> 1;
    var nyquist = sampleRate / 2;
    var logMin = Math.log10(CONFIG.logMinFrequency);
    var logMax = Math.log10(nyquist);
    var useLog = freqMode === 'log' && nyquist > CONFIG.logMinFrequency;
    for (var x = 0; x < width; x++) {
      var t = (x + 0.5) / width;
      var freq = useLog ? Math.pow(10, logMin + t * (logMax - logMin)) : t * nyquist;
      var bin = Math.round((freq / nyquist) * half);
      bins[x] = clamp(bin, 0, half - 1);
    }
    return bins;
  }

  function ensureSpectrogramCache(width, height) {
    if (!specCache) {
      var canvas = document.createElement('canvas');
      specCache = {
        canvas: canvas,
        ctx: canvas.getContext('2d'),
        width: 0,
        height: 0,
        image: null,
        pixels: null,
        bytes: null,
        columnBins: null,
        cacheKey: ''
      };
    }
    if (specCache.width !== width || specCache.height !== height) {
      specCache.canvas.width = width;
      specCache.canvas.height = height;
      specCache.image = specCache.ctx.createImageData(width, height);
      specCache.pixels = LITTLE_ENDIAN
        ? new Uint32Array(specCache.image.data.buffer)
        : null;
      specCache.bytes = specCache.image.data;
      if (!specCache.pixels) {
        // Big-endian fallback: start from opaque black so empty rows stay black.
        for (var byteIndex = 3; byteIndex < specCache.bytes.length; byteIndex += 4) {
          specCache.bytes[byteIndex] = 255;
        }
      }
      specCache.width = width;
      specCache.height = height;
      specCache.cacheKey = '';
    }
    var key = freqMode + '|' + sampleRate + '|' + width;
    if (specCache.cacheKey !== key) {
      specCache.columnBins = buildColumnBins(width);
      specCache.cacheKey = key;
    }
  }

  function drawSpectrogramImage(ctx, rect) {
    var width = Math.max(1, Math.floor(rect.w));
    var height = Math.max(1, Math.floor(rect.h));
    ensureSpectrogramCache(width, height);

    var count = ring.count;
    var pixels = specCache.pixels;
    var bytes = specCache.bytes;
    var bins = specCache.columnBins;
    var palette = SPECTROGRAM_PALETTE;

    if (pixels) pixels.fill(OPAQUE_BLACK);

    if (count > 0) {
      for (var y = 0; y < height; y++) {
        // Newest frame at the bottom, oldest at the top.
        var age = Math.round((1 - (y + 0.5) / height) * (count - 1));
        var frame = ring.dataAt(age);
        var rowStart = y * width;
        if (!frame) continue;
        if (pixels) {
          for (var x = 0; x < width; x++) {
            pixels[rowStart + x] = palette.packed[frame[bins[x]]];
          }
        } else {
          for (var column = 0; column < width; column++) {
            var level = frame[bins[column]];
            var offset = (rowStart + column) * 4;
            bytes[offset] = palette.rgb[level * 3];
            bytes[offset + 1] = palette.rgb[level * 3 + 1];
            bytes[offset + 2] = palette.rgb[level * 3 + 2];
            bytes[offset + 3] = 255;
          }
        }
      }
    }

    specCache.ctx.putImageData(specCache.image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(specCache.canvas, rect.x, rect.y, rect.w, rect.h);
    ctx.imageSmoothingEnabled = true;
  }

  function drawSpectrogramFrame() {
    var view = fitCanvas(el.spectrogramCanvas);
    var ctx = view.ctx;
    paintBackground(ctx, view.width, view.height);
    var rect = plotRect(view.width, view.height);
    var ticks = frequencyTicks(rect.w);

    drawSpectrogramImage(ctx, rect);
    drawFrequencyGrid(ctx, rect, ticks);
    drawTimeGrid(ctx, rect);
    drawPlotFrame(ctx, rect);
    if (ring.count >= 2) drawTimeLabels(ctx, rect, visibleSpanSeconds());
    drawFrequencyLabels(ctx, rect, ticks);
    if (ring.count === 0) drawHint(ctx, rect, sampling ? 'waiting for audio…' : 'press “Start Sampling”');
  }

  // ---------------------------------------------------------- oscilloscope

  function drawOscilloscopeFrame(samples) {
    var view = fitCanvas(el.scopeCanvas);
    var ctx = view.ctx;
    paintBackground(ctx, view.width, view.height);

    var x0 = 8;
    var y0 = 6;
    var innerWidth = Math.max(10, view.width - 16);
    var innerHeight = Math.max(10, view.height - 12);
    var middle = y0 + innerHeight / 2;

    ctx.strokeStyle = 'rgba(57,255,106,0.14)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, middle + 0.5);
    ctx.lineTo(x0 + innerWidth, middle + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    if (samples) {
      ctx.strokeStyle = '#39ff6a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      var sampleCount = samples.length;
      for (var i = 0; i < sampleCount; i++) {
        var v = DSP.toDisplayAmplitude(samples[i], scopeMode);
        var x = x0 + (i / (sampleCount - 1)) * innerWidth;
        var y = middle - v * (innerHeight / 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(57,255,106,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, middle + 0.5);
      ctx.lineTo(x0 + innerWidth, middle + 0.5);
      ctx.stroke();
    }

    var milliseconds = (CONFIG.fftSize / sampleRate) * 1000;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(190,255,200,0.65)';
    ctx.fillText(
      milliseconds.toFixed(1) + ' ms · ' + CONFIG.fftSize + ' samples · ' + scopeMode,
      x0 + innerWidth,
      y0
    );
  }

  // ------------------------------------------------------------- rendering

  function drawIdlePanels() {
    drawSpectrumFrame(null);
    drawSpectrogramFrame();
    if (showScope) drawOscilloscopeFrame(null);
  }

  function scheduleFrame() {
    if (!rafId && sampling) rafId = requestAnimationFrame(renderFrame);
  }

  function renderFrame() {
    rafId = 0;
    if (!sampling || document.hidden) return;
    if (!analyser || !audioContext || audioContext.state !== 'running') return;

    try {
      analyser.getFloatTimeDomainData(timeData);
      var spectrum = analyzer(timeData, useWindow, useSmoothing);
      ring.push(spectrum, performance.now());

      if (showScope) drawOscilloscopeFrame(timeData);
      drawSpectrumFrame(spectrum);
      drawSpectrogramFrame();
    } catch (error) {
      console.error('[WebAudioSpectrum] frame failed', error);
      try { stopSampling(); } catch (ignored) { /* ignore */ }
      setStatus('Visualization stopped after an error: ' + (error && error.message), true);
      return;
    }

    scheduleFrame();
  }

  // ------------------------------------------------------------- lifecycle

  async function beginSampling() {
    if (sampling || starting) return;
    starting = true;
    updateControls();
    setStatus('Requesting microphone access…');

    var context = null;
    var stream = null;
    try {
      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) throw new Error('This browser does not support the Web Audio API');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access needs a secure context (HTTPS or localhost)');
      }

      // Create the context while we still have the click gesture.
      context = new AudioCtor();
      var resumePromise = context.state === 'suspended'
        ? context.resume().catch(function () {})
        : Promise.resolve();

      var constraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      };
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (constraintError) {
        var name = constraintError && constraintError.name;
        if (name === 'OverconstrainedError' || name === 'TypeError' || name === 'NotSupportedError') {
          // Older mobile browsers reject the processing flags; plain audio still works.
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw constraintError;
        }
      }
      await resumePromise;
      if (context.state !== 'running') {
        throw new Error('the audio context stayed suspended');
      }

      var analyserNode = context.createAnalyser();
      analyserNode.fftSize = CONFIG.fftSize;
      analyserNode.smoothingTimeConstant = 0;
      analyserNode.minDecibels = CONFIG.minDb;
      analyserNode.maxDecibels = CONFIG.maxDb;

      var source = context.createMediaStreamSource(stream);
      source.connect(analyserNode);

      audioContext = context;
      analyser = analyserNode;
      sourceNode = source;
      mediaStream = stream;
      sampleRate = context.sampleRate;
      timeData = new Float32Array(analyserNode.fftSize);
      analyzer = DSP.createSpectrumAnalyzer({
        fftSize: analyserNode.fftSize,
        minDb: CONFIG.minDb,
        maxDb: CONFIG.maxDb,
        smoothing: CONFIG.smoothingAlpha
      });
      audioContext.onstatechange = function () {
        if (sampling && audioContext && audioContext.state === 'running') scheduleFrame();
      };

      ring.clear();
      sampling = true;
      starting = false;
      setStatus('Sampling — play audio or speak.');
      updateControls();
      scheduleFrame();
    } catch (error) {
      if (stream) {
        stream.getTracks().forEach(function (track) {
          try { track.stop(); } catch (e) { /* ignore */ }
        });
      }
      if (context) {
        try {
          var rejected = context.close();
          if (rejected && typeof rejected.catch === 'function') rejected.catch(function () {});
        } catch (e) { /* ignore */ }
      }
      mediaStream = null;
      audioContext = null;
      analyser = null;
      sourceNode = null;
      timeData = null;
      analyzer = null;
      sampling = false;
      starting = false;
      setStatus(describeError(error), true);
      updateControls();
      drawIdlePanels();
    }
  }

  function stopSampling() {
    sampling = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (e) { /* ignore */ }
      });
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (e) { /* ignore */ }
    }
    if (analyser) {
      try { analyser.disconnect(); } catch (e) { /* ignore */ }
    }
    if (audioContext) {
      var context = audioContext;
      try {
        var closing = context.close();
        if (closing && typeof closing.catch === 'function') closing.catch(function () {});
      } catch (e) { /* ignore */ }
    }
    mediaStream = null;
    audioContext = null;
    analyser = null;
    sourceNode = null;
    timeData = null;
    analyzer = null;
    ring.clear();
    setStatus('Stopped — microphone released.');
    updateControls();
    drawIdlePanels();
  }

  // ---------------------------------------------------------------- controls

  function updateControls() {
    el.toggle.textContent = starting ? 'Starting…' : sampling ? 'Stop Sampling' : 'Start Sampling';
    el.toggle.disabled = starting;
    el.toggle.classList.add('primary');
    el.toggle.classList.toggle('stop', sampling);
    el.toggle.setAttribute('aria-pressed', String(sampling));

    el.scopeToggle.textContent = showScope ? 'Hide Oscilloscope' : 'Show Oscilloscope';
    el.scopeToggle.classList.toggle('active', showScope);
    el.scopeToggle.setAttribute('aria-pressed', String(showScope));

    el.scopeScale.textContent = 'Scope: ' + capitalize(scopeMode);
    el.scopeScale.classList.toggle('active', scopeMode !== 'linear');
    el.scopeScale.setAttribute('aria-pressed', String(scopeMode !== 'linear'));
    el.scopeScale.style.display = showScope ? 'inline-block' : 'none';

    el.scale.textContent = 'Scale: ' + (freqMode === 'log' ? 'Log' : 'Linear');
    el.scale.classList.toggle('active', freqMode === 'log');
    el.scale.setAttribute('aria-pressed', String(freqMode === 'log'));

    el.windowBtn.textContent = 'Window: ' + (useWindow ? 'Hamming' : 'Rectangular');
    el.windowBtn.classList.toggle('active', useWindow);
    el.windowBtn.setAttribute('aria-pressed', String(useWindow));

    el.smooth.textContent = 'Smooth: ' + (useSmoothing ? 'On' : 'Off');
    el.smooth.classList.toggle('active', useSmoothing);
    el.smooth.setAttribute('aria-pressed', String(useSmoothing));

    el.scopePanel.classList.toggle('show', showScope);
    el.scopeLabel.textContent = 'Oscilloscope — Time Domain (' + capitalize(scopeMode) + ' Amplitude)';
    el.spectrumLabel.textContent = 'Frequency Spectrum — ' + capitalize(freqMode) + ' Frequency';
    el.spectrogramLabel.textContent = 'Spectrogram — ' + capitalize(freqMode) + ' Frequency';
  }

  function redrawWhenIdle() {
    if (!sampling) drawIdlePanels();
  }

  // ------------------------------------------------------------------- init

  function handleResize() {
    if (resizeScheduled) return;
    resizeScheduled = true;
    requestAnimationFrame(function () {
      resizeScheduled = false;
      if (!sampling) drawIdlePanels();
    });
  }

  function init() {
    el.toggle.addEventListener('click', function () {
      if (sampling) stopSampling();
      else beginSampling();
    });

    el.scopeToggle.addEventListener('click', function () {
      showScope = !showScope;
      updateControls();
      if (showScope) {
        // The panel was display:none, so its canvas has no size until now.
        requestAnimationFrame(function () {
          if (showScope) drawOscilloscopeFrame(timeData);
        });
      }
      redrawWhenIdle();
    });

    el.scopeScale.addEventListener('click', function () {
      scopeMode = scopeMode === 'linear' ? 'log' : scopeMode === 'log' ? 'compand' : 'linear';
      updateControls();
      if (!sampling) drawOscilloscopeFrame(null);
    });

    el.scale.addEventListener('click', function () {
      freqMode = freqMode === 'log' ? 'linear' : 'log';
      updateControls();
      redrawWhenIdle();
    });

    el.windowBtn.addEventListener('click', function () {
      useWindow = !useWindow;
      updateControls();
    });

    el.smooth.addEventListener('click', function () {
      useSmoothing = !useSmoothing;
      updateControls();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else {
        if (sampling && audioContext && audioContext.state === 'suspended') {
          audioContext.resume().catch(function () { /* ignore */ });
        }
        scheduleFrame();
      }
    });

    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('pagehide', function () {
      if (sampling) stopSampling();
    });

    if (typeof ResizeObserver === 'function') {
      var container = document.querySelector('.main-container');
      if (container) new ResizeObserver(handleResize).observe(container);
    }

    updateControls();
    drawIdlePanels();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
