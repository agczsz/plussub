import {Observable} from "rxjs";
import { findVideoElementsInNodesDeep } from './findVideoElements';

const findVideoElement = (nodes: Node[]):HTMLVideoElement[] => {
  return findVideoElementsInNodesDeep(nodes);
};

const addedVideoElements = (mutationsList: MutationRecord[]): HTMLVideoElement[] => {
  return mutationsList.flatMap((mutation) => findVideoElement(Array.from(mutation.addedNodes)));
};

const removedVideoElements = (mutationsList: MutationRecord[]): HTMLVideoElement[] => {
  return mutationsList.flatMap((mutation) => findVideoElement(Array.from(mutation.removedNodes)));
};


export const create = (): Observable<{added: HTMLVideoElement[], removed: HTMLVideoElement[]}> => {
  return new Observable((subscriber) => {
    const mutationObserver = new MutationObserver((mutationsList) => {
      const added = addedVideoElements(mutationsList);
      const removed = removedVideoElements(mutationsList);
      if (added.length || removed.length) {
        subscriber.next({
          added,
          removed
        });
      }
    });
    mutationObserver.observe(document.body, { subtree: true, childList: true });
    return () => mutationObserver.disconnect();
  });
};
