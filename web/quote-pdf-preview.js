const activePreviews = new WeakMap();
let pdfLibrary;

async function loadPdfLibrary() {
  if (!pdfLibrary) pdfLibrary = import("/vendor/pdfjs/pdf.mjs");
  return pdfLibrary;
}

// Render the original PDF locally on the page. Only nearby pages retain their canvas.
export function initializeInlinePdfViewers(root, { loadLibrary = loadPdfLibrary } = {}) {
  for (const host of root.querySelectorAll("[data-quote-pdf-preview]")) {
    if (activePreviews.has(host)) continue;
    const state = { stopped: false, task: null, document: null, observer: null, pages: [], queue: [], running: 0 };
    activePreviews.set(host, state);
    const status = host.querySelector("[data-pdf-status]");
    const container = host.querySelector("[data-pdf-pages]");
    const fail = () => { if (!state.stopped) status.textContent = "PDF 预览加载失败，请刷新页面重试。"; };
    const drain = () => {
      while (!state.stopped && state.running < 2 && state.queue.length) {
        const entry = state.queue.shift();
        if (!entry.wanted || entry.canvas || entry.rendering) continue;
        entry.rendering = true; state.running++;
        void (async () => {
          const page = await state.document.getPage(entry.number);
          if (state.stopped || !entry.wanted) { page.cleanup(); return; }
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(1.5, 2500 / Math.max(base.width, base.height), Math.sqrt(6000000 / (base.width * base.height)));
          const viewport = page.getViewport({ scale });
          const canvas = host.ownerDocument.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
          canvas.setAttribute("aria-label", `PDF 第 ${entry.number} 页`);
          entry.node.style.aspectRatio = `${base.width} / ${base.height}`;
          entry.node.replaceChildren(canvas);
          entry.canvas = canvas; entry.page = page;
          entry.renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
          await entry.renderTask.promise;
          entry.renderTask = null;
          if (!entry.wanted || state.stopped) release(entry);
        })().catch(error => {
          release(entry);
          if (error?.name !== "RenderingCancelledException" && !state.stopped) {
            entry.node.textContent = `第 ${entry.number} 页无法显示，请刷新页面重试。`;
          }
        }).finally(() => { entry.rendering = false; state.running--; drain(); });
      }
    };
    const release = entry => {
      try { entry.renderTask?.cancel(); } catch { /* The page may have just completed. */ }
      entry.renderTask = null;
      try { entry.page?.cleanup(); } catch { /* A cancelled renderer may still be unwinding. */ }
      entry.page = null;
      if (entry.canvas) { entry.canvas.width = 0; entry.canvas.height = 0; entry.canvas.remove(); entry.canvas = null; }
    };
    void (async () => {
      const pdfjs = await loadLibrary();
      if (state.stopped) return;
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
      state.task = pdfjs.getDocument({ url: host.dataset.pdfUrl, withCredentials: true, isEvalSupported: false, enableXfa: false, useWasm: false,
        disableRange: true, disableStream: true, cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/" });
      state.document = await state.task.promise;
      if (state.stopped) return;
      if (!Number.isInteger(state.document.numPages) || state.document.numPages < 1 || state.document.numPages > 100) throw new Error("PDF page limit");
      status.textContent = `共 ${state.document.numPages} 页`;
      for (let number = 1; number <= state.document.numPages; number++) {
        const node = host.ownerDocument.createElement("div");
        node.className = "quote-pdf-page"; node.textContent = `第 ${number} 页加载中…`;
        node.dataset.pdfPage = String(number); container.append(node);
        state.pages.push({ number, node, wanted: false, canvas: null, page: null, renderTask: null, rendering: false });
      }
      if (typeof IntersectionObserver === "function") {
        const lookup = new Map(state.pages.map(entry => [entry.node, entry]));
        state.observer = new IntersectionObserver(entries => {
          for (const visible of entries) {
            const entry = lookup.get(visible.target);
            entry.wanted = visible.isIntersecting;
            if (entry.wanted) { state.queue.push(entry); }
            else if (!entry.rendering) release(entry);
          }
          drain();
        }, { rootMargin: "800px 0px" });
        for (const entry of state.pages) state.observer.observe(entry.node);
      } else {
        for (const entry of state.pages) { entry.wanted = true; state.queue.push(entry); }
        drain();
      }
    })().catch(fail);
  }
}

export function disposeInlinePdfViewers(root) {
  for (const host of root.querySelectorAll("[data-quote-pdf-preview]")) {
    const state = activePreviews.get(host);
    if (!state) continue;
    state.stopped = true; state.observer?.disconnect();
    for (const page of state.pages) {
      try { page.renderTask?.cancel(); } catch { /* The page may have just completed. */ }
      if (page.canvas) { page.canvas.width = 0; page.canvas.height = 0; }
      try { page.page?.cleanup(); } catch { /* A cancelled renderer may still be unwinding. */ }
    }
    if (state.task) void Promise.resolve(state.task.destroy()).catch(() => {});
    activePreviews.delete(host);
  }
}
