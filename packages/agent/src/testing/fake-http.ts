/**
 * Test doubles for the HTTP boundary (Req 9.1). Tests inject `fakeHttp(...).fetch` into the Twilio and
 * Razorpay clients, and `fakeClock()` for their sleeps and request timeouts, so no test waits in real
 * time and none reaches a real provider. Not imported by production code.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Thrown by the fetch guard and by `fakeHttp` for a request no route answers. */
export class UnmockedRequestError extends Error {
  constructor(description: string) {
    super(`Unmocked HTTP request: ${description}`);
    this.name = "UnmockedRequestError";
  }
}

// ---------------------------------------------------------------------------
// fakeClock
// ---------------------------------------------------------------------------

export interface FakeClock {
  /** Milliseconds the fake clock has advanced since it was created. */
  now(): number;
  /** Every `sleep(ms)` call, in order. */
  readonly sleeps: number[];
  /** Records `ms`, advances the clock by `ms` and resolves at once. */
  sleep(ms: number): Promise<void>;
  /** A signal that aborts with a `TimeoutError` once the clock is more than `ms` past its creation. */
  timeoutSignal(ms: number): AbortSignal;
  /** Moves the clock forward and aborts every signal whose time has passed. */
  advance(ms: number): void;
}

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

export function fakeClock(): FakeClock {
  let now = 0;
  const pending: { deadline: number; controller: AbortController }[] = [];
  const sleeps: number[] = [];
  const advance = (ms: number): void => {
    now += ms;
    for (const entry of pending) {
      if (!entry.controller.signal.aborted && now > entry.deadline) entry.controller.abort(timeoutError());
    }
  };
  return {
    now: () => now,
    sleeps,
    sleep(ms) {
      sleeps.push(ms);
      advance(ms);
      return Promise.resolve();
    },
    timeoutSignal(ms) {
      const controller = new AbortController();
      pending.push({ deadline: now + ms, controller });
      return controller.signal;
    },
    advance,
  };
}

// ---------------------------------------------------------------------------
// fakeHttp
// ---------------------------------------------------------------------------

export interface FakeRequest {
  /** Upper case. */
  method: string;
  url: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  /** JSON bodies parsed, form bodies as an object, anything else as the raw text; `null` for no body. */
  body: unknown;
  rawBody: string | null;
}

export interface FakeResponseSpec {
  /** Default 200. */
  status?: number;
  /** Sent as the JSON body. */
  json?: unknown;
  /** Sent as the raw text body (used when `json` is not set). */
  text?: string;
  /**
   * Advances the `clock` by this much before the response is returned. If the request's signal has
   * aborted by then (a `fakeClock` timeout), the request rejects with the signal's reason instead.
   */
  delayMs?: number;
  /** Rejects instead of responding: a network failure, or a `TimeoutError`. */
  throws?: "network" | "timeout";
}

/** A response, or a function that builds one from the request (it may wait, to stage a race). */
export type FakeResponse = FakeResponseSpec | ((req: FakeRequest) => FakeResponseSpec | Promise<FakeResponseSpec>);

export interface FakeRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** A URL prefix. When several routes match, the longest prefix wins. */
  url: string;
  /** Answered in order, one per request. A request after the last one is unmatched. */
  responses: readonly FakeResponse[];
}

export interface FakeHttp {
  fetch: FetchLike;
  /** Every request, matched or not, in arrival order. */
  readonly requests: FakeRequest[];
  /** The requests no route answered. A test fails when this is not empty (see `collectFetchViolations`). */
  readonly unmatched: FakeRequest[];
  /** The requests with this method and a URL starting with `urlPrefix`. */
  calls(method: FakeRoute["method"], urlPrefix: string): FakeRequest[];
}

const liveFakes: FakeHttp[] = [];
const guardReached: string[] = [];

async function describeRequest(input: string | URL | Request, init?: RequestInit): Promise<FakeRequest> {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? (isRequest ? input.headers : undefined)).forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const method = (init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
  const url = isRequest ? input.url : String(input);
  let rawBody: string | null = null;
  let form = false;
  const body = init?.body;
  if (typeof body === "string") rawBody = body;
  else if (body instanceof URLSearchParams) {
    rawBody = body.toString();
    form = true;
  } else if (isRequest && body === undefined && input.body !== null) rawBody = await input.clone().text();
  let parsed: unknown = rawBody;
  const contentType = headers["content-type"] ?? "";
  if (rawBody !== null) {
    if (form || contentType.includes("application/x-www-form-urlencoded")) {
      parsed = Object.fromEntries(new URLSearchParams(rawBody));
    } else if (contentType.includes("json")) {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = rawBody;
      }
    }
  }
  return { method, url, headers, body: parsed, rawBody };
}

function toResponse(spec: FakeResponseSpec): Response {
  const status = spec.status ?? 200;
  if (spec.json !== undefined) {
    return new Response(JSON.stringify(spec.json), { status, headers: { "content-type": "application/json" } });
  }
  return new Response(spec.text ?? null, { status });
}

/**
 * A `fetch` that answers from `routes` and records every request. Pass the `fakeClock()` the code under
 * test uses when a response sets `delayMs`. The fake is registered so the fetch guard can fail the test
 * if any request went unmatched.
 */
export function fakeHttp(routes: readonly FakeRoute[], options: { clock?: FakeClock } = {}): FakeHttp {
  const state = routes.map((route) => ({ route, next: 0 }));
  const requests: FakeRequest[] = [];
  const unmatched: FakeRequest[] = [];

  const fake: FetchLike = async (input, init) => {
    const req = await describeRequest(input, init);
    requests.push(req);
    const candidates = state.filter((s) => s.route.method === req.method && req.url.startsWith(s.route.url));
    const best = candidates.reduce<(typeof candidates)[number] | undefined>(
      (a, b) => (a === undefined || b.route.url.length > a.route.url.length ? b : a),
      undefined,
    );
    const response = best?.route.responses[best.next];
    if (best === undefined || response === undefined) {
      unmatched.push(req);
      throw new UnmockedRequestError(`${req.method} ${req.url}`);
    }
    best.next++;
    const spec = typeof response === "function" ? await response(req) : response;
    const signal = init?.signal ?? undefined;
    if (spec.delayMs !== undefined) {
      if (options.clock === undefined) throw new Error("fakeHttp: a response with delayMs needs the clock option");
      options.clock.advance(spec.delayMs);
    }
    if (signal?.aborted) throw signal.reason;
    if (spec.throws === "timeout") throw timeoutError();
    if (spec.throws === "network") throw new TypeError("fetch failed");
    return toResponse(spec);
  };

  const handle: FakeHttp = {
    fetch: fake,
    requests,
    unmatched,
    calls: (method, urlPrefix) => requests.filter((r) => r.method === method && r.url.startsWith(urlPrefix)),
  };
  liveFakes.push(handle);
  return handle;
}

// ---------------------------------------------------------------------------
// The fetch guard (installed by each package's Vitest setup file)
// ---------------------------------------------------------------------------

let realFetch: typeof fetch | undefined;

/**
 * Replaces `globalThis.fetch` with a function that throws `UnmockedRequestError` and records the call.
 * `data:` URLs still go to the real fetch: they never leave the process (the PDF renderer loads its
 * WebAssembly module that way).
 */
export function installFetchGuard(): void {
  realFetch ??= globalThis.fetch;
  const original = realFetch;
  globalThis.fetch = async (input, init) => {
    const target = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (target.startsWith("data:")) return original(input, init);
    const req = await describeRequest(input, init);
    guardReached.push(`${req.method} ${req.url}`);
    throw new UnmockedRequestError(`${req.method} ${req.url}`);
  };
}

/**
 * Descriptions of every request that reached the guard and every request a `fakeHttp` could not
 * answer since the last call, then forgets them and every registered fake. The setup file's `afterEach`
 * fails the test when this is not empty (Req 9.1).
 */
export function collectFetchViolations(): string[] {
  const found = [
    ...guardReached.map((d) => `reached the fetch guard: ${d}`),
    ...liveFakes.flatMap((f) => f.unmatched.map((r) => `unmatched by fakeHttp: ${r.method} ${r.url}`)),
  ];
  guardReached.length = 0;
  liveFakes.length = 0;
  return found;
}
