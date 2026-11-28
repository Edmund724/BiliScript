export interface FakeIdbStoreState {
  keyPath: string;
  records: Map<string, Record<string, unknown>>;
  indexes: Map<string, string | string[]>;
}

export interface FakeIdbDatabaseState {
  version: number;
  stores: Map<string, FakeIdbStoreState>;
}

export interface FakeIdbSpies {
  getAllCalls: Array<{ storeName: string; indexName?: string }>;
  getCalls: Array<{ storeName: string; key: string }>;
  putCalls: Array<{ storeName: string; key: string }>;
  indexCursorCalls: Array<{ storeName: string; indexName: string; query: unknown }>;
  reset(): void;
}

function makeDomStringList(names: Iterable<string>): DOMStringList {
  const arr = Array.from(names);
  return Object.assign(arr, {
    contains: (name: string) => arr.includes(name),
    item: (index: number) => arr[index] ?? null
  }) as unknown as DOMStringList;
}

function extractKey(record: Record<string, unknown>, keyPath: string | string[]): unknown {
  return Array.isArray(keyPath) ? keyPath.map((k) => record[k]) : record[keyPath];
}

function compareIdbKeys(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      const cmp = compareIdbKeys(a[i], b[i]);
      if (cmp !== 0) return cmp;
    }
    return a.length - b.length;
  }
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matchesQuery(value: unknown, query: unknown): boolean {
  if (query === undefined || query === null) return true;
  if (typeof query === "object" && query !== null && ("lower" in query || "upper" in query)) {
    const range = query as {
      lower?: unknown;
      upper?: unknown;
      lowerOpen?: boolean;
      upperOpen?: boolean;
    };
    if (range.lower !== undefined) {
      const cmp = compareIdbKeys(value, range.lower);
      if (range.lowerOpen ? cmp <= 0 : cmp < 0) return false;
    }
    if (range.upper !== undefined) {
      const cmp = compareIdbKeys(value, range.upper);
      if (range.upperOpen ? cmp >= 0 : cmp > 0) return false;
    }
    return true;
  }
  return compareIdbKeys(value, query) === 0;
}

function cloneIdbVal<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.slice(0, value.size, value.type) as unknown as T;
  }
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Blob]" || tag === "[object File]") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0) as unknown as T;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const copied = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    const Ctor = view.constructor as new (buf: ArrayBufferLike) => T;
    return new Ctor(copied);
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneIdbVal(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = cloneIdbVal(v);
  }
  return out as T;
}

export function createFakeIdbEnvironment() {
  const databases = new Map<string, FakeIdbDatabaseState>();
  const getAllCalls: FakeIdbSpies["getAllCalls"] = [];
  const getCalls: FakeIdbSpies["getCalls"] = [];
  const putCalls: FakeIdbSpies["putCalls"] = [];
  const indexCursorCalls: FakeIdbSpies["indexCursorCalls"] = [];

  const spies: FakeIdbSpies = {
    getAllCalls,
    getCalls,
    putCalls,
    indexCursorCalls,
    reset() {
      getAllCalls.length = 0;
      getCalls.length = 0;
      putCalls.length = 0;
      indexCursorCalls.length = 0;
    }
  };

  function createStoreApi(
    storeName: string,
    storeState: FakeIdbStoreState,
    enqueueOp: (runner: () => void) => void
  ): IDBObjectStore {
    const makeReq = <T>(exec: () => T): IDBRequest<T> => {
      const req: Record<string, unknown> = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null
      };
      enqueueOp(() => {
        try {
          req.result = exec();
          (req.onsuccess as ((ev: Event) => void) | null)?.({ target: req } as unknown as Event);
        } catch (err) {
          req.error = err;
          (req.onerror as ((ev: Event) => void) | null)?.({ target: req } as unknown as Event);
        }
      });
      return req as unknown as IDBRequest<T>;
    };

    const openCursorImpl = (
      keyPath: string | string[],
      query: unknown,
      keyOnly: boolean,
      direction: IDBCursorDirection = "next"
    ): IDBRequest<IDBCursorWithValue | IDBCursor | null> => {
      const req: Record<string, unknown> = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null
      };
      const entries = Array.from(storeState.records.entries())
        .map(([pk, rec]) => ({ pk, indexKey: extractKey(rec, keyPath), rec }))
        .filter((e) => matchesQuery(e.indexKey, query))
        .sort((a, b) => {
          const cmp = compareIdbKeys(a.indexKey, b.indexKey);
          const dir = direction === "prev" || direction === "prevunique" ? -1 : 1;
          if (cmp !== 0) return cmp * dir;
          return compareIdbKeys(a.pk, b.pk) * dir;
        });

      let idx = 0;
      const step = () => {
        enqueueOp(() => {
          while (idx < entries.length && !storeState.records.has(entries[idx].pk)) {
            idx += 1;
          }
          if (idx >= entries.length) {
            req.result = null;
            (req.onsuccess as ((ev: Event) => void) | null)?.({ target: req } as unknown as Event);
            return;
          }
          const entry = entries[idx];
          const liveRec = storeState.records.get(entry.pk)!;
          idx += 1;
          const cursorObj: Record<string, unknown> = {
            key: entry.indexKey,
            primaryKey: entry.pk,
            ...(keyOnly ? {} : { value: cloneIdbVal(liveRec) }),
            continue() {
              step();
            },
            update(nextVal: Record<string, unknown>) {
              return makeReq(() => {
                const pk = String(nextVal[storeState.keyPath]);
                putCalls.push({ storeName, key: pk });
                storeState.records.set(pk, cloneIdbVal(nextVal));
                return pk;
              });
            },
            delete() {
              return makeReq(() => {
                storeState.records.delete(entry.pk);
                return undefined;
              });
            }
          };
          req.result = cursorObj;
          (req.onsuccess as ((ev: Event) => void) | null)?.({ target: req } as unknown as Event);
        });
      };

      step();
      return req as unknown as IDBRequest<IDBCursorWithValue | IDBCursor | null>;
    };

    return {
      name: storeName,
      keyPath: storeState.keyPath,
      get indexNames() {
        return makeDomStringList(storeState.indexes.keys());
      },
      createIndex(name: string, keyPath: string | string[]) {
        storeState.indexes.set(name, keyPath);
        return {} as IDBIndex;
      },
      deleteIndex(name: string) {
        storeState.indexes.delete(name);
      },
      index(indexName: string) {
        const keyPath = storeState.indexes.get(indexName);
        if (!keyPath) throw new Error(`Missing index ${indexName} on ${storeName}`);
        return {
          name: indexName,
          keyPath,
          getAll(query?: unknown) {
            getAllCalls.push({ storeName, indexName });
            return makeReq(() =>
              Array.from(storeState.records.values())
                .filter((rec) => matchesQuery(extractKey(rec, keyPath), query))
                .map((rec) => cloneIdbVal(rec))
            );
          },
          openCursor(query?: unknown, direction?: IDBCursorDirection) {
            indexCursorCalls.push({ storeName, indexName, query });
            return openCursorImpl(keyPath, query, false, direction);
          },
          openKeyCursor(query?: unknown, direction?: IDBCursorDirection) {
            indexCursorCalls.push({ storeName, indexName, query });
            return openCursorImpl(keyPath, query, true, direction);
          }
        } as unknown as IDBIndex;
      },
      get(key: IDBValidKey) {
        getCalls.push({ storeName, key: String(key) });
        return makeReq(() => {
          const hit = storeState.records.get(String(key));
          return hit === undefined ? undefined : cloneIdbVal(hit);
        });
      },
      getAll() {
        getAllCalls.push({ storeName });
        return makeReq(() => Array.from(storeState.records.values()).map((r) => cloneIdbVal(r)));
      },
      count() {
        return makeReq(() => storeState.records.size);
      },
      put(val: Record<string, unknown>) {
        const pk = String(val[storeState.keyPath]);
        putCalls.push({ storeName, key: pk });
        return makeReq(() => {
          storeState.records.set(pk, cloneIdbVal(val));
          return pk;
        });
      },
      delete(key: IDBValidKey) {
        return makeReq(() => {
          storeState.records.delete(String(key));
          return undefined;
        });
      },
      clear() {
        return makeReq(() => {
          storeState.records.clear();
          return undefined;
        });
      },
      openCursor(query?: unknown, direction?: IDBCursorDirection) {
        return openCursorImpl(storeState.keyPath, query, false, direction);
      },
      openKeyCursor(query?: unknown, direction?: IDBCursorDirection) {
        return openCursorImpl(storeState.keyPath, query, true, direction);
      }
    } as unknown as IDBObjectStore;
  }

  function createTransaction(
    dbState: FakeIdbDatabaseState,
    allowedNames: string[] | null,
    onDone?: () => void
  ): IDBTransaction {
    let pending = 0;
    let finished = false;
    let oncompleteCb: ((ev: Event) => void) | null = null;
    const scheduleComplete = () => {
      queueMicrotask(() => {
        queueMicrotask(() => {
          if (pending === 0 && !finished) {
            finished = true;
            onDone?.();
            oncompleteCb?.({} as Event);
          }
        });
      });
    };

    const enqueueOp = (runner: () => void) => {
      pending += 1;
      queueMicrotask(() => {
        try {
          runner();
        } finally {
          pending -= 1;
          scheduleComplete();
        }
      });
    };

    const tx: Record<string, unknown> = {
      error: null,
      get oncomplete() {
        return oncompleteCb;
      },
      set oncomplete(fn: ((ev: Event) => void) | null) {
        oncompleteCb = fn;
        if (finished && fn) queueMicrotask(() => fn({} as Event));
      },
      onerror: null,
      onabort: null,
      objectStore(name: string) {
        const st = dbState.stores.get(name);
        if (!st || (allowedNames !== null && !allowedNames.includes(name))) {
          throw new Error(`ObjectStore ${name} not in transaction`);
        }
        return createStoreApi(name, st, enqueueOp);
      }
    };
    scheduleComplete();
    return tx as unknown as IDBTransaction;
  }

  const factory: IDBFactory = {
    open(name: string, requestedVersion?: number) {
      let dbState = databases.get(name);
      const oldVersion = dbState?.version ?? 0;
      if (!dbState) {
        dbState = { version: 0, stores: new Map() };
        databases.set(name, dbState);
      }

      const req: Record<string, unknown> = {
        result: null,
        transaction: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null
      };

      let activeUpgradeTx: IDBTransaction | null = null;

      const dbApi = {
        get version() {
          return dbState!.version;
        },
        get objectStoreNames() {
          return makeDomStringList(dbState!.stores.keys());
        },
        createObjectStore(storeName: string, opts?: { keyPath?: string }) {
          const st: FakeIdbStoreState = {
            keyPath: opts?.keyPath || "id",
            records: new Map(),
            indexes: new Map()
          };
          dbState!.stores.set(storeName, st);
          return activeUpgradeTx
            ? activeUpgradeTx.objectStore(storeName)
            : createStoreApi(storeName, st, (r) => queueMicrotask(r));
        },
        deleteObjectStore(storeName: string) {
          dbState!.stores.delete(storeName);
        },
        transaction(storeNames: string | string[]) {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          return createTransaction(dbState!, names);
        },
        close() {},
        onversionchange: null as ((ev: IDBVersionChangeEvent) => void) | null,
        onclose: null as ((ev: Event) => void) | null
      } as unknown as IDBDatabase;

      req.result = dbApi;
      queueMicrotask(() => {
        const targetVersion = requestedVersion ?? (oldVersion || 1);
        if (targetVersion > oldVersion) {
          dbState!.version = targetVersion;
          const upgradeTx = createTransaction(dbState!, null, () => {
            activeUpgradeTx = null;
            req.transaction = null;
            (req.onsuccess as ((ev: Event) => void) | null)?.(new Event("success"));
          });
          activeUpgradeTx = upgradeTx;
          req.transaction = upgradeTx;
          (req.onupgradeneeded as ((ev: IDBVersionChangeEvent) => void) | null)?.({
            oldVersion,
            newVersion: targetVersion
          } as IDBVersionChangeEvent);
        } else {
          (req.onsuccess as ((ev: Event) => void) | null)?.(new Event("success"));
        }
      });

      return req as unknown as IDBOpenDBRequest;
    }
  } as unknown as IDBFactory;

  return { factory, databases, spies };
}
