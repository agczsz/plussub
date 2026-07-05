import SubtitlesOctopus from 'libass-wasm';
import { EXTENSION_ORIGIN } from './types';

let renderer: SubtitlesOctopus | null = null;
let currentVideo: HTMLVideoElement | null = null;
let positionInterval: number | null = null;
let workerBlobUrl: string | null = null;
let legacyWorkerBlobUrl: string | null = null;
let lastCanvasRectKey = '';
let canvasReadbackHintPatched = false;
let currentOffsetSeconds = 0;

const fontUrl = (fileName: string) => chrome.runtime.getURL(`fonts/${fileName}`);
const libassUrl = (fileName: string) => chrome.runtime.getURL(`libass-wasm/${fileName}`);
const regularCjkFont = fontUrl('msyh.ttc');
const boldCjkFont = fontUrl('msyhbd.ttc');

const patchCanvasReadbackHint = () => {
  if (canvasReadbackHintPatched) return;

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function patchedGetContext(type: string, attributes?: CanvasRenderingContext2DSettings) {
    if (type === '2d') {
      return originalGetContext.call(this, type, {
        ...(attributes ?? {}),
        willReadFrequently: attributes?.willReadFrequently ?? true
      });
    }
    return originalGetContext.call(this, type, attributes);
  } as HTMLCanvasElement['getContext'];

  canvasReadbackHintPatched = true;
};

const createFontMap = () => {
  const regularFontNames = [
    'arial',
    'roboto',
    'liberation sans',
    'microsoft yahei',
    '\u5fae\u8f6f\u96c5\u9ed1',
    '\u65b9\u6b63\u5170\u4ead\u5706_gbk_\u7ec6',
    'fot-udmarugo_large pr6n m',
    'stfkul65',
    'eeeawh3c',
    'zzm4th86',
    't8jvmhse',
    'tsuggdi3',
    '17joqcbk',
    '9scc59bt'
  ];
  const boldFontNames = ['60iqm5yd'];

  return {
    ...Object.fromEntries(regularFontNames.map((name) => [name, regularCjkFont])),
    ...Object.fromEntries(boldFontNames.map((name) => [name, boldCjkFont]))
  };
};

const createWorkerBlobUrl = async (fileName: string) => {
  const workerUrl = libassUrl(fileName);
  const source = await fetch(workerUrl).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load ${workerUrl}: HTTP ${response.status}`);
    }
    return response.text();
  });
  const locateFilePatch = `
    var Module = typeof Module !== 'undefined' ? Module : {};
    Module.locateFile = function(path) {
      if (path.endsWith('.wasm')) return '${libassUrl('subtitles-octopus-worker.wasm')}';
      return path;
    };
  `;

  return URL.createObjectURL(new Blob([locateFilePatch, source], { type: 'application/javascript' }));
};

const getWorkerUrls = async () => {
  if (!workerBlobUrl) workerBlobUrl = await createWorkerBlobUrl('subtitles-octopus-worker.js');
  if (!legacyWorkerBlobUrl) legacyWorkerBlobUrl = await createWorkerBlobUrl('subtitles-octopus-worker-legacy.js');

  return {
    workerUrl: workerBlobUrl,
    legacyWorkerUrl: legacyWorkerBlobUrl
  };
};

const getFullscreenElement = (): HTMLElement | null => {
  const doc = document as Document & {
    webkitFullscreenElement?: Element;
    mozFullScreenElement?: Element;
    msFullscreenElement?: Element;
  };
  const element = document.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement;
  return element instanceof HTMLElement ? element : null;
};

const getOverlayHost = () => getFullscreenElement() || document.body;

const getRectRelativeToHost = (rect: DOMRect, host: HTMLElement) => {
  if (host === document.body) {
    return {
      position: 'fixed',
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    };
  }

  const hostRect = host.getBoundingClientRect();
  return {
    position: 'absolute',
    top: rect.top - hostRect.top,
    left: rect.left - hostRect.left,
    width: rect.width,
    height: rect.height
  };
};

const renderCurrentFrame = () => {
  if (!renderer || !currentVideo) return;
  renderer.render?.(currentVideo.currentTime + currentOffsetSeconds);
};

const updateCanvasPosition = (force = false) => {
  if (!renderer || !currentVideo?.isConnected) return;

  const parent = renderer.canvasParent;
  const rect = currentVideo.getBoundingClientRect();
  if (!parent || rect.width <= 0 || rect.height <= 0) return;

  const host = getOverlayHost();
  if (parent.parentNode !== host) {
    host.appendChild(parent);
    force = true;
  }

  const overlayRect = getRectRelativeToHost(rect, host);
  const rectKey = `${host === document.body ? 'body' : 'fullscreen'}:${Math.round(overlayRect.top)}:${Math.round(overlayRect.left)}:${Math.round(overlayRect.width)}:${Math.round(overlayRect.height)}`;
  const shouldResize = force || rectKey !== lastCanvasRectKey;
  lastCanvasRectKey = rectKey;

  Object.assign(parent.style, {
    position: overlayRect.position,
    top: `${overlayRect.top}px`,
    left: `${overlayRect.left}px`,
    width: `${overlayRect.width}px`,
    height: `${overlayRect.height}px`
  });

  if (shouldResize) {
    renderer.resize?.();
    window.requestAnimationFrame(renderCurrentFrame);
  }
};

const applyCanvasStyle = (instance: SubtitlesOctopus) => {
  const parent = instance.canvasParent;
  const canvas = instance.canvas;

  if (parent) {
    Object.assign(parent.style, {
      pointerEvents: 'none',
      zIndex: '2147483647',
      display: 'block',
      isolation: 'isolate'
    });
  }

  if (canvas) {
    Object.assign(canvas.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      pointerEvents: 'none'
    });
  }

  updateCanvasPosition(true);
};

const forceRefresh = () => {
  updateCanvasPosition(true);
  window.setTimeout(() => updateCanvasPosition(true), 100);
  window.setTimeout(renderCurrentFrame, 250);
};

const addRefreshListeners = () => {
  document.addEventListener('fullscreenchange', forceRefresh);
  document.addEventListener('webkitfullscreenchange', forceRefresh);
  document.addEventListener('visibilitychange', forceRefresh);
  window.addEventListener('focus', forceRefresh);
  window.addEventListener('pageshow', forceRefresh);
  currentVideo?.addEventListener('playing', forceRefresh);
  currentVideo?.addEventListener('seeked', forceRefresh);
  currentVideo?.addEventListener('loadedmetadata', forceRefresh);
};

const removeRefreshListeners = () => {
  document.removeEventListener('fullscreenchange', forceRefresh);
  document.removeEventListener('webkitfullscreenchange', forceRefresh);
  document.removeEventListener('visibilitychange', forceRefresh);
  window.removeEventListener('focus', forceRefresh);
  window.removeEventListener('pageshow', forceRefresh);
  currentVideo?.removeEventListener('playing', forceRefresh);
  currentVideo?.removeEventListener('seeked', forceRefresh);
  currentVideo?.removeEventListener('loadedmetadata', forceRefresh);
};

export const unmountAssSubtitle = () => {
  removeRefreshListeners();

  if (positionInterval !== null) {
    window.clearInterval(positionInterval);
    positionInterval = null;
  }

  if (renderer) {
    if (renderer.canvasParent && currentVideo?.parentNode && renderer.canvasParent.parentNode !== currentVideo.parentNode) {
      currentVideo.parentNode.appendChild(renderer.canvasParent);
    }
    renderer.dispose();
    renderer = null;
  }

  currentVideo = null;
  lastCanvasRectKey = '';
  currentOffsetSeconds = 0;
};

export const mountAssSubtitle = async ({ video, assText, offsetMs }: { video: HTMLVideoElement; assText: string; offsetMs: number }) => {
  unmountAssSubtitle();

  patchCanvasReadbackHint();
  currentVideo = video;
  currentOffsetSeconds = offsetMs / 1000;
  const workerUrls = await getWorkerUrls();

  renderer = new SubtitlesOctopus({
    video,
    subContent: assText,
    workerUrl: workerUrls.workerUrl,
    legacyWorkerUrl: workerUrls.legacyWorkerUrl,
    fallbackFont: regularCjkFont,
    availableFonts: createFontMap(),
    timeOffset: currentOffsetSeconds,
    targetFps: 30,
    renderMode: 'wasm-blend',
    debug: false,
    onReady: () => {
      if (renderer) {
        applyCanvasStyle(renderer);
        forceRefresh();
      }
      video.dataset[`${EXTENSION_ORIGIN}Status`] = 'injected';
    },
    onError: (error) => {
      console.error('[plussub][ass]', error);
    }
  });

  applyCanvasStyle(renderer);
  addRefreshListeners();
  positionInterval = window.setInterval(updateCanvasPosition, 250);
  forceRefresh();
};

export const resizeAssSubtitle = () => {
  updateCanvasPosition(true);
};

export const isAssMountedOn = (video: HTMLVideoElement) => currentVideo === video;
