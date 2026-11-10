import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("子弹窗关闭后恢复同一个父弹窗、输入和滚动位置", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function openDialog(");
  const end = source.indexOf("async function openCustomerDialog(", start);
  assert.ok(start >= 0 && end > start);

  const parentFocus = { isConnected: true, focusCalls: 0, focus() { this.focusCalls += 1; } };
  const dialogRoot = {
    firstElementChild: null,
    set innerHTML(html) {
      const listeners = new Map();
      this.firstElementChild = {
        html, isConnected: true,
        addEventListener(type, handler) { listeners.set(type, handler); },
        clickBackdrop() { listeners.get("click")?.({ target: this, currentTarget: this }); }
      };
    },
    replaceChildren() { if (this.firstElementChild) this.firstElementChild.isConnected = false; this.firstElementChild = null; },
    append(element) { element.isConnected = true; this.firstElementChild = element; }
  };
  const document = {
    activeElement: parentFocus,
    querySelector(selector) {
      if (selector === ".dialog-backdrop") return dialogRoot.firstElementChild;
      return null;
    }
  };
  let closeRequests = 0;
  const context = vm.createContext({ dialogRoot, document, escapeHtml: value => String(value), setTimeout() {}, initializeInlinePdfViewers() {}, disposeInlinePdfViewers() {}, requestCloseDialog() { closeRequests++; } });
  vm.runInContext(`let activeDraftAutosave = null; const dialogStack = [];\n${source.slice(start, end)}\nglobalThis.dialogs = { openDialog, closeDialog, closeAllDialogs, setAutosave: value => { activeDraftAutosave = value; }, getAutosave: () => activeDraftAutosave, depth: () => dialogStack.length };`, context);
  const dialogs = context.dialogs;
  const autosave = { suspended: false, disposed: false, suspend() { this.suspended = true; }, resume() { this.suspended = false; }, dispose() { this.disposed = true; } };

  dialogs.openDialog("编辑报价", "父表单");
  const parent = dialogRoot.firstElementChild;
  parent.inputValue = "未保存的报价内容";
  parent.scrollTop = 215;
  parent.clickBackdrop();
  assert.equal(dialogRoot.firstElementChild, parent);
  assert.equal(closeRequests, 0);
  dialogs.setAutosave(autosave);
  dialogs.openDialog("查看报价", "子弹窗");
  const child = dialogRoot.firstElementChild;
  child.clickBackdrop();
  assert.equal(dialogRoot.firstElementChild, child);
  assert.equal(closeRequests, 0);
  assert.equal(autosave.suspended, true);
  assert.equal(parent.isConnected, false);
  assert.equal(dialogs.depth(), 1);
  dialogs.openDialog("查看附件", "三级弹窗");
  dialogs.closeDialog();
  assert.equal(dialogs.depth(), 1);
  dialogs.closeDialog();
  assert.equal(dialogRoot.firstElementChild, parent);
  assert.equal(parent.inputValue, "未保存的报价内容");
  assert.equal(parent.scrollTop, 215);
  assert.equal(dialogs.getAutosave(), autosave);
  assert.equal(autosave.suspended, false);
  assert.equal(autosave.disposed, false);
  assert.equal(parentFocus.focusCalls, 2);

  dialogs.openDialog("加载中", "正在加载");
  dialogs.openDialog("查看客户档案", "加载完成", { replace: true });
  assert.equal(dialogs.depth(), 1);
  dialogs.closeDialog();
  assert.equal(dialogRoot.firstElementChild, parent);
  dialogs.closeAllDialogs();
  assert.equal(autosave.disposed, true);
  assert.equal(dialogRoot.firstElementChild, null);
});

test("确认弹窗点击遮罩不关闭，取消和确认按钮仍正常工作", async () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function confirmInApp(");
  const end = source.indexOf("function startDialogAutosave(", start);
  assert.ok(start >= 0 && end > start);
  let currentHost;
  const document = {
    querySelector: () => null,
    createElement: () => {
      const handlers = new Map();
      const button = () => ({ addEventListener(type, handler) { handlers.set(this, handler); }, click() { handlers.get(this)?.(); }, focus() {} });
      const cancel = button(), accept = button();
      const host = {
        addEventListener(type, handler) { handlers.set(type, handler); },
        querySelector(selector) { return selector === "[data-confirm-cancel]" ? cancel : accept; },
        clickBackdrop() { handlers.get("click")?.({ target: host, currentTarget: host }); },
        remove() { host.removed = true; }, cancel, accept
      };
      currentHost = host;
      return host;
    },
    body: { append() {} }
  };
  const context = vm.createContext({ document, escapeHtml: value => String(value) });
  vm.runInContext(source.slice(start, end), context);
  for (const [button, expected] of [["cancel", false], ["accept", true]]) {
    const result = vm.runInContext("confirmInApp({})", context);
    const host = currentHost;
    host.clickBackdrop();
    assert.notEqual(host.removed, true);
    host[button].click();
    assert.equal(await result, expected);
    assert.equal(host.removed, true);
  }
});
