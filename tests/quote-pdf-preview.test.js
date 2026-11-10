import assert from "node:assert/strict";
import test from "node:test";
import { initializeInlinePdfViewers, disposeInlinePdfViewers } from "../web/quote-pdf-preview.js";

test("PDF 原件在页面内逐页渲染，滚出范围释放画布，关闭弹窗销毁任务", async () => {
  const previous = globalThis.IntersectionObserver;
  let observer, destroyed = false, options;
  const cleanupCalls = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.nodes = []; observer = this; }
    observe(node) { this.nodes.push(node); queueMicrotask(() => this.callback([{ target: node, isIntersecting: true }])); }
    disconnect() { this.disconnected = true; }
    emit(node, isIntersecting) { this.callback([{ target: node, isIntersecting }]); }
  }
  globalThis.IntersectionObserver = Observer;
  const status = { textContent: "" }, container = { children: [], append(node) { this.children.push(node); } };
  const document = { createElement(type) {
    return type === "canvas" ? { width: 0, height: 0, setAttribute() {}, getContext: () => ({}), remove() { this.removed = true; } }
      : { style: {}, dataset: {}, textContent: "", replaceChildren(canvas) { this.canvas = canvas; } };
  } };
  const host = { dataset: { pdfUrl: "/api/attachments/fake/preview" }, ownerDocument: document,
    querySelector(selector) { return selector === "[data-pdf-status]" ? status : container; } };
  const root = { querySelectorAll: () => [host] };
  const pdfjs = { GlobalWorkerOptions: {}, getDocument(input) {
    options = input;
    return { promise: Promise.resolve({ numPages: 2, getPage: async number => ({
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }), cleanup: () => cleanupCalls.push(number)
    }) }), destroy: async () => { destroyed = true; } };
  } };
  try {
    initializeInlinePdfViewers(root, { loadLibrary: async () => pdfjs });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(status.textContent, "共 2 页");
    assert.equal(options.url, host.dataset.pdfUrl);
    assert.equal(options.isEvalSupported, false);
    assert.equal(options.enableXfa, false);
    assert.equal(container.children.length, 2);
    assert.ok(container.children[0].canvas.width > 0);
    const firstCanvas = container.children[0].canvas;
    observer.emit(container.children[0], false);
    assert.equal(firstCanvas.width, 0);
    assert.ok(cleanupCalls.includes(1));
    disposeInlinePdfViewers(root);
    await Promise.resolve();
    assert.equal(observer.disconnected, true);
    assert.equal(destroyed, true);
  } finally {
    globalThis.IntersectionObserver = previous;
  }
});
