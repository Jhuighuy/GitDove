/** Tracks whether the user is actively looking at the app (any window focused). */
let focused = true;

export const activity = {
  isActive: () => focused,
  setFocused: (value: boolean) => {
    focused = value;
  },
};
