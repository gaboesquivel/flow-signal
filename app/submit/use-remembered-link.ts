"use client";

import { useCallback, useSyncExternalStore } from "react";

import { forgetLink, readRememberedLink, rememberLink } from "./submit-model";

const CHANGE_EVENT = "signal:my-link";

/** `window.localStorage`, or undefined where reading it throws (blocked storage, sandboxes). */
const linkStorage = (): Storage | undefined => {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    // Storage is blocked: the wizard works without a remembered link.
  }
  return storage;
};

/** The server and the first render see no link; the browser's value follows on hydration. */
const noLinkOnServer = () => readRememberedLink(undefined);

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
};

const announce = () => window.dispatchEvent(new Event(CHANGE_EVENT));

/**
 * The My signals link this device files under (`signal.myLink`), with setters. The server and
 * first render see no link; every storage call is guarded, so the wizard works without one.
 */
export const useRememberedLink = () => {
  const token = useSyncExternalStore(
    subscribe,
    () => readRememberedLink(linkStorage()),
    noLinkOnServer,
  );
  const remember = useCallback((next: string) => {
    rememberLink(linkStorage(), next);
    announce();
  }, []);
  const forget = useCallback(() => {
    forgetLink(linkStorage());
    announce();
  }, []);
  return { forget, remember, token };
};
