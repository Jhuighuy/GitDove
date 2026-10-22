/** Tracks whether the user is actively looking at the app (any window focused). */
let focused = true;
const listeners = new Set<() => void>();

const wake = () => {
  // A copy: a woken poller registers its next listener right away, which must wait for the
  // next wake-up rather than run in this one.
  for (const listener of Array.from(listeners)) listener();
};

export const activity = {
  isActive: () => focused,
  setFocused: (value: boolean) => {
    const was = focused;
    focused = value;
    if (value && !was) wake();
  },
  /**
   * Tells listeners that the user is likely to look at the app again, e.g. after the system
   * resumed from sleep: anything polling should check right away.
   */
  wake,
  /** Calls `listener` whenever the app becomes active again; returns a function that stops it. */
  onActive: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
