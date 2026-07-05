import { isHTMLElement, isHTMLVideoElement } from '@/types';

type QueryRoot = Document | DocumentFragment | HTMLElement | ShadowRoot;

const collectElementsWithShadowRoots = (root: QueryRoot): HTMLElement[] => {
  const rootElement = root instanceof HTMLElement ? [root] : [];
  return [...rootElement, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
};

export const findVideoElementsDeep = (root: QueryRoot = document): HTMLVideoElement[] => {
  const videos = Array.from(root.querySelectorAll<HTMLVideoElement>('video'));

  return collectElementsWithShadowRoots(root).reduce<HTMLVideoElement[]>((acc, element) => {
    if (!element.shadowRoot) {
      return acc;
    }
    return [...acc, ...findVideoElementsDeep(element.shadowRoot)];
  }, videos);
};

export const findVideoElementByExtensionId = (id: string, extensionOrigin: string): HTMLVideoElement | null => {
  return findVideoElementsDeep().find((video) => video.dataset[`${extensionOrigin}Id`] === id) ?? null;
};

export const findVideoElementsInNodesDeep = (nodes: Node[]): HTMLVideoElement[] => {
  return nodes.reduce<HTMLVideoElement[]>((acc, node) => {
    if (isHTMLVideoElement(node)) {
      return [...acc, node];
    }
    if (isHTMLElement(node)) {
      const nestedVideos = findVideoElementsDeep(node);
      const shadowVideos = node.shadowRoot ? findVideoElementsDeep(node.shadowRoot) : [];
      return [...acc, ...nestedVideos, ...shadowVideos];
    }
    return acc;
  }, []);
};
