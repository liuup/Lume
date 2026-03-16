import "@testing-library/jest-dom/vitest";

class ResizeObserverMock {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback([
      {
        target,
        contentRect: {
          width: 1280,
          height: 800,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 800,
          right: 1280,
          toJSON() {
            return {};
          },
        } as DOMRectReadOnly,
      } as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  }

  unobserve() {}

  disconnect() {}
}

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: ResizeObserverMock,
});

Object.defineProperty(globalThis, "ResizeObserver", {
  writable: true,
  value: ResizeObserverMock,
});
