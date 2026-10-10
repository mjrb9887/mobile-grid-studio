const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

// A small DOM fixture exercises pointer handlers and save state without a browser.
function app() {
  const nodes = new Map(), timers = new Map(), frames = [], draws = [], reads = [], canvases = [];
  let nextTimer = 0, shareCount = 0, downloadCount = 0, revoked = 0, hits = [];
  class Element {
    constructor(tag = 'div') {
      this.tag = tag; this.style = {}; this.dataset = {}; this.children = [];
      this.events = {}; this.attributes = {}; this.value = ''; this.textContent = '';
      this.clientWidth = 200; this.clientHeight = 200; this.naturalWidth = 1000; this.naturalHeight = 500;
      const classes = new Set();
      this.classList = { add: (...v) => v.forEach(x => classes.add(x)), remove: (...v) => v.forEach(x => classes.delete(x)), contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) };
    }
    set className(value) { this.classList.add(...value.split(' ')); }
    set innerHTML(value) { this.children = []; }
    appendChild(el) { this.children.push(el); }
    setAttribute(k, v) { this.attributes[k] = v; }
    removeAttribute(k) { delete this.attributes[k]; }
    querySelector(sel) { return sel === 'img' ? this.children.find(el => el.tag === 'img') : null; }
    addEventListener(event, fn) { this.events[event] = fn; }
    insertAdjacentHTML() {}
    focus() {}
    remove() {}
    click() { if (this.tag === 'a') downloadCount++; this.events.click?.({}); }
    setPointerCapture() {}
    contains(el) { return this.children.includes(el); }
    fire(event, extra = {}) { this.events[event]?.({ type: event, pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 100, preventDefault() {}, ...extra }); }
    getContext() { return new Proxy({ drawImage: (...args) => draws.push(args), measureText: text => ({ width: text.length * 10 }) }, { get: (target, key) => target[key] || (() => {}) }); }
    toBlob(cb, type) { cb(new Blob(['pixels'], { type })); }
  }
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  }
  node('#exportType').value = 'image/jpeg'; node('#exportQuality').value = '.94';
  node('#exportWidth').value = node('#exportHeight').value = '1080'; node('#gapBg').checked = true;
  const navigator = { maxTouchPoints: 1, canShare: () => true, share: async () => { shareCount++; } };
  const context = vm.createContext({
    console: { error() {} }, Blob, File, structuredClone,
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: () => revoked++ }, navigator,
    window: { matchMedia: () => ({ matches: true }) },
    document: {
      querySelector: node,
      querySelectorAll: selector => selector === '.cell' ? node('#grid').children : [],
      createElement: tag => { const el = new Element(tag); if (tag === 'canvas') canvases.push(el); return el; }, body: new Element(), activeElement: node('#mobileExport'),
      elementsFromPoint: () => hits, addEventListener() {}
    },
    Image: class { constructor() { this.naturalWidth = 1000; this.naturalHeight = 500; } set src(value) { this.onload(); } },
    FileReader: class { readAsDataURL(file) { reads.push(() => this.onload({ target: { result: file.src } })); } },
    requestAnimationFrame: cb => frames.push(cb),
    setTimeout: cb => { timers.set(++nextTimer, cb); return nextTimer; }, clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(source.slice(0, source.indexOf("if('serviceWorker'in navigator)")), context);
  const run = code => vm.runInContext(code, context);
  function ready() { run("state.images=[{src:'first',zoom:1,x:50,y:50,rotate:0,fit:'cover',flip:false},{src:'second',zoom:1,x:50,y:50},null];state.selected=0;renderGrid();updateControls()"); }
  return { node, run, context, navigator, draws, reads, canvases, timers, ready, hits: value => { hits = value; }, shares: () => shareCount, downloads: () => downloadCount, revoked: () => revoked };
}

test('dragging the selected photo changes its crop without swapping or rebuilding the cell', () => {
  const a = app(); a.ready(); const cell = a.node('#grid').children[0];
  cell.fire('pointerdown'); cell.fire('pointermove', { clientX: 120 }); cell.fire('pointerup', { clientX: 120 });
  assert.equal(a.run('state.images[0].x'), 40);
  assert.equal(a.run('state.images[0].src'), 'first');
  assert.equal(a.node('#grid').children[0], cell);
  assert.equal(a.node('#mobileExport').disabled, true);
});

test('unselected photos permit page scrolling until tapped', () => {
  const a = app(); a.ready(); const cell = a.node('#grid').children[1];
  cell.fire('pointerdown'); cell.fire('pointermove', { clientX: 150 }); cell.fire('pointerup');
  assert.equal(a.run('state.images[1].x'), 50);
  cell.fire('click'); assert.equal(a.run('state.selected'), 1);
  assert.equal(cell.classList.contains('editing'), true);
});

test('pinch zoom clamps at 4x, cleans up cancellation, and accepts a later drag', () => {
  const a = app(); a.ready(); const cell = a.node('#grid').children[0];
  cell.fire('pointerdown', { clientX: 90 }); cell.fire('pointerdown', { pointerId: 2, clientX: 110 });
  cell.fire('pointermove', { pointerId: 2, clientX: 210 }); assert.equal(a.run('state.images[0].zoom'), 4);
  cell.fire('pointercancel', { pointerId: 2 }); cell.fire('pointercancel');
  const old = a.run('state.images[0].x');
  cell.fire('pointerdown'); cell.fire('pointermove', { clientX: 120 }); cell.fire('pointerup');
  assert(a.run('state.images[0].x') < old);
});

test('Reorder supports drag into an empty slot, and cancellation never swaps', () => {
  const a = app(); a.ready(); a.node('#swapBtn').onclick();
  let cells = a.node('#grid').children; a.hits([cells[2]]);
  cells[0].fire('pointerdown'); cells[0].fire('pointermove', { clientX: 150 }); cells[0].fire('pointercancel');
  assert.equal(a.run('state.images[0].src'), 'first'); assert.equal(a.run('state.images[2]'), null);
  cells[0].fire('pointerdown'); cells[0].fire('pointermove', { clientX: 150 }); cells[0].fire('pointerup', { clientX: 150 });
  assert.equal(a.run('state.images[0]'), null); assert.equal(a.run('state.images[2].src'), 'first');
  assert.equal(a.run('state.swapMode'), true);
});

test('tap-to-swap updates the displayed cells and keeps explicit Reorder mode active', () => {
  const a = app(); a.ready(); a.node('#swapBtn').onclick();
  a.run('handleCellTap(0);handleCellTap(1)');
  assert.equal(a.run('state.images[0].src'), 'second');
  assert.equal(a.node('#grid').children[0].querySelector('img').src, 'second');
  assert.equal(a.run('state.swapMode'), true);
});

test('rotation preview and export use equivalent dimensions and position', () => {
  const a = app(); a.ready(); a.node('#rotateBtn').onclick();
  const img = a.node('#grid').children[0].querySelector('img');
  a.run("paintPhoto(grid.children[0],state.images[0])");
  assert.equal(img.style.width, '400px'); assert.equal(img.style.height, '200px');
  assert.match(img.style.transform, /rotate\(90deg\)/);
  a.run("drawItem(document.createElement('canvas').getContext('2d'),{naturalWidth:1000,naturalHeight:500},0,0,200,200,state.images[0])");
  assert.deepEqual(a.draws[0].slice(1), [-200, -100, 400, 200]);
  a.node('#rotateLeftBtn').onclick(); assert.equal(a.run('state.images[0].rotate'), 0);
  a.run('state.images[0].zoom=3;state.images[0].flip=true'); a.node('#resetPhotoBtn').onclick();
  assert.equal(a.run('state.images[0].zoom'), 1); assert.equal(a.run('state.images[0].flip'), false);
});

test('import fills empty slots without overwriting existing photos', () => {
  const a = app(); a.ready(); a.run("state.images[1]=null;addFiles([{src:'new1'},{src:'new2'}])");
  a.reads.forEach(fn => fn()); assert.equal(a.run('state.images[0].src'), 'first');
  assert.equal(a.run('state.images[1].src'), 'new1'); assert.equal(a.run('state.images[2].src'), 'new2');
});

test('quick save follows canvas ratio and opens the native share sheet with no app export sheet', async () => {
  const a = app(); a.ready(); a.run("state.ratio='9:16'");
  await a.run('prepareQuickSave(quickRevision)');
  assert.equal(a.node('#mobileExport').disabled, false);
  await a.node('#mobileExport').onclick();
  assert.equal(a.shares(), 1);
  assert.equal(a.node('#saveSheet').classList.contains('open'), false);
  assert.equal(a.node('#settingsSheet').classList.contains('open'), false);
  assert.equal(a.canvases[0].width, 1215); assert.equal(a.canvases[0].height, 2160);
});

test('editing invalidates a cached save and stale preparation cannot become ready', async () => {
  const a = app(); a.ready();
  a.context.release = null;
  a.run("buildCanvas=()=>new Promise(resolve=>{release=resolve});canvasBlob=async()=>new Blob(['pixels'],{type:'image/jpeg'})");
  const pending = a.run('prepareQuickSave(quickRevision)');
  a.run('invalidateQuickSave();release({})'); await pending;
  assert.equal(a.run('quickFile'), null); assert.equal(a.node('#mobileExport').disabled, true);
});

test('share cancellation keeps the canvas, unsupported sharing offers a fallback, desktop downloads', async () => {
  const a = app(); a.ready(); await a.run('prepareQuickSave(quickRevision)');
  a.navigator.share = async () => { throw Object.assign(new Error(), { name: 'AbortError' }); };
  await a.run('quickSave()'); assert.equal(a.node('#saveSheet').classList.contains('open'), false);
  assert.equal(a.node('#mobileExport').disabled, false);
  a.navigator.canShare = () => false; await a.run('quickSave()');
  assert.equal(a.node('#saveSheet').classList.contains('open'), true);
  a.node('#closeSave').onclick(); assert.equal(a.revoked(), 1);
  a.context.window.matchMedia = () => ({ matches: false }); a.navigator.maxTouchPoints = 0;
  await a.run('quickSave()'); assert.equal(a.downloads(), 1);
});

test('save encoding failure allows a retry', async () => {
  const a = app(); a.ready(); a.run("buildCanvas=async()=>{throw new Error('encoding failed')}");
  await a.run('prepareQuickSave(quickRevision)');
  assert.equal(a.node('#mobileExport').disabled, false); assert.equal(a.node('#mobileExport').textContent, 'Retry save');
  a.node('#mobileExport').onclick(); assert.equal(a.node('#mobileExport').disabled, true);
});

test('export snapshots protect photo and overlay content from edits during rendering', async () => {
  const a = app(); a.ready();
  a.context.loaded = [];
  a.run("loadImage=src=>new Promise(resolve=>loaded.push(()=>resolve({src,naturalWidth:1000,naturalHeight:500})));state.overlays=[{type:'image',src:'overlay',size:30}]");
  const render = a.run('buildCanvas()');
  a.run("state.images[0].src='changed';state.images[0].rotate=90;state.overlays=[];loaded.splice(0).forEach(fn=>fn())");
  await Promise.resolve(); await Promise.resolve();
  a.run('loaded.splice(0).forEach(fn=>fn())'); await render;
  assert.equal(a.draws[0][0].src, 'first');
  assert.equal(a.draws[a.draws.length-1][0].src, 'overlay');
});

test('a small movement in Reorder leaves Save ready and on-canvas Done restores page scrolling', async () => {
  const a = app(); a.ready(); a.node('#swapBtn').onclick(); await a.run('prepareQuickSave(quickRevision)');
  const cell = a.node('#grid').children[0];
  cell.fire('pointerdown'); cell.fire('pointermove', { clientX: 102 }); cell.fire('pointerup', { clientX: 102 });
  assert.equal(a.node('#mobileExport').disabled, false);
  a.node('#canvasDone').onclick(); assert.equal(a.run('state.swapMode'), false);
  assert.equal(cell.classList.contains('reordering'), false);
  assert.equal(cell.classList.contains('editing'), false);
});
