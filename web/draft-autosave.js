export function createDraftAutosave({
  initialEtag = 0,
  initialSavedAt = null,
  delay = 1200,
  collect,
  save,
  render = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let etag = initialEtag;
  let lastSavedAt = initialSavedAt;
  let dirty = false;
  let saving = false;
  let disposed = false;
  let suspended = false;
  let timer = null;
  let changeSequence = 0;
  let active = null;

  const snapshot = () => ({ etag, lastSavedAt, dirty, saving, pending: dirty || saving });
  const publish = (status, error = null) => render({ status, error, ...snapshot() });

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    cancelTimer();
    if (disposed || suspended || saving || !dirty) return;
    timer = setTimer(() => {
      timer = null;
      void persist(false);
    }, delay);
  };

  const persist = async propagateError => {
    if (disposed || suspended || saving || !dirty) return true;
    cancelTimer();
    const startedAtSequence = changeSequence;
    let payload;
    try {
      payload = collect();
    } catch (error) {
      publish("INVALID", error);
      if (propagateError) throw error;
      return false;
    }
    dirty = false;
    saving = true;
    publish("SAVING");
    active = Promise.resolve(save({ ...payload, expectedDraftEtag: etag, saveMode: "AUTO" }));
    try {
      const result = await active;
      if (Number.isSafeInteger(result?.draftEtag)) etag = result.draftEtag;
      lastSavedAt = result?.draftSavedAt || new Date().toISOString();
      dirty = changeSequence !== startedAtSequence;
      publish(dirty ? "DIRTY" : "SAVED");
      return true;
    } catch (error) {
      dirty = true;
      publish("ERROR", error);
      if (propagateError) throw error;
      return false;
    } finally {
      saving = false;
      active = null;
      if (dirty && changeSequence !== startedAtSequence) schedule();
    }
  };

  return {
    markDirty() {
      if (disposed) return;
      dirty = true;
      changeSequence += 1;
      publish("DIRTY");
      schedule();
    },
    async flush() {
      cancelTimer();
      if (active) await active.catch(() => undefined);
      if (dirty) await persist(true);
      return snapshot();
    },
    suspend() {
      suspended = true;
      cancelTimer();
    },
    resume() {
      suspended = false;
      schedule();
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
    getState: snapshot
  };
}
