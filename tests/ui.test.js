'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./fake-dom.js');

function barRects(canvas) {
  // Ignore the full-canvas background fill.
  return canvas.context.calls.fillRect.filter((rect) => rect.width < canvas.clientWidth - 1);
}

function maxBrightness(image, row) {
  let max = 0;
  for (let x = 0; x < image.width; x++) {
    const offset = (row * image.width + x) * 4;
    max = Math.max(max, image.data[offset] + image.data[offset + 1] + image.data[offset + 2]);
  }
  return max;
}

test('initializes with high-DPI canvases and an idle hint', () => {
  const harness = createHarness();
  harness.load();

  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.state.consoleErrors, []);

  const spectrum = harness.canvas('spectrumCanvas');
  assert.equal(spectrum.width, 1600); // 800 CSS px x devicePixelRatio 2
  assert.equal(spectrum.height, 420); // 210 CSS px x 2

  const text = spectrum.context.calls.fillText.map((call) => call.text).join(' | ');
  assert.match(text, /Start Sampling/);
  assert.match(text, /-90/);
  assert.match(text, /20k/);

  // The oscilloscope panel starts hidden.
  assert.equal(harness.el('oscilloscopePanel').classList.contains('show'), false);
});

test('sampling draws bounded bars and puts the newest spectrogram row at the bottom', async () => {
  const harness = createHarness();
  harness.load();
  await harness.click('toggle');

  assert.deepEqual(harness.errors, []);
  assert.match(harness.el('toggle').textContent, /Stop Sampling/);
  assert.ok(harness.el('toggle').classList.contains('stop'), 'stop styling requires .primary.stop');

  for (let i = 0; i < 8; i++) harness.step(2000 + i * 16);
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.state.consoleErrors, []);

  const spectrum = harness.canvas('spectrumCanvas');
  const rects = barRects(spectrum);
  assert.ok(rects.length > 0, 'spectrum should draw bars');
  for (const rect of rects) {
    assert.ok(rect.y >= 9.5, `bar starts at ${rect.y}`);
    assert.ok(rect.y + rect.height <= 190.5, `bar bottom ${rect.y + rect.height}`);
    assert.ok(rect.x >= 43.5, `bar x ${rect.x}`);
    assert.ok(rect.x + rect.width <= 788.5, `bar right ${rect.x + rect.width}`);
  }
  const tallest = Math.max(...rects.map((rect) => rect.height));
  assert.ok(tallest > 140, `tallest bar ${tallest} should use most of the plot`);

  const image = harness.spectrogramImage();
  assert.ok(image, 'spectrogram should be rendered through ImageData');
  assert.equal(image.width, 744);
  assert.equal(image.height, 160);

  const top = maxBrightness(image, 0);
  const bottom = maxBrightness(image, image.height - 1);
  assert.ok(bottom > top, `newest row (bottom ${bottom}) should be brighter than oldest (top ${top})`);
});

test('stop releases the microphone and clears the display', async () => {
  const harness = createHarness();
  harness.load();
  await harness.click('toggle');
  for (let i = 0; i < 3; i++) harness.step(2000 + i * 16);

  await harness.click('toggle');

  assert.ok(harness.trackStopped, 'microphone track should be stopped');
  assert.ok(harness.state.lastContext.closed, 'audio context should be closed');
  assert.match(harness.el('status').textContent, /released/);
  assert.equal(harness.el('toggle').textContent, 'Start Sampling');
  assert.equal(harness.el('toggle').disabled, false);

  const text = harness.canvas('spectrogramCanvas').context.calls.fillText.map((call) => call.text).join(' | ');
  assert.match(text, /Start Sampling/);
});

test('permission denial is reported and leaves the page idle', async () => {
  const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const harness = createHarness({ micError: error });
  harness.load();

  await harness.click('toggle');
  await harness.settle();

  assert.match(harness.el('status').textContent, /blocked/);
  assert.ok(harness.el('status').classList.contains('error'));
  assert.equal(harness.el('toggle').textContent, 'Start Sampling');
  assert.equal(harness.el('toggle').disabled, false);
  assert.ok(harness.state.lastContext.closed);
  assert.deepEqual(harness.errors, []);
});

test('toggles update labels and re-render without errors', async () => {
  const harness = createHarness();
  harness.load();

  await harness.click('toggleScale');
  assert.equal(harness.el('spectrumLabel').textContent, 'Frequency Spectrum — Log Frequency');
  assert.equal(harness.el('toggleScale').getAttribute('aria-pressed'), 'true');

  harness.step(3000);

  await harness.click('toggleWindow');
  assert.equal(harness.el('toggleWindow').textContent, 'Window: Hamming');

  await harness.click('toggleSmooth');
  assert.equal(harness.el('toggleSmooth').textContent, 'Smooth: On');

  await harness.click('toggleOscilloscope');
  assert.equal(harness.el('oscilloscopePanel').classList.contains('show'), true);
  assert.equal(harness.el('toggleOscilloscope').textContent, 'Hide Oscilloscope');
  harness.step(3010);

  await harness.click('toggleOscilloscopeScale');
  assert.equal(harness.el('toggleOscilloscopeScale').textContent, 'Scope: Log');
  harness.step(3020);

  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.state.consoleErrors, []);
});

test('resizing refits the backing store', async () => {
  const harness = createHarness();
  harness.load();
  const spectrum = harness.canvas('spectrumCanvas');

  spectrum.clientWidth = 480;
  harness.dispatchWindow('resize');
  harness.step(4000);

  assert.equal(spectrum.width, 960);
  assert.equal(spectrum.width / spectrum.clientWidth, 2);
});

test('visibility changes pause and resume the render loop', async () => {
  const harness = createHarness();
  harness.load();
  await harness.click('toggle');
  harness.step(2000);
  assert.ok(harness.state.queue.size > 0, 'loop should be scheduled');

  harness.document.hidden = true;
  harness.dispatchDocument('visibilitychange');
  assert.equal(harness.state.queue.size, 0, 'hidden page should cancel the frame');

  harness.document.hidden = false;
  harness.dispatchDocument('visibilitychange');
  assert.ok(harness.state.queue.size > 0, 'visible page should resume the loop');
  harness.step(2016);
  assert.deepEqual(harness.errors, []);
});

test('oscilloscope trace stays inside its canvas', async () => {
  const harness = createHarness();
  harness.load();
  await harness.click('toggleOscilloscope');
  await harness.click('toggle');
  for (let i = 0; i < 4; i++) harness.step(2000 + i * 16);

  const scope = harness.canvas('oscilloscopeCanvas');
  const points = scope.context.calls.moveTo.concat(scope.context.calls.lineTo);
  assert.ok(points.length > 100, 'trace should have many points');
  for (const [x, y] of points) {
    assert.ok(x >= 0 && x <= 800, `x ${x} outside canvas`);
    assert.ok(y >= 0 && y <= 150, `y ${y} outside canvas`);
  }
  assert.deepEqual(harness.errors, []);
});

test('falls back to plain audio when processing constraints are rejected', async () => {
  const error = Object.assign(new Error('constraint'), { name: 'OverconstrainedError' });
  const harness = createHarness({ micError: error, micErrorOnce: true });
  harness.load();

  await harness.click('toggle');
  await harness.settle();

  assert.match(harness.el('status').textContent, /Sampling/);
  assert.equal(harness.el('toggle').textContent, 'Stop Sampling');
  assert.deepEqual(harness.errors, []);
});

test('can restart after stopping', async () => {
  const harness = createHarness();
  harness.load();

  await harness.click('toggle');
  harness.step(2000);
  await harness.click('toggle');
  assert.ok(harness.trackStopped);

  await harness.click('toggle');
  harness.step(3000);
  harness.step(3016);

  assert.match(harness.el('toggle').textContent, /Stop Sampling/);
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.state.consoleErrors, []);
});
