// ==UserScript==
// @name         +Sub ASS 字幕调试工具
// @namespace    plussub-ass-debug
// @version      1.0.0
// @description  ASS/SSA 字幕特效渲染调试工具 - 支持 Prime Video 特化 & SubtitlesOctopus WASM 渲染
// @author       plussub
// @match        https://www.primevideo.com/*
// @match        https://www.amazon.com/*/video/*
// @match        https://www.amazon.co.jp/*/video/*
// @match        https://www.amazon.co.uk/*/video/*
// @match        https://www.amazon.de/*/video/*
// @match        https://*/*
// @require      https://cdn.jsdelivr.net/npm/libass-wasm@4.1.0/dist/js/subtitles-octopus.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // Constants
  // ═══════════════════════════════════════════════════════════════════════════
  const EXTENSION_ORIGIN = 'plussub';
  const SCRIPT_PREFIX = 'plussub-ass-debug';
  const WORKER_URL = 'https://cdn.jsdelivr.net/npm/libass-wasm@4.1.0/dist/js/subtitles-octopus-worker.js';
  const LEGACY_WORKER_URL = 'https://cdn.jsdelivr.net/npm/libass-wasm@4.1.0/dist/js/subtitles-octopus-worker-legacy.js';
  const DEFAULT_FONT_URL = 'https://cdn.jsdelivr.net/npm/libass-wasm@4.1.0/dist/default.woff2';

  // ═══════════════════════════════════════════════════════════════════════════
  // Platform Adapters
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Platform adapter interface.
   * Each adapter knows how to find the video element, the fullscreen container,
   * and how to hide/restore native subtitles for a specific streaming platform.
   */
  class GenericAdapter {
    get name() { return 'Generic'; }

    /**
     * Check if this adapter should be used for the current page.
     */
    match() {
      return true; // fallback
    }

    /**
     * Find the primary video element on the page.
     * @returns {HTMLVideoElement|null}
     */
    findVideo() {
      const videos = document.querySelectorAll('video');
      if (videos.length === 0) return null;
      // Prefer the largest visible video
      let best = null;
      let bestArea = 0;
      videos.forEach(v => {
        const rect = v.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea && rect.width > 0 && rect.height > 0) {
          best = v;
          bestArea = area;
        }
      });
      return best || videos[0];
    }

    /**
     * Get the container element to append the canvas overlay to.
     * Should be the closest positioned ancestor of the video, or the video's parent.
     * @param {HTMLVideoElement} video
     * @returns {HTMLElement}
     */
    getOverlayContainer(video) {
      return video.parentElement || document.body;
    }

    /**
     * Hide native/platform subtitles.
     * @param {HTMLVideoElement} video
     */
    hideNativeSubtitles(video) {
      if (video.textTracks) {
        [...video.textTracks].forEach(track => {
          if (track.mode === 'showing') {
            track._previousMode = 'showing';
            track.mode = 'hidden';
          }
        });
      }
    }

    /**
     * Restore native subtitles.
     * @param {HTMLVideoElement} video
     */
    restoreNativeSubtitles(video) {
      if (video.textTracks) {
        [...video.textTracks].forEach(track => {
          if (track._previousMode) {
            track.mode = track._previousMode;
            delete track._previousMode;
          }
        });
      }
    }

    /**
     * Called when the adapter is activated. Setup platform-specific observers.
     */
    onActivate() {}

    /**
     * Called when the adapter is deactivated. Cleanup.
     */
    onDeactivate() {}
  }

  /**
   * Prime Video specific adapter.
   * Handles Shadow DOM traversal, fullscreen container detection,
   * and native subtitle hiding for Amazon Prime Video.
   */
  class PrimeVideoAdapter extends GenericAdapter {
    constructor() {
      super();
      this._observer = null;
      this._nativeSubtitleStyle = null;
    }

    get name() { return 'Prime Video'; }

    match() {
      const hostname = location.hostname;
      const pathname = location.pathname;
      return (
        hostname.includes('primevideo.com') ||
        (hostname.includes('amazon.') && pathname.includes('/video/'))
      );
    }

    /**
     * Traverse Shadow DOM to find video elements.
     * Prime Video may nest video inside shadow roots.
     */
    findVideo() {
      // First try direct query
      let video = document.querySelector('video');
      if (video) return video;

      // Traverse shadow DOMs
      video = this._findVideoInShadowDOM(document.body);
      return video;
    }

    _findVideoInShadowDOM(root) {
      if (!root) return null;
      const video = root.querySelector('video');
      if (video) return video;

      // Check shadow roots of all elements
      const elements = root.querySelectorAll('*');
      for (const el of elements) {
        if (el.shadowRoot) {
          const found = this._findVideoInShadowDOM(el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    /**
     * Prime Video fullscreen container detection.
     * The player uses specific container classes for fullscreen.
     */
    getOverlayContainer(video) {
      // Try known Prime Video container selectors (may change over time)
      const selectors = [
        '.webPlayerSDKContainer',
        '.cascadesContainer',
        '.atvwebplayersdk-overlays-container',
        '.atvwebplayersdk-player-container',
        '[data-testid="web-player-container"]',
        '.rendererContainer'
      ];

      for (const selector of selectors) {
        const container = document.querySelector(selector);
        if (container) {
          debugLog('PrimeVideo', `Using container: ${selector}`);
          return container;
        }
      }

      // Fallback: walk up from video to find a reasonably-sized container
      let el = video.parentElement;
      while (el && el !== document.body) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.5) {
          debugLog('PrimeVideo', `Using fallback container: ${el.tagName}.${el.className}`);
          return el;
        }
        el = el.parentElement;
      }

      return video.parentElement || document.body;
    }

    hideNativeSubtitles(video) {
      super.hideNativeSubtitles(video);

      // Prime Video renders subtitles via its own DOM elements, not TextTrack
      // Inject CSS to hide them
      if (!this._nativeSubtitleStyle) {
        this._nativeSubtitleStyle = document.createElement('style');
        this._nativeSubtitleStyle.id = `${SCRIPT_PREFIX}-hide-native-subs`;
        this._nativeSubtitleStyle.textContent = `
          /* Hide Prime Video native subtitle overlays */
          .atvwebplayersdk-captions-text,
          .atvwebplayersdk-captions-overlay,
          [class*="subtitles"],
          [class*="captions"] {
            display: none !important;
          }
        `;
        document.head.appendChild(this._nativeSubtitleStyle);
      }
    }

    restoreNativeSubtitles(video) {
      super.restoreNativeSubtitles(video);
      if (this._nativeSubtitleStyle) {
        this._nativeSubtitleStyle.remove();
        this._nativeSubtitleStyle = null;
      }
    }

    onActivate() {
      debugLog('PrimeVideo', 'Adapter activated');
    }

    onDeactivate() {
      if (this._nativeSubtitleStyle) {
        this._nativeSubtitleStyle.remove();
        this._nativeSubtitleStyle = null;
      }
      debugLog('PrimeVideo', 'Adapter deactivated');
    }
  }

  // Adapter registry - order matters, first match wins
  const ADAPTERS = [
    new PrimeVideoAdapter(),
    new GenericAdapter()
  ];

  function getAdapter() {
    for (const adapter of ADAPTERS) {
      if (adapter.match()) {
        return adapter;
      }
    }
    return ADAPTERS[ADAPTERS.length - 1]; // GenericAdapter fallback
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Debug Logger
  // ═══════════════════════════════════════════════════════════════════════════

  const LOG_BUFFER = [];
  const MAX_LOG_ENTRIES = 200;

  function debugLog(category, message, level = 'info') {
    const entry = {
      time: new Date().toISOString().substr(11, 12),
      category,
      message,
      level
    };
    LOG_BUFFER.push(entry);
    if (LOG_BUFFER.length > MAX_LOG_ENTRIES) LOG_BUFFER.shift();

    const prefix = `[${SCRIPT_PREFIX}][${category}]`;
    if (level === 'error') {
      console.error(prefix, message);
    } else if (level === 'warn') {
      console.warn(prefix, message);
    } else {
      console.log(prefix, message);
    }

    // Update debug panel log if visible
    updateLogDisplay();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ASS Renderer (SubtitlesOctopus Wrapper)
  // ═══════════════════════════════════════════════════════════════════════════

  let octopusInstance = null;
  let currentVideo = null;
  let currentAdapter = null;
  let currentAssText = null;
  let offsetMs = 0;
  let renderStats = { fps: 0, lastFrameTime: 0, frameCount: 0, lastSecond: 0 };
  let workerBlobUrl = null;
  let legacyWorkerBlobUrl = null;

  /**
   * Mount ASS subtitle renderer on a video element.
   * @param {HTMLVideoElement} video
   * @param {string} assText - Raw ASS/SSA file content
   * @param {object} adapter - Platform adapter
   */
  async function mountRenderer(video, assText, adapter) {
    unmountRenderer();

    currentVideo = video;
    currentAdapter = adapter;
    currentAssText = assText;

    debugLog('Renderer', 'Mounting SubtitlesOctopus...');

    try {
      // Hide native subtitles
      adapter.hideNativeSubtitles(video);

      const workerUrls = await getWorkerUrls();
      const options = {
        video: video,
        subContent: assText,
        workerUrl: workerUrls.workerUrl,
        legacyWorkerUrl: workerUrls.legacyWorkerUrl,
        // Use available fonts + default fallback
        availableFonts: { 'liberation sans': DEFAULT_FONT_URL },
        fallbackFont: 'liberation sans',
        // Performance settings
        timeOffset: offsetMs / 1000,
        // Rendering settings
        lossyRender: false,
        // Debug
        debug: false,
        // Canvas rendering target - let SubtitlesOctopus manage it
        targetFps: 30,
        // Event callbacks
        onReady: () => {
          debugLog('Renderer', 'SubtitlesOctopus ready');
          updateDebugPanel();
        },
        onError: (error) => {
          debugLog('Renderer', `SubtitlesOctopus error: ${error}`, 'error');
        }
      };

      // SubtitlesOctopus (from @require) is available as a global
      if (typeof SubtitlesOctopus !== 'undefined') {
        octopusInstance = new SubtitlesOctopus(options);
        debugLog('Renderer', 'SubtitlesOctopus instance created');
      } else {
        debugLog('Renderer', 'SubtitlesOctopus not loaded! Check @require.', 'error');
        return;
      }

      // Setup FPS counter
      startFpsCounter();

      // Listen for fullscreen changes to readjust overlay
      document.addEventListener('fullscreenchange', handleFullscreenChange);
      video.addEventListener('webkitfullscreenchange', handleFullscreenChange);

      updateDebugPanel();
      debugLog('Renderer', `Mounted on <video> (${video.videoWidth}x${video.videoHeight})`);

    } catch (err) {
      debugLog('Renderer', `Mount error: ${err.message}`, 'error');
    }
  }

  async function getWorkerUrls() {
    if (!workerBlobUrl) {
      workerBlobUrl = await createWorkerBlobUrl(WORKER_URL);
      debugLog('Renderer', 'Worker loaded through Tampermonkey blob URL');
    }
    if (!legacyWorkerBlobUrl) {
      legacyWorkerBlobUrl = await createWorkerBlobUrl(LEGACY_WORKER_URL);
      debugLog('Renderer', 'Legacy worker loaded through Tampermonkey blob URL');
    }
    return {
      workerUrl: workerBlobUrl,
      legacyWorkerUrl: legacyWorkerBlobUrl
    };
  }

  function createWorkerBlobUrl(url) {
    return requestText(url).then((source) => {
      const wasmBaseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      const locateFilePatch = `
        var Module = typeof Module !== 'undefined' ? Module : {};
        Module.locateFile = function(path) {
          if (path.endsWith('.wasm')) return '${wasmBaseUrl}' + path;
          return path;
        };
      `;
      const patchedSource = `${locateFilePatch}\n${source}`;
      return URL.createObjectURL(new Blob([patchedSource], { type: 'application/javascript' }));
    });
  }

  function requestText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'undefined') {
        reject(new Error('GM_xmlhttpRequest is unavailable'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'text',
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText);
          } else {
            reject(new Error(`Failed to load ${url}: HTTP ${response.status}`));
          }
        },
        onerror: () => reject(new Error(`Failed to load ${url}`)),
        ontimeout: () => reject(new Error(`Timed out loading ${url}`))
      });
    });
  }

  function unmountRenderer() {
    if (octopusInstance) {
      try {
        octopusInstance.dispose();
      } catch (e) {
        debugLog('Renderer', `Dispose error: ${e.message}`, 'warn');
      }
      octopusInstance = null;
    }

    if (currentAdapter && currentVideo) {
      currentAdapter.restoreNativeSubtitles(currentVideo);
    }

    document.removeEventListener('fullscreenchange', handleFullscreenChange);

    currentVideo = null;
    currentAssText = null;
    stopFpsCounter();

    debugLog('Renderer', 'Unmounted');
    updateDebugPanel();
  }

  function setTimeOffset(ms) {
    offsetMs = ms;
    if (octopusInstance) {
      octopusInstance.timeOffset = ms / 1000;
      debugLog('Renderer', `Time offset set to ${ms}ms`);
    }
    updateDebugPanel();
  }

  function handleFullscreenChange() {
    if (octopusInstance && currentVideo) {
      // SubtitlesOctopus should auto-resize, but force a resize event
      setTimeout(() => {
        if (octopusInstance && octopusInstance.resize) {
          octopusInstance.resize();
          debugLog('Renderer', 'Resized after fullscreen change');
        }
      }, 300);
    }
  }

  // FPS counter
  let fpsInterval = null;
  function startFpsCounter() {
    renderStats = { fps: 0, lastFrameTime: 0, frameCount: 0, lastSecond: Date.now() };
    fpsInterval = setInterval(() => {
      const now = Date.now();
      renderStats.fps = Math.round(renderStats.frameCount / ((now - renderStats.lastSecond) / 1000));
      renderStats.frameCount = 0;
      renderStats.lastSecond = now;
      updateFpsDisplay();
    }, 1000);
  }

  function stopFpsCounter() {
    if (fpsInterval) clearInterval(fpsInterval);
    fpsInterval = null;
    renderStats.fps = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // File Loading (Drag & Drop + File Dialog)
  // ═══════════════════════════════════════════════════════════════════════════

  function setupDragDrop() {
    const overlay = document.createElement('div');
    overlay.id = `${SCRIPT_PREFIX}-drop-overlay`;
    overlay.innerHTML = `
      <div style="
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.7);
        display: none; align-items: center; justify-content: center;
        font-family: 'Segoe UI', system-ui, sans-serif;
        pointer-events: none;
      ">
        <div style="
          border: 3px dashed rgba(91,192,222,0.8); border-radius: 20px;
          padding: 60px 80px; text-align: center;
          background: rgba(91,192,222,0.05);
          backdrop-filter: blur(8px);
        ">
          <div style="font-size: 48px; margin-bottom: 16px;">🎬</div>
          <div style="color: #5bc0de; font-size: 22px; font-weight: 600;">拖放 ASS/SSA 字幕文件到此处</div>
          <div style="color: rgba(255,255,255,0.5); font-size: 14px; margin-top: 8px;">支持 .ass / .ssa 格式</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const overlayInner = overlay.firstElementChild;

    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) {
        overlayInner.style.display = 'flex';
        overlayInner.style.pointerEvents = 'auto';
      }
    });

    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        overlayInner.style.display = 'none';
        overlayInner.style.pointerEvents = 'none';
      }
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      overlayInner.style.display = 'none';
      overlayInner.style.pointerEvents = 'none';

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        handleFile(files[0]);
      }
    });

    debugLog('DragDrop', 'Drag & drop handler ready');
  }

  function handleFile(file) {
    const validExts = ['.ass', '.ssa'];
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

    if (!validExts.includes(ext)) {
      debugLog('FileLoad', `Invalid file type: ${ext}. Expected .ass or .ssa`, 'warn');
      showToast(`不支持的文件格式: ${ext}`, 'warn');
      return;
    }

    debugLog('FileLoad', `Loading: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      debugLog('FileLoad', `File loaded: ${text.length} chars`);

      const adapter = getAdapter();
      const video = adapter.findVideo();

      if (!video) {
        debugLog('FileLoad', 'No video element found on page!', 'error');
        showToast('未找到视频元素！请确保页面上有正在播放的视频。', 'error');
        return;
      }

      debugLog('FileLoad', `Using adapter: ${adapter.name}`);
      mountRenderer(video, text, adapter);
      showToast(`✅ 字幕已加载: ${file.name}`);
    };
    reader.onerror = () => {
      debugLog('FileLoad', 'File read error', 'error');
    };
    reader.readAsText(file);
  }

  function openFileDialog() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ass,.ssa';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      if (input.files.length > 0) {
        handleFile(input.files[0]);
      }
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Toast Notifications
  // ═══════════════════════════════════════════════════════════════════════════

  function showToast(message, type = 'info') {
    const colors = {
      info: { bg: 'rgba(91,192,222,0.95)', text: '#fff' },
      warn: { bg: 'rgba(240,173,78,0.95)', text: '#fff' },
      error: { bg: 'rgba(217,83,79,0.95)', text: '#fff' }
    };
    const color = colors[type] || colors.info;

    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position: 'fixed',
      top: '20px',
      left: '50%',
      transform: 'translateX(-50%) translateY(-20px)',
      background: color.bg,
      color: color.text,
      padding: '12px 24px',
      borderRadius: '8px',
      fontSize: '14px',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      fontWeight: '500',
      zIndex: '100001',
      boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
      backdropFilter: 'blur(10px)',
      opacity: '0',
      transition: 'all 0.3s ease'
    });
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(-20px)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Debug Panel UI
  // ═══════════════════════════════════════════════════════════════════════════

  let debugPanelVisible = false;
  let debugPanelEl = null;

  function createDebugPanel() {
    if (debugPanelEl) return;

    debugPanelEl = document.createElement('div');
    debugPanelEl.id = `${SCRIPT_PREFIX}-panel`;

    debugPanelEl.innerHTML = `
      <div id="${SCRIPT_PREFIX}-panel-inner" style="
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 380px;
        max-height: 520px;
        background: rgba(18, 18, 24, 0.95);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(91,192,222,0.3);
        border-radius: 12px;
        color: #e0e0e0;
        font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
        font-size: 13px;
        z-index: 100000;
        overflow: hidden;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        display: none;
      ">
        <!-- Header -->
        <div id="${SCRIPT_PREFIX}-header" style="
          padding: 12px 16px;
          background: linear-gradient(135deg, rgba(91,192,222,0.15), rgba(91,192,222,0.05));
          border-bottom: 1px solid rgba(91,192,222,0.2);
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: move;
          user-select: none;
        ">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 16px;">🎬</span>
            <span style="font-weight: 600; color: #5bc0de;">+Sub ASS Debug</span>
            <span id="${SCRIPT_PREFIX}-adapter-badge" style="
              background: rgba(91,192,222,0.2);
              color: #5bc0de;
              padding: 2px 8px;
              border-radius: 4px;
              font-size: 11px;
            ">--</span>
          </div>
          <div style="display: flex; gap: 8px;">
            <button id="${SCRIPT_PREFIX}-btn-minimize" style="
              background: none; border: none; color: #888; cursor: pointer;
              font-size: 16px; padding: 0 4px; line-height: 1;
            " title="最小化">─</button>
            <button id="${SCRIPT_PREFIX}-btn-close" style="
              background: none; border: none; color: #888; cursor: pointer;
              font-size: 16px; padding: 0 4px; line-height: 1;
            " title="关闭">✕</button>
          </div>
        </div>

        <!-- Status Bar -->
        <div style="padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <span style="color: #888;">状态：</span>
              <span id="${SCRIPT_PREFIX}-status" style="color: #f0ad4e;">未加载</span>
            </div>
            <div>
              <span style="color: #888;">FPS：</span>
              <span id="${SCRIPT_PREFIX}-fps" style="color: #5cb85c; font-variant-numeric: tabular-nums;">--</span>
            </div>
          </div>
          <div style="margin-top: 6px;">
            <span style="color: #888;">Video：</span>
            <span id="${SCRIPT_PREFIX}-video-info" style="color: #aaa;">--</span>
          </div>
        </div>

        <!-- Controls -->
        <div style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);">
          <!-- File actions -->
          <div style="display: flex; gap: 8px; margin-bottom: 12px;">
            <button id="${SCRIPT_PREFIX}-btn-load" style="
              flex: 1; padding: 8px; border: 1px solid rgba(91,192,222,0.4);
              background: rgba(91,192,222,0.1); color: #5bc0de;
              border-radius: 6px; cursor: pointer; font-size: 13px;
              transition: all 0.2s;
            ">📂 加载字幕</button>
            <button id="${SCRIPT_PREFIX}-btn-unload" style="
              flex: 1; padding: 8px; border: 1px solid rgba(217,83,79,0.4);
              background: rgba(217,83,79,0.1); color: #d9534f;
              border-radius: 6px; cursor: pointer; font-size: 13px;
              transition: all 0.2s;
            ">🗑️ 卸载字幕</button>
          </div>

          <!-- Time offset -->
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span style="color: #888;">时间偏移：</span>
              <span id="${SCRIPT_PREFIX}-offset-value" style="color: #5bc0de; font-variant-numeric: tabular-nums;">0.0s</span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <button id="${SCRIPT_PREFIX}-btn-offset-minus" style="
                width: 32px; height: 28px; border: 1px solid rgba(255,255,255,0.15);
                background: rgba(255,255,255,0.05); color: #ccc;
                border-radius: 4px; cursor: pointer; font-size: 14px;
              ">−</button>
              <input id="${SCRIPT_PREFIX}-offset-slider" type="range"
                min="-10000" max="10000" value="0" step="100"
                style="flex: 1; accent-color: #5bc0de; height: 4px;">
              <button id="${SCRIPT_PREFIX}-btn-offset-plus" style="
                width: 32px; height: 28px; border: 1px solid rgba(255,255,255,0.15);
                background: rgba(255,255,255,0.05); color: #ccc;
                border-radius: 4px; cursor: pointer; font-size: 14px;
              ">+</button>
              <button id="${SCRIPT_PREFIX}-btn-offset-reset" style="
                padding: 4px 10px; height: 28px; border: 1px solid rgba(255,255,255,0.15);
                background: rgba(255,255,255,0.05); color: #ccc;
                border-radius: 4px; cursor: pointer; font-size: 12px;
              ">重置</button>
            </div>
          </div>
        </div>

        <!-- Event Log -->
        <div style="padding: 8px 16px 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: #888; font-size: 12px;">📋 事件日志</span>
            <button id="${SCRIPT_PREFIX}-btn-clear-log" style="
              background: none; border: none; color: #666; cursor: pointer; font-size: 11px;
            ">清空</button>
          </div>
        </div>
        <div id="${SCRIPT_PREFIX}-log" style="
          max-height: 150px;
          overflow-y: auto;
          padding: 4px 16px 12px;
          font-family: 'Cascadia Code', 'Consolas', monospace;
          font-size: 11px;
          line-height: 1.6;
          scrollbar-width: thin;
          scrollbar-color: rgba(91,192,222,0.3) transparent;
        "></div>
      </div>
    `;

    document.body.appendChild(debugPanelEl);

    // Wire up events
    const panel = debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-panel-inner`);

    // Close button
    debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-btn-close`).addEventListener('click', () => {
      toggleDebugPanel(false);
    });

    // Minimize button
    debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-btn-minimize`).addEventListener('click', () => {
      const log = debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-log`);
      log.style.display = log.style.display === 'none' ? '' : 'none';
    });

    // Load button
    debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-btn-load`).addEventListener('click', openFileDialog);

    // Unload button
    debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-btn-unload`).addEventListener('click', unmountRenderer);

    // Offset slider
    const slider = debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-offset-slider`);
    slider.addEventListener('input', () => {
      const ms = parseInt(slider.value);
      setTimeOffset(ms);
      debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-offset-value`).textContent = `${(ms / 1000).toFixed(1)}s`;
    });

    // Offset buttons
    debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-btn-offset-minus`).addEventListener('click', () => {
      slider.value = Math.max(-10000, parseInt(slider.value) - 500);
      slider.dispatchEvent(new Event('input'));
    });
    debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-btn-offset-plus`).addEventListener('click', () => {
      slider.value = Math.min(10000, parseInt(slider.value) + 500);
      slider.dispatchEvent(new Event('input'));
    });
    debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-btn-offset-reset`).addEventListener('click', () => {
      slider.value = 0;
      slider.dispatchEvent(new Event('input'));
    });

    // Clear log
    debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-btn-clear-log`).addEventListener('click', () => {
      LOG_BUFFER.length = 0;
      debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-log`).innerHTML = '';
    });

    // Make panel draggable
    makeDraggable(panel, debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-header`));

    // Hover effects for buttons
    debugPanelEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.8'; });
      btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
    });

    debugLog('UI', 'Debug panel created');
  }

  function toggleDebugPanel(show) {
    if (!debugPanelEl) createDebugPanel();
    const panel = debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-panel-inner`);
    debugPanelVisible = show !== undefined ? show : !debugPanelVisible;
    panel.style.display = debugPanelVisible ? 'block' : 'none';
    if (debugPanelVisible) updateDebugPanel();
  }

  function updateDebugPanel() {
    if (!debugPanelEl || !debugPanelVisible) return;

    const adapter = getAdapter();
    const badge = debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-adapter-badge`);
    if (badge) badge.textContent = adapter.name;

    const statusEl = debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-status`);
    if (statusEl) {
      if (octopusInstance) {
        statusEl.textContent = '渲染中';
        statusEl.style.color = '#5cb85c';
      } else {
        statusEl.textContent = '未加载';
        statusEl.style.color = '#f0ad4e';
      }
    }

    const videoInfo = debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-video-info`);
    if (videoInfo) {
      const video = adapter.findVideo();
      if (video) {
        videoInfo.textContent = `${video.videoWidth}x${video.videoHeight} | ${video.paused ? '暂停' : '播放中'} | ${formatTime(video.currentTime)}`;
      } else {
        videoInfo.textContent = '未检测到视频';
      }
    }
  }

  function updateFpsDisplay() {
    if (!debugPanelEl || !debugPanelVisible) return;
    const fpsEl = debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-fps`);
    if (fpsEl) {
      fpsEl.textContent = octopusInstance ? `${renderStats.fps}` : '--';
    }
  }

  function updateLogDisplay() {
    if (!debugPanelEl || !debugPanelVisible) return;
    const logEl = debugPanelEl.querySelector(`#${SCRIPT_PREFIX}-log`);
    if (!logEl) return;

    // Only show last 50 entries in the panel
    const recentLogs = LOG_BUFFER.slice(-50);
    logEl.innerHTML = recentLogs.map(entry => {
      const colors = { info: '#8a8a8a', warn: '#f0ad4e', error: '#d9534f' };
      const color = colors[entry.level] || colors.info;
      return `<div style="color: ${color};">
        <span style="color: #555;">${entry.time}</span>
        <span style="color: #5bc0de;">[${entry.category}]</span>
        ${escapeHtml(entry.message)}
      </div>`;
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Extension Bridge (postMessage communication)
  // ═══════════════════════════════════════════════════════════════════════════

  function setupExtensionBridge() {
    window.addEventListener('message', (event) => {
      if (event.data?.extensionOrigin !== EXTENSION_ORIGIN) return;

      const msg = event.data;

      // Read-only diagnostics bridge for Codex/browser automation.
      // Keep this intentionally narrow: no arbitrary eval/selector mutation here.
      if (msg.contentScriptInput === 'DEBUG_REQUEST') {
        handleDebugRequest(msg);
      }

      // Listen for ASS subtitle data from the extension
      if (msg.contentScriptInput === 'ADD_ASS_SUBTITLE') {
        debugLog('Bridge', 'Received ASS subtitle from extension');
        const adapter = getAdapter();
        const video = adapter.findVideo();
        if (video && msg.assText) {
          mountRenderer(video, msg.assText, adapter);
        }
      }

      // Listen for time offset changes from extension
      if (msg.contentScriptInput === 'SET_ASS_OFFSET') {
        debugLog('Bridge', `Offset from extension: ${msg.offsetMs}ms`);
        setTimeOffset(msg.offsetMs || 0);
      }

      // Listen for unmount command
      if (msg.contentScriptInput === 'REMOVE_ASS_SUBTITLE') {
        debugLog('Bridge', 'Unmount command from extension');
        unmountRenderer();
      }
    });

    debugLog('Bridge', 'Extension bridge ready');
  }

  function handleDebugRequest(msg) {
    const command = msg.command;

    try {
      const result = getDebugResult(command, msg.payload || {});
      window.postMessage({
        extensionOrigin: EXTENSION_ORIGIN,
        contentScriptOutput: 'DEBUG_RESPONSE',
        requestId: msg.requestId,
        command,
        ok: true,
        result
      }, '*');
    } catch (err) {
      window.postMessage({
        extensionOrigin: EXTENSION_ORIGIN,
        contentScriptOutput: 'DEBUG_RESPONSE',
        requestId: msg.requestId,
        command,
        ok: false,
        error: err?.message || String(err)
      }, '*');
    }
  }

  function getDebugResult(command, payload) {
    switch (command) {
      case 'GET_PAGE_INFO':
        return getPageInfo();
      case 'GET_VIDEO_INFO':
        return getVideoInfo();
      case 'GET_LOGS':
        return LOG_BUFFER.slice(-(payload.limit || 50));
      case 'GET_RENDERER_STATS':
        return {
          ...renderStats,
          isRendering: !!octopusInstance,
          hasSubtitle: !!currentAssText,
          offsetMs
        };
      case 'SHOW_PANEL':
        toggleDebugPanel(true);
        return { visible: true };
      case 'HIDE_PANEL':
        toggleDebugPanel(false);
        return { visible: false };
      default:
        throw new Error(`Unsupported debug command: ${command}`);
    }
  }

  function getPageInfo() {
    const adapter = getAdapter();
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      fullscreen: !!document.fullscreenElement,
      adapter: adapter.name,
      debugPanelVisible,
      apiVersion: window.__plussubAssDebug?.version || 'unknown'
    };
  }

  function getVideoInfo() {
    const adapter = getAdapter();
    const selectedVideo = adapter.findVideo();
    const videos = Array.from(document.querySelectorAll('video'));

    return {
      adapter: adapter.name,
      selectedIndex: selectedVideo ? videos.indexOf(selectedVideo) : -1,
      videos: videos.map((video, index) => {
        const rect = video.getBoundingClientRect();
        return {
          index,
          currentTime: video.currentTime,
          duration: video.duration,
          paused: video.paused,
          muted: video.muted,
          volume: video.volume,
          playbackRate: video.playbackRate,
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          },
          textTracks: Array.from(video.textTracks || []).map((track) => ({
            label: track.label,
            language: track.language,
            kind: track.kind,
            mode: track.mode
          }))
        };
      })
    };
  }

  /**
   * Expose API on window for extension or console debugging.
   */
  function exposeDebugAPI() {
    window.__plussubAssDebug = {
      mount: (assText) => {
        const adapter = getAdapter();
        const video = adapter.findVideo();
        if (video) mountRenderer(video, assText, adapter);
        else debugLog('API', 'No video found', 'error');
      },
      unmount: unmountRenderer,
      setOffset: setTimeOffset,
      getAdapter: () => getAdapter().name,
      findVideo: () => getAdapter().findVideo(),
      showPanel: () => toggleDebugPanel(true),
      hidePanel: () => toggleDebugPanel(false),
      getLogs: () => [...LOG_BUFFER],
      getStats: () => ({ ...renderStats, isRendering: !!octopusInstance }),
      version: '1.0.0'
    };
    debugLog('API', 'Debug API exposed: window.__plussubAssDebug');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function makeDraggable(element, handle) {
    let isDragging = false;
    let startX, startY, startRight, startBottom;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = element.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      element.style.right = `${Math.max(0, startRight - dx)}px`;
      element.style.bottom = `${Math.max(0, startBottom - dy)}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Video monitoring - periodically update panel info
  // ═══════════════════════════════════════════════════════════════════════════

  function startVideoMonitor() {
    setInterval(() => {
      updateDebugPanel();

      // Track FPS for SubtitlesOctopus rendering
      if (octopusInstance) {
        renderStats.frameCount++;
      }
    }, 1000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    const adapter = getAdapter();
    debugLog('Init', `Platform detected: ${adapter.name}`);
    debugLog('Init', `URL: ${location.href}`);

    // Setup all modules
    setupDragDrop();
    setupExtensionBridge();
    exposeDebugAPI();
    createDebugPanel();
    startVideoMonitor();

    // Register Tampermonkey menu commands
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand('🎬 打开调试面板', () => toggleDebugPanel(true));
      GM_registerMenuCommand('📂 加载 ASS 字幕', openFileDialog);
      GM_registerMenuCommand('🗑️ 卸载字幕', unmountRenderer);
    }

    // Auto-show panel on Prime Video
    if (adapter instanceof PrimeVideoAdapter) {
      adapter.onActivate();
      debugLog('Init', 'Prime Video adapter activated, panel auto-shown');
      // Delay panel show to let page settle
      setTimeout(() => toggleDebugPanel(true), 2000);
    }

    debugLog('Init', '+Sub ASS Debug Tool ready ✅');
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
