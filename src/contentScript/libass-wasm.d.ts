declare module 'libass-wasm' {
  type SubtitlesOctopusOptions = {
    video: HTMLVideoElement;
    subContent: string;
    workerUrl: string;
    legacyWorkerUrl?: string;
    availableFonts?: Record<string, string>;
    fallbackFont?: string;
    timeOffset?: number;
    targetFps?: number;
    renderMode?: 'wasm-blend' | 'js-blend' | 'lossy';
    debug?: boolean;
    onReady?: () => void;
    onError?: (error: unknown) => void;
  };

  export default class SubtitlesOctopus {
    canvasParent?: HTMLElement;
    canvas?: HTMLCanvasElement;
    timeOffset: number;

    constructor(options: SubtitlesOctopusOptions);
    dispose(): void;
    resize?(): void;
    render?(time: number): void;
  }
}
