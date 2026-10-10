const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

// A small DOM fixture exercises pointer handlers and save state without a browser.
function app() {
  const nodes = new Map(), timers = new Map(), frames = [], draws = [], reads = [], canvases = [], textDraws = [];
  const windowEvents={};
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
    appendChild(el) { this.children.push(el); el.parent = this; }
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
    closest(selector) { return selector === '.cell' && this.classList.contains('cell') ? this : this.parent?.closest(selector); }
    fire(event, extra = {}) { const input = { type: event, target: this, pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 100, preventDefault() {}, ...extra }; this.events[event]?.(input); this.parent?.fire(event, input); }
    getContext() { return new Proxy({ drawImage: (...args) => draws.push(args), fillText: (...args) => textDraws.push(args), measureText: text => ({ width: text.length * 10 }) }, { get: (target, key) => target[key] || (() => {}) }); }
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
    window: { matchMedia: query => ({ matches: query !== '(display-mode: standalone)' }), addEventListener: (event,handler)=>windowEvents[event]=handler },
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
  return { windowEvents, node, run, context, navigator, draws, textDraws, reads, canvases, timers, ready, hits: value => { hits = value; }, shares: () => shareCount, downloads: () => downloadCount, revoked: () => revoked };
}

test('dragging the selected photo changes its crop without swapping or rebuilding the cell', () => {
  const a = app(); a.ready(); const cell = a.node('#grid').children[0];
  cell.fire('pointerdown'); cell.fire('pointermove', { clientX: 120 }); cell.fire('pointerup', { clientX: 120 });
  assert.equal(a.run('state.images[0].x'), 40);
  assert.equal(a.run('state.images[0].src'), 'first');
  assert.equal(a.node('#grid').children[0], cell);
  assert.equal(a.node('#mobileExport').disabled, true);
});

test('first touch selects and drags an unselected photo without a separate selection tap', () => {
  const a = app(); a.ready(); const cell = a.node('#grid').children[1];
  cell.fire('pointerdown'); cell.fire('pointermove', { clientX: 120 }); cell.fire('pointerup');
  assert.equal(a.run('state.images[1].x'), 40);
  assert.equal(a.run('state.selected'), 1);
  assert.equal(cell.classList.contains('editing'), true);
});

test('Done restores canvas scrolling and a tap re-enters editing', () => {
  const a = app(); a.ready(); a.node('#canvasDone').onclick();
  const cell = a.node('#grid').children[1];
  assert.equal(a.node('#grid').classList.contains('photo-editing'), false);
  cell.fire('pointerdown'); cell.fire('pointermove', { clientX: 150 }); cell.fire('pointerup');
  assert.equal(a.run('state.images[1].x'), 50);
  cell.fire('click'); assert.equal(a.run('state.selected'), 1);
  assert.equal(a.node('#grid').classList.contains('photo-editing'), true);
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

test('a pinch spanning different slots zooms the first touched photo, leaving the second unchanged', () => {
  const a = app(); a.ready(); const [first, second] = a.node('#grid').children;
  first.fire('pointerdown', { clientX: 90 }); second.fire('pointerdown', { pointerId: 2, clientX: 110 });
  second.fire('pointermove', { pointerId: 2, clientX: 150 });
  assert.equal(a.run('state.images[0].zoom'), 3); assert.equal(a.run('state.images[1].zoom'), 1);
  second.fire('pointerup', { pointerId: 2 }); first.fire('pointerup'); second.fire('click');
  assert.equal(a.run('state.selected'), 0);
});

test('Reorder taps swap even if prevented pointer events produce no native click', () => {
  const a = app(); a.ready(); a.node('#swapBtn').onclick();
  let first = a.node('#grid').children[0]; first.fire('pointerdown'); first.fire('pointerup');
  let second = a.node('#grid').children[1]; second.fire('pointerdown'); second.fire('pointerup');
  assert.equal(a.run('state.images[0].src'), 'second'); assert.equal(a.run('state.images[1].src'), 'first');
});

test('success notification appears only after native sharing resolves', async () => {
  const a = app(); a.ready(); await a.run('prepareQuickSave(quickRevision)');
  let complete; a.navigator.share = () => new Promise(resolve => { complete = resolve; });
  const saving = a.run('quickSave()'); assert.notEqual(a.node('#toast').dataset.kind, 'success');
  complete(); await saving;
  assert.equal(a.node('#toast').textContent, 'Image shared successfully.');
  assert.equal(a.node('#toast').dataset.kind, 'success');
  assert.equal(a.node('#toast').attributes['aria-live'], 'polite');
});

test('share errors show an error notification without opening another export screen', async () => {
  const a = app(); a.ready(); await a.run('prepareQuickSave(quickRevision)');
  a.navigator.share = async () => { throw Object.assign(new Error(), {name: 'DataError'}); };
  await a.run('quickSave()');
  assert.equal(a.node('#toast').dataset.kind, 'error');
  assert.match(a.node('#toast').textContent, /Could not share/);
  assert.equal(a.node('#toast').attributes['aria-live'], 'assertive');
  assert.equal(a.node('#saveSheet').classList.contains('open'), false);
  assert.equal(a.node('#mobileExport').disabled, false);
  a.navigator.share = async () => { throw Object.assign(new Error(), {name: 'AbortError'}); };
  await a.run('quickSave()');
  assert.match(a.node('#toast').textContent, /cancelled/); assert.equal(a.node('#toast').dataset.kind, 'info');
});

test('desktop download failure shows an error instead of a success notification', async () => {
  const a = app(); a.ready(); await a.run('prepareQuickSave(quickRevision)');
  a.context.window.matchMedia = () => ({matches: false}); a.navigator.maxTouchPoints = 0;
  a.context.document.createElement = () => { throw new Error('download unavailable'); };
  await a.run('quickSave()');
  assert.equal(a.node('#toast').dataset.kind, 'error'); assert.match(a.node('#toast').textContent, /Could not download/);
});

test('text export waits for the selected web font before drawing', async () => {
  const a = app(); let complete; let requestedFont;
  a.context.document.fonts = {load: font => { requestedFont = font; return new Promise(resolve => {complete = resolve;}); }};
  const rendering = a.run("drawOverlaysToCanvas(document.createElement('canvas').getContext('2d'),1080,1080,[{type:'text',font:'Playfair Display',weight:600,size:72,text:'Love'}])");
  assert.equal(requestedFont, '600 72px "Playfair Display"'); assert.equal(a.textDraws.length, 0);
  complete(); await rendering; assert.equal(a.textDraws[0][0], 'Love');
});

test('overlay opacity controls preserve transparent, partial and solid opacity in preview and export', async () => {
  const a = app();
  a.run("state.overlays=[{id:'text',type:'text',text:'Love',font:'DM Sans',weight:700,color:'#a12345',size:72}];state.selectedOverlay='text'");
  for (const [percent, alpha] of [[0,0],[45,.45],[100,1]]) {
    a.node('#overlayOpacity').oninput({target:{value:String(percent)}});
    assert.equal(a.node('#overlayLayer').children[0].style.opacity, alpha);
    assert.equal(a.node('#overlayOpacityValue').textContent, percent+'%');
    assert.equal(a.node('#overlayOpacity').attributes['aria-valuetext'], percent+'%');
    let drawn;
    const ctx = {save(){},restore(){},translate(){},rotate(){},measureText:()=>({width:20}),fillText(){drawn={alpha:this.globalAlpha,color:this.fillStyle};}};
    a.context.exportContext=ctx;
    await a.run('drawOverlaysToCanvas(exportContext,1080,1080)');
    assert.equal(drawn.alpha, alpha); assert.equal(drawn.color, '#a12345');
  }
});

test('script fonts use their available weight in preview and export', async () => {
  const a = app();
  a.run("state.overlays=[{id:'text',type:'text',text:'Love',font:'DM Sans',size:72,opacity:1}];state.selectedOverlay='text'");
  a.node('#overlayFont').onchange({target:{value:'Great Vibes'}});
  assert.equal(a.node('#overlayLayer').children[0].style.fontWeight, 400);
  let font;
  a.context.document.fonts={load:async value=>{font=value;}};
  await a.run("drawOverlaysToCanvas(document.createElement('canvas').getContext('2d'),1080,1080)");
  assert.equal(font,'400 72px "Great Vibes"');
});

test('filters and adjustments affect only the selected photo and invalidate its saved export', async () => {
  const a=app();a.ready();await a.run('prepareQuickSave(quickRevision)');
  a.node('#photoFilter').onchange({target:{value:'warm'}});
  a.node('#photoBrightness').oninput({target:{value:'125'}});
  assert.equal(a.run('state.images[0].filter'),'warm');assert.equal(a.run('state.images[0].brightness'),125);
  assert.equal(a.run('state.images[1].filter'),undefined);
  assert.match(a.node('#grid').children[0].querySelector('img').style.filter,/sepia\(0.22\)/);
  assert.equal(a.node('#photoBrightnessValue').textContent,'125%');assert.equal(a.node('#mobileExport').disabled,true);
  a.run('handleCellTap(1)');assert.equal(a.node('#photoBrightness').value,100);assert.equal(a.node('#photoFilter').value,'original');
});

test('reset edits preserves crop and rotation while clearing filters, and moving a photo preserves its edits',()=>{
  const a=app();a.ready();a.run("state.images[0].zoom=2;state.images[0].rotate=90;state.images[0].filter='vintage';state.images[0].saturation=40");
  a.node('#resetPhotoEdits').onclick();assert.equal(a.run('state.images[0].zoom'),2);assert.equal(a.run('state.images[0].rotate'),90);
  assert.equal(a.run('state.images[0].saturation'),100);assert.equal(a.run('photoFilterCSS(state.images[0])'),'none');
  a.node('#photoFilter').onchange({target:{value:'vivid'}});a.node('#swapBtn').onclick();a.run('handleCellTap(0);handleCellTap(1)');
  assert.equal(a.run('state.images[1].filter'),'vivid');assert.equal(a.run('state.images[1].src'),'first');
});

test('pixel fallback preserves alpha and supports neutral, black-and-white and brightness adjustments',()=>{
  const a=app();a.context.pixels=new Uint8ClampedArray([200,100,50,80]);
  a.run('applyPhotoEffects(pixels,photoEffects({}))');assert.deepEqual([...a.context.pixels],[200,100,50,80]);
  a.run("applyPhotoEffects(pixels,photoEffects({filter:'mono'}))");
  const [r,g,b,alpha]=a.context.pixels;assert.equal(r,g);assert.equal(g,b);assert.equal(alpha,80);
  a.context.pixels=new Uint8ClampedArray([100,60,20,255]);a.run('applyPhotoEffects(pixels,photoEffects({brightness:150}))');
  assert.deepEqual([...a.context.pixels],[150,90,30,255]);
  assert.equal(a.run("photoFilterCSS({filter:'warm',filterStrength:0})"),'none');
});

test('export uses native canvas filters when available and restores them after drawing',()=>{
  const a=app();let applied,restored;const ctx={filter:'none',save(){restored=this.filter},restore(){this.filter=restored},beginPath(){},rect(){},clip(){},translate(){},rotate(){},scale(){},drawImage(){applied=this.filter}};
  a.context.effectContext=ctx;a.run("drawItem(effectContext,{naturalWidth:1000,naturalHeight:500},0,0,200,200,{filter:'warm'})");
  assert.match(applied,/sepia\(0.22\)/);assert.equal(ctx.filter,'none');
});

test('export processes photo pixels when native canvas filters are unavailable',()=>{
  const a=app();let processed,drawn;
  a.context.document.createElement=()=>({width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([100,60,20,255])}),putImageData(data){processed=[...data.data]}})});
  a.context.effectContext={save(){},restore(){},beginPath(){},rect(){},clip(){},translate(){},rotate(){},scale(){},drawImage(source){drawn=source}};
  a.run('drawItem(effectContext,{naturalWidth:1000,naturalHeight:500},0,0,200,200,{brightness:150})');
  assert.deepEqual(processed,[150,90,30,255]);assert.equal(drawn.width,400);assert.equal(drawn.height,200);
});

test('advanced adjustments are independent per photo, refresh values on selection, and reset without changing crop',()=>{
  const a=app();a.ready();a.run('state.images[0].zoom=2');
  a.node('#photoExposure').oninput({target:{value:'1'}});a.node('#photoShadows').oninput({target:{value:'35'}});
  assert.equal(a.run('state.images[0].exposure'),1);assert.equal(a.run('state.images[1].exposure'),undefined);
  assert.equal(a.node('#photoExposureValue').textContent,'1 EV');
  a.run('handleCellTap(1)');assert.equal(a.node('#photoExposure').value,0);
  a.run('handleCellTap(0)');a.node('#resetPhotoEdits').onclick();assert.equal(a.run('state.images[0].exposure'),0);assert.equal(a.run('state.images[0].zoom'),2);
});

test('exposure uses linear-light EVs and tone controls target shadows and highlights',()=>{
  const a=app();a.context.pixels=new Uint8ClampedArray([128,128,128,255]);
  a.run('applyPhotoEffects(pixels,photoEffects({exposure:1}))');assert.equal(a.context.pixels[0],176);
  a.context.pixels=new Uint8ClampedArray([20,20,20,255,220,220,220,255]);
  a.run('applyPhotoEffects(pixels,photoEffects({shadows:60}))');
  assert(a.context.pixels[0]-20>a.context.pixels[4]-220);assert.equal(a.context.pixels[3],255);
  a.context.pixels=new Uint8ClampedArray([20,20,20,255,220,220,220,255]);
  a.run('applyPhotoEffects(pixels,photoEffects({highlights:-60}))');assert(220-a.context.pixels[4]>20-a.context.pixels[0]);
});

test('warmth, sharpening and vignette process pixels while preserving alpha',()=>{
  const a=app();a.context.pixels=new Uint8ClampedArray([100,100,100,80]);
  a.run('applyPhotoEffects(pixels,photoEffects({temperature:50}))');assert(a.context.pixels[0]>a.context.pixels[2]);assert.equal(a.context.pixels[3],80);
  const pixels=new Uint8ClampedArray(36);for(let i=0;i<36;i+=4){pixels.set([100,100,100,255],i)}pixels.set([150,150,150,255],16);
  a.context.pixels=pixels;a.run('applyPhotoEffects(pixels,photoEffects({sharpness:50}),3,3)');assert(a.context.pixels[16]>150);
  a.context.pixels=new Uint8ClampedArray(36);for(let i=0;i<36;i+=4)a.context.pixels.set([120,120,120,255],i);
  a.run('applyPhotoEffects(pixels,photoEffects({vignette:100}),3,3)');assert(a.context.pixels[0]<a.context.pixels[16]);assert.equal(a.context.pixels[3],255);
});

test('advanced preset strength can be reduced to the unchanged original',()=>{
  const a=app();assert.equal(a.run("needsPixelEffects({filter:'cinematic'})"),true);
  assert.equal(a.run("needsPixelEffects({filter:'cinematic',filterStrength:0})"),false);
  assert.equal(a.run("photoFilterCSS({filter:'cinematic',filterStrength:0})"),'none');
});

test('holding compare displays the original without changing edits or the prepared save',async()=>{
  const a=app();a.ready();await a.run('prepareQuickSave(quickRevision)');a.run("state.images[0].filter='warm';paintPhoto(grid.children[0],state.images[0])");
  const cell=a.node('#grid').children[0],file=a.run('quickFile');
  a.node('#comparePhotoBtn').fire('pointerdown');assert.equal(cell.querySelector('img').style.filter,'none');
  assert.equal(a.run('state.images[0].filter'),'warm');assert.equal(a.run('quickFile'),file);
  a.node('#comparePhotoBtn').fire('pointercancel');assert.match(cell.querySelector('img').style.filter,/sepia/);
});

test('advanced preview and export use pixel processing even when native canvas filters are available',()=>{
  const a=app();a.ready();let processedCount=0;
  a.context.document.createElement=()=>({style:{},width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([100,100,100,255])}),putImageData(){processedCount++}})});
  a.run('state.images[0].temperature=40;paintPhoto(grid.children[0],state.images[0])');
  const cell=a.node('#grid').children[0];a.timers.get(cell._previewTimer)();
  assert.equal(processedCount,1);assert.equal(cell.querySelector('img').style.visibility,'hidden');assert(cell._photoPreview);
  a.context.effectContext={filter:'none',save(){},restore(){},beginPath(){},rect(){},clip(){},translate(){},rotate(){},scale(){},drawImage(){}};
  a.run('drawItem(effectContext,{naturalWidth:1000,naturalHeight:500},0,0,200,200,state.images[0])');
  assert.equal(processedCount,2);
});

test('hamburger menu opens Settings and About with the app version and closes correctly',()=>{
  const a=app();a.node('#appMenu').hidden=true;
  a.node('#menuBtn').onclick();assert.equal(a.node('#appMenu').hidden,false);assert.equal(a.node('#menuBtn').attributes['aria-expanded'],'true');
  a.node('#settingsBtn').onclick();assert.equal(a.node('#appMenu').hidden,true);assert(a.node('#settingsSheet').classList.contains('open'));
  a.node('#closeSettings').onclick();assert.equal(a.node('#settingsSheet').classList.contains('open'),false);
  a.node('#menuBtn').onclick();a.node('#aboutBtn').onclick();assert(a.node('#aboutSheet').classList.contains('open'));
  assert.equal(a.node('#aboutVersion').textContent,'Version 1.3.0');assert.equal(a.node('#menuVersion').textContent,'Version 1.3.0');
  a.node('#closeAbout').onclick();assert.equal(a.node('#aboutSheet').classList.contains('open'),false);
  a.node('#menuBtn').onclick();a.node('#menuBtn').onclick();assert.equal(a.node('#appMenu').hidden,true);
});


test('mobile photo selection opens the contextual editor and Done restores the page', () => {
  const a=app();a.ready();
  assert(a.run("document.body.classList.contains('photo-panel-open')"));
  a.node('#donePhotoBtn').onclick();
  assert.equal(a.run("document.body.classList.contains('photo-panel-open')"),false);
  assert.equal(a.node('#canvasStage').style.width,'');
  a.run('handleCellTap(1)');
  assert(a.run("document.body.classList.contains('photo-panel-open')"));
});
test('grouped photo tools show one adjustment while preserving edits across tabs', () => {
  const a=app();a.ready();a.node('#photoTabColor').onclick();
  assert.equal(a.node('#photoPanelAdjust').style.display,'block');
  assert.equal(a.node('#photoPanelCrop').style.display,'none');
  a.node('#photoAdjustmentPicker').onchange({target:{value:'Temperature'}});
  assert.equal(a.node('#fieldPhotoTemperature').style.display,'block');
  assert.equal(a.node('#fieldPhotoSaturation').style.display,'none');
  a.node('#photoTemperature').oninput({target:{value:'35'}});
  a.node('#photoTabFilters').onclick();a.node('#photoTabColor').onclick();
  assert.equal(a.run('state.images[0].temperature'),35);
});
test('mobile editor fits portrait and wide canvases between the header and bottom panel', () => {
  const a=app();a.ready();
  a.context.window.innerWidth=390;a.context.window.innerHeight=844;
  a.node('#appHeader').getBoundingClientRect=()=>({bottom:130});
  a.node('#imageControl').getBoundingClientRect=()=>({height:300});
  a.run("document.body.style.setProperty=function(key,value){this[key]=value};grid.style.aspectRatio='9/16';layoutMobilePhotoEditor()");
  assert.equal(a.node('#canvasStage').style.width,'217.125px');
  a.run("grid.style.aspectRatio='16/9';layoutMobilePhotoEditor()");
  assert.equal(a.node('#canvasStage').style.width,'354px');
});


test('install action invokes an available native prompt and offers instructions otherwise', async () => {
  const a=app();let prevented=false,prompted=0;
  a.windowEvents.beforeinstallprompt({preventDefault(){prevented=true},async prompt(){prompted++},userChoice:Promise.resolve({outcome:'accepted'})});
  assert(prevented);assert.equal(a.node('#installHint').textContent,'Install on this device');
  await a.node('#installBtn').onclick();assert.equal(prompted,1);
  await a.node('#installBtn').onclick();assert(a.node('#aboutSheet').classList.contains('open'));
});
test('new creative presets produce distinct edits and support zero strength', () => {
  const a=app();
  for(const name of ['rose','peach','moody','coastal','porcelain','espresso','retro','noir','silver','sunset']){
    const changed=a.run(`Array.from(applyPhotoEffects(new Uint8ClampedArray([80,130,180,128]),photoEffects({filter:'${name}'})))`);
    assert.notDeepEqual(changed.slice(0,3),[80,130,180]);assert.equal(changed[3],128);
    const neutral=a.run(`Array.from(applyPhotoEffects(new Uint8ClampedArray([80,130,180,128]),photoEffects({filter:'${name}',filterStrength:0})))`);
    assert.deepEqual(Array.from(neutral),[80,130,180,128]);
  }
});
test('whites and blacks target opposite tonal ranges, split tones affect color, grain is repeatable', () => {
  const a=app();
  const whites=a.run('Array.from(applyPhotoEffects(new Uint8ClampedArray([30,30,30,255,220,220,220,255]),photoEffects({whites:100})))');
  assert(whites[4]-220>whites[0]-30);
  const blacks=a.run('Array.from(applyPhotoEffects(new Uint8ClampedArray([30,30,30,255,220,220,220,255]),photoEffects({blacks:-100})))');
  assert(30-blacks[0]>220-blacks[4]);
  const warm=a.run('Array.from(applyPhotoEffects(new Uint8ClampedArray([50,50,50,100]),photoEffects({shadowTone:100})))');assert(warm[0]>warm[2]);assert.equal(warm[3],100);
  const code='Array.from(applyPhotoEffects(new Uint8ClampedArray([80,130,180,128,80,130,180,64]),photoEffects({grain:100})))';
  const grain=a.run(code);assert.deepEqual(grain,a.run(code));assert(grain[0]!==80||grain[4]!==80);assert.equal(grain[7],64);
});
