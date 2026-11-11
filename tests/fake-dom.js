'use strict';

/**
 * Minimal DOM/canvas/Web-Audio doubles so audioSpectrum.js can be exercised in
 * Node without a browser. Only the APIs the app actually touches are
 * implemented; canvas drawing calls are recorded for assertions.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

const CANVAS_SIZES = {
  oscilloscopeCanvas: 150,
  spectrumCanvas: 210,
  spectrogramCanvas: 190
};

class FakeClassList {
  constructor() {
    this.names = new Set();
  }
  add(...names) {
    names.forEach((name) => this.names.add(name));
  }
  remove(...names) {
    names.forEach((name) => this.names.delete(name));
  }
  contains(name) {
    return this.names.has(name);
  }
  toggle(name, force) {
    const want = force === undefined ? !this.names.has(name) : !!force;
    if (want) this.names.add(name);
    else this.names.delete(name);
    return want;
  }
}

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.imageSmoothingEnabled = true;
    this.transform = [1, 0, 0, 1, 0, 0];
    this.calls = { fillRect: [], clearRect: [], fillText: [], moveTo: [], lineTo: [], drawImage: [] };
    this.lastImageData = null;
    this.putImages = 0;
  }
  setTransform(a, b, c, d, e, f) {
    this.transform = [a, b, c, d, e, f];
  }
  save() {}
  restore() {}
  beginPath() {}
  closePath() {}
  moveTo(x, y) {
    this.calls.moveTo.push([x, y]);
  }
  lineTo(x, y) {
    this.calls.lineTo.push([x, y]);
  }
  stroke() {}
  fill() {}
  fillRect(x, y, width, height) {
    this.calls.fillRect.push({ x, y, width, height, fillStyle: this.fillStyle });
  }
  clearRect(x, y, width, height) {
    this.calls.clearRect.push({ x, y, width, height });
  }
  fillText(text, x, y) {
    this.calls.fillText.push({ text, x, y });
  }
  setLineDash() {}
  createImageData(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    this.lastImageData = { width, height, data };
    return this.lastImageData;
  }
  putImageData(image) {
    this.putImages++;
    this.lastPutImage = image;
  }
  drawImage() {
    this.calls.drawImage.push(Array.from(arguments));
  }
  measureText(text) {
    return { width: text.length * 6 };
  }
}

function createElement(id, tagName) {
  const listeners = new Map();
  const element = {
    id,
    tagName: String(tagName || 'div').toUpperCase(),
    textContent: '',
    disabled: false,
    style: {},
    classList: new FakeClassList(),
    attributes: {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event) {
      (listeners.get(type) || []).forEach((handler) => handler(event || { type }));
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    appendChild() {},
    focus() {}
  };
  return element;
}

function createCanvas(id, clientWidth, clientHeight) {
  const canvas = createElement(id, 'canvas');
  canvas.width = 300;
  canvas.height = 150;
  canvas.clientWidth = clientWidth == null ? 800 : clientWidth;
  canvas.clientHeight = clientHeight == null ? 200 : clientHeight;
  canvas.context = new FakeContext(canvas);
  canvas.getContext = function () {
    return this.context;
  };
  return canvas;
}

function createHarness(options) {
  const opts = options || {};
  const state = {
    now: 1000,
    errors: [],
    consoleErrors: [],
    queue: new Map(),
    nextRafId: 1,
    createdCanvases: [],
    sampleCall: 0,
    documentHandlers: new Map(),
    windowHandlers: new Map(),
    micError: opts.micError || null,
    micErrorOnce: !!opts.micErrorOnce,
    micErrorUsed: false,
    track: {
      stopped: false,
      stop() {
        this.stopped = true;
        state.trackStopped = true;
      }
    },
    trackStopped: false,
    lastContext: null
  };

  const elements = {};
  const ids = [
    'toggle', 'toggleOscilloscope', 'toggleOscilloscopeScale', 'toggleScale',
    'toggleWindow', 'toggleSmooth', 'status', 'oscilloscopePanel',
    'oscilloscopeLabel', 'spectrumLabel', 'spectrogramLabel'
  ];
  ids.forEach((id) => {
    elements[id] = createElement(id, 'div');
  });
  Object.keys(CANVAS_SIZES).forEach((id) => {
    elements[id] = createCanvas(id, 800, CANVAS_SIZES[id]);
  });

  const container = createElement('main-container', 'main');

  const document = {
    readyState: 'complete',
    hidden: false,
    body: createElement('body', 'body'),
    getElementById(id) {
      return elements[id] || null;
    },
    querySelector(selector) {
      return selector === '.main-container' ? container : null;
    },
    createElement(tagName) {
      if (tagName === 'canvas') {
        const canvas = createCanvas('', 0, 0);
        canvas.clientWidth = 0;
        canvas.clientHeight = 0;
        state.createdCanvases.push(canvas);
        return canvas;
      }
      return createElement('', tagName);
    },
    addEventListener(type, handler) {
      if (!state.documentHandlers.has(type)) state.documentHandlers.set(type, []);
      state.documentHandlers.get(type).push(handler);
    }
  };

  function getUserMedia() {
    if (state.micError && !(state.micErrorOnce && state.micErrorUsed)) {
      state.micErrorUsed = true;
      return Promise.reject(state.micError);
    }
    return Promise.resolve({
      getTracks() {
        return [state.track];
      }
    });
  }

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 44100;
      this.state = 'running';
      this.closed = false;
      this.onstatechange = null;
      state.lastContext = this;
    }
    createAnalyser() {
      const context = this;
      return {
        fftSize: 2048,
        smoothingTimeConstant: 0,
        minDecibels: -100,
        maxDecibels: -30,
        connect() {},
        disconnect() {},
        getFloatTimeDomainData(target) {
          // Louder every frame so the spectrogram's top/bottom order is testable.
          const amplitude = 0.1 + 0.08 * state.sampleCall;
          state.sampleCall++;
          for (let i = 0; i < target.length; i++) {
            target[i] = amplitude * Math.sin((2 * Math.PI * 880 * i) / context.sampleRate);
          }
        }
      };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    suspend() {
      this.state = 'suspended';
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      this.closed = true;
      return Promise.resolve();
    }
  }

  const sandbox = {
    console: {
      log() {},
      info() {},
      warn() {},
      error(...args) {
        state.consoleErrors.push(args.join(' '));
      }
    },
    document,
    navigator: { mediaDevices: { getUserMedia } },
    performance: { now: () => state.now },
    requestAnimationFrame(callback) {
      const id = state.nextRafId++;
      state.queue.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      state.queue.delete(id);
    },
    devicePixelRatio: 2,
    AudioContext: FakeAudioContext,
    addEventListener(type, handler) {
      if (!state.windowHandlers.has(type)) state.windowHandlers.set(type, []);
      state.windowHandlers.get(type).push(handler);
    },
    removeEventListener() {}
  };

  const context = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);

  function load() {
    ['spectrum-dsp.js', 'audioSpectrum.js'].forEach((file) => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      vm.runInContext(source, context, { filename: file });
    });
    return api;
  }

  function step(timestamp) {
    const batch = Array.from(state.queue.entries());
    state.queue.clear();
    for (const [, callback] of batch) {
      state.now = timestamp == null ? state.now + 16 : timestamp;
      try {
        callback(state.now);
      } catch (error) {
        state.errors.push(error);
      }
    }
  }

  function settle(rounds) {
    const n = rounds == null ? 8 : rounds;
    let promise = Promise.resolve();
    for (let i = 0; i < n; i++) {
      promise = promise.then(() => new Promise((resolve) => setImmediate(resolve)));
    }
    return promise;
  }

  function canvas(id) {
    return elements[id];
  }

  function spectrogramImage() {
    for (let i = state.createdCanvases.length - 1; i >= 0; i--) {
      const canvas = state.createdCanvases[i];
      if (canvas.context.lastPutImage) return canvas.context.lastPutImage;
    }
    return null;
  }

  const api = {
    state,
    elements,
    document,
    context,
    load,
    step,
    settle,
    canvas,
    spectrogramImage,
    el(id) {
      return elements[id];
    },
    click(id) {
      elements[id].dispatch('click');
      return settle();
    },
    dispatchWindow(type) {
      (state.windowHandlers.get(type) || []).forEach((handler) => handler({ type }));
    },
    dispatchDocument(type) {
      (state.documentHandlers.get(type) || []).forEach((handler) => handler({ type }));
    },
    get errors() {
      return state.errors;
    },
    get trackStopped() {
      return state.trackStopped;
    }
  };

  return api;
}

module.exports = { createHarness };
