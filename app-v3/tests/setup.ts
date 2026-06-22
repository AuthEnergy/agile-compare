// jsdom doesn't implement window.scrollTo and emits a noisy "Not implemented"
// error whenever it's called. The app scrolls to the top on every screen
// change (see App.render), so stub it to a no-op for the test environment.
window.scrollTo = (() => {}) as typeof window.scrollTo;

// jsdom also does not implement canvas. Returning null exercises the app's
// production fallback path (text-only share) without printing "Not implemented".
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;
