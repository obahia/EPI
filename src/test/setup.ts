// jsdom has no ResizeObserver -- Radix's Checkbox (and other size-aware primitives)
// call it unconditionally, so any component test that renders one needs this stub.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
