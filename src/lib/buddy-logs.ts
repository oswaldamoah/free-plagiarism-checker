// Client-side ring buffer + console helper.
// Type `buddyLogs()` in the browser console to inspect what's being used.

export type BuddyEntry = {
  ts: string;
  kind: "rank" | "search" | "similarity" | "info" | "error";
  detail: Record<string, unknown>;
};

const MAX = 500;

function getStore(): BuddyEntry[] {
  if (typeof window === "undefined") return [];
  const w = window as unknown as { __buddyLog__?: BuddyEntry[] };
  if (!w.__buddyLog__) w.__buddyLog__ = [];
  return w.__buddyLog__;
}

type Listener = (entries: BuddyEntry[]) => void;
const listeners = new Set<Listener>();

export function buddyLog(kind: BuddyEntry["kind"], detail: Record<string, unknown>) {
  const store = getStore();
  const entry: BuddyEntry = { ts: new Date().toISOString(), kind, detail };
  store.push(entry);
  if (store.length > MAX) store.splice(0, store.length - MAX);
  // eslint-disable-next-line no-console
  console.debug(`%c[buddy:${kind}]`, "color:#38bdf8;font-weight:bold", detail);
  listeners.forEach((l) => {
    try {
      l([...store]);
    } catch {
      /* ignore */
    }
  });
}

export function subscribeBuddyLogs(fn: Listener): () => void {
  listeners.add(fn);
  fn([...getStore()]);
  return () => listeners.delete(fn);
}

export function getBuddyLogs(): BuddyEntry[] {
  return [...getStore()];
}

export function clearBuddyLogs() {
  getStore().length = 0;
  listeners.forEach((l) => l([]));
}

export function installBuddyLogs() {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    buddyLogs?: (n?: number) => BuddyEntry[];
    buddyLogsClear?: () => void;
    __buddyInstalled__?: boolean;
  };
  if (w.__buddyInstalled__) return;
  w.__buddyInstalled__ = true;

  w.buddyLogs = (n = 50) => {
    const store = getStore();
    const rows = store.slice(-n).map((e) => ({
      time: e.ts.split("T")[1]?.replace("Z", "") ?? e.ts,
      kind: e.kind,
      ...e.detail,
    }));
    // eslint-disable-next-line no-console
    console.table(rows);

    // Summary of providers used
    const llms = new Set<string>();
    const searches = new Map<string, number>();
    for (const e of store) {
      if (typeof e.detail.llm === "string") llms.add(e.detail.llm);
      if (typeof e.detail.search === "string") {
        const k = e.detail.search;
        searches.set(k, (searches.get(k) ?? 0) + 1);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      "%c[buddy] summary",
      "color:#38bdf8;font-weight:bold",
      {
        llms_used: [...llms],
        searches_used: Object.fromEntries(searches),
        total_entries: store.length,
      },
    );
    return store.slice(-n);
  };

  w.buddyLogsClear = () => {
    getStore().length = 0;
    // eslint-disable-next-line no-console
    console.log("[buddy] cleared");
  };

  // eslint-disable-next-line no-console
  console.log(
    "%c[buddy] ready — type buddyLogs() or buddyLogsClear() in the console",
    "color:#38bdf8;font-weight:bold",
  );
}
