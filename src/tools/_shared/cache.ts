/*
  Speed helpers for data that is the same for every caller.

  keyedCache   an in-process cache per key with a time-to-live, a size bound
               and one shared in-flight load per key. Only for values that
               never depend on who is asking: app responses fetched with
               `appGet(path, query, { access: null })`, marketing-site pages
               (never fetched with a token) and deterministic computations.
               A response fetched with a user's token must never go in here
               (AGENTS.md rule 5).
  hedged       a second (and third) identical request when the first is slow.
               Some app routes answer in 0.2 s on one instance and 5 s on
               another; the first answer wins and the others are ignored.
               Only for idempotent reads.
*/

type Entry<T> = { at: number; value: T };

export type KeyedCache<T> = {
  get(key: string, load: () => Promise<T>): Promise<T>;
};

export function keyedCache<T>(options: { ttlMs: number; max: number }): KeyedCache<T> {
  const entries = new Map<string, Entry<T>>();
  const inFlight = new Map<string, Promise<T>>();
  return {
    async get(key, load) {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < options.ttlMs) {
        // Refresh recency: Map iteration order is insertion order.
        entries.delete(key);
        entries.set(key, hit);
        return hit.value;
      }
      const pending = inFlight.get(key);
      if (pending) return pending;
      const promise = load()
        .then((value) => {
          entries.delete(key);
          entries.set(key, { at: Date.now(), value });
          while (entries.size > options.max) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            entries.delete(oldest);
          }
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
  };
}

/** An error the same request would hit again (a 4xx answer), so another attempt would not help. */
function isDefinitive(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * Runs `load`, and starts it again every `afterMs` while no attempt has
 * answered, up to `attempts` in total. Resolves with the first success. A
 * 4xx failure rejects straight away; any other failure starts the next
 * attempt at once; when every attempt has failed, rejects with the first
 * error.
 */
export function hedged<T>(
  load: () => Promise<T>,
  options: { afterMs?: number; attempts?: number } = {},
): Promise<T> {
  const afterMs = options.afterMs ?? 700;
  const attempts = Math.max(1, options.attempts ?? 3);
  return new Promise<T>((resolve, reject) => {
    let started = 0;
    let failed = 0;
    let settled = false;
    let firstError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    const schedule = () => {
      if (started < attempts) timer = setTimeout(start, afterMs);
    };
    function start() {
      if (settled || started >= attempts) return;
      started++;
      load().then(
        (value) => {
          if (settled) return;
          finish();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          failed++;
          firstError ??= error;
          if (isDefinitive(error) || failed >= attempts) {
            finish();
            reject(firstError);
            return;
          }
          if (timer !== undefined) clearTimeout(timer);
          start();
        },
      );
      schedule();
    }
    start();
  });
}
