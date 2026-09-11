"use client";

import { useEffect, useRef } from "react";

type PollTask = (signal: AbortSignal) => void | Promise<void>;

/** Poll only while the page is visible, immediately refreshing on return. */
export function useVisiblePoll(task: PollTask, intervalMs: number) {
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    let intervalId: number | undefined;
    let requestController: AbortController | null = null;

    const stop = () => {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
      requestController?.abort();
      requestController = null;
    };

    const run = () => {
      requestController?.abort();
      requestController = new AbortController();
      void taskRef.current(requestController.signal);
    };

    const syncVisibility = () => {
      stop();
      if (document.visibilityState !== "visible") return;

      run();
      intervalId = window.setInterval(run, intervalMs);
    };

    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);

    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      stop();
    };
  }, [intervalMs]);
}
