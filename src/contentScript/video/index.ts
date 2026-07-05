import { filter, map, mergeMap, share, tap } from 'rxjs/operators';
import { from, fromEvent, merge, Observable } from 'rxjs';
import { create as createVideoElementMutationObservable } from './videoElementMutationObservable';
import { findVideoElementsDeep } from './findVideoElements';
import { postMessage } from '../postMessage';
import { EXTENSION_LABEL, EXTENSION_ORIGIN, GenericContentScriptInputMessageEvent } from '../types';
import { unmountAssSubtitle } from '../assRenderer';
import { nanoid } from 'nanoid';

interface Payload {
  inputObservable: Observable<GenericContentScriptInputMessageEvent>;
}

const datasetExtensionId = `${EXTENSION_ORIGIN}Id` as const;
const datasetExtensionStatus = `${EXTENSION_ORIGIN}Status` as const;
type HTMLVideoElementWithDataExtensionId =  HTMLVideoElement & {
  dataset: {
    [datasetExtensionId]: string
  }
}

const hasSubtitle = (el: HTMLVideoElement) => el.dataset[datasetExtensionStatus] === 'injected' || [...el.textTracks].find((track) => track.label === EXTENSION_LABEL && track.mode !== 'disabled') !== undefined;
const getVisibleArea = (el: HTMLVideoElement) => {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect.width * rect.height : 0;
};
const getVideoCandidates = () => {
  const videos = findVideoElementsDeep().filter((el): el is HTMLVideoElementWithDataExtensionId => Boolean(el.dataset[datasetExtensionId]));
  const visibleVideos = videos.filter((el) => getVisibleArea(el) > 0);
  return (visibleVideos.length > 0 ? visibleVideos : videos).sort((a, b) => getVisibleArea(b) - getVisibleArea(a));
};

export const init = ({ inputObservable }: Payload): Observable<unknown> => {
  const currentQuerySelectorObservable = from(findVideoElementsDeep());
  const videoElementMutationObservable = createVideoElementMutationObservable().pipe(share());
  const addedWithMutationObservable = videoElementMutationObservable.pipe(
    filter(({ added }) => added.length > 0),
    mergeMap(({ added }) => from(added))
  );

  const loadedmetadataObservable = merge(currentQuerySelectorObservable, addedWithMutationObservable).pipe(
    mergeMap((el) => fromEvent(el, 'loadedmetadata')),
    map((event) => event.target as HTMLVideoElement)
  );

  const addedVideoObservable = merge(currentQuerySelectorObservable, addedWithMutationObservable, loadedmetadataObservable).pipe(
    tap((el) => {
      el.dataset[datasetExtensionId] = el.dataset[datasetExtensionId] || nanoid(12);
      el.dataset[datasetExtensionStatus] = el.dataset[datasetExtensionStatus] || "none";
    }),
    tap((el) =>
      postMessage({
        contentScriptOutput: 'VIDEO_UPDATE',
        origin: window.location.origin,
        state: "add",
        video: {
          id: el.dataset[datasetExtensionId]
        }
      })
    )
  );

  const removedVideoElementObservable = videoElementMutationObservable.pipe(
    mergeMap(({ removed }) => from(removed)),
    tap((el) => {
      postMessage({
        contentScriptOutput: 'VIDEO_UPDATE',
        origin: window.location.origin,
        state: "removed",
        video: {
          id: el.dataset[datasetExtensionId]
        }
      })
    })
  );



  const screenshotFn = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    return (el: HTMLVideoElement) => {
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp');
      } catch (e) {
        console.warn(e);
        return fallbackScreenshot;
      }
    };
  })();

  const fallbackScreenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
  const findVideosInputObservable = inputObservable.pipe(
    filter((e) => e.data.contentScriptInput === 'FIND_VIDEOS_REQUEST'),
    map((e) => ({
      origin: window.location.origin,
      requestId: e.data.requestId,
      videos: Object.fromEntries<{ id: string; hasSubtitle: boolean; origin: string }>(
        getVideoCandidates().map((el) => [
          el.dataset[datasetExtensionId],
          {
            id: el.dataset[datasetExtensionId],
            hasSubtitle: hasSubtitle(el),
            origin: window.location.origin,
            lastTimestamp: Math.floor(el.currentTime * 1000),
            screenshot: screenshotFn(el),
            status: el.dataset[datasetExtensionStatus]
          }
        ])
      )
    })),
    tap(({ videos, origin, requestId }) =>
      postMessage({
        contentScriptOutput: 'FIND_VIDEOS_RESPONSE',
        origin,
        requestId,
        videos
      })
    )
  );

  const selectVideoInputObservable = inputObservable.pipe(
    filter((e) => e.data.contentScriptInput === 'SELECT_VIDEO'),
    tap((e) =>
      findVideoElementsDeep().forEach((el) => {
        el.dataset[datasetExtensionStatus] = el.dataset[datasetExtensionId] === e.data.id ? 'selected' : 'none';
      })
    )
  );

  const deselectVideoInputObservable = inputObservable.pipe(
    filter((e) => e.data.contentScriptInput === 'DESELECT_VIDEO'),
    tap(() => {
      unmountAssSubtitle();
      findVideoElementsDeep().forEach((el) => {
        el.dataset[datasetExtensionStatus] = 'none';
        const track = [...el.textTracks].find((track) => track.label === EXTENSION_LABEL && track.mode !== "disabled");
        if(track){
          track.mode = "disabled";
        }
      });
    })
  );

  return merge(
    addedVideoObservable,
    removedVideoElementObservable,
    findVideosInputObservable,
    selectVideoInputObservable,
    deselectVideoInputObservable
  );
};
