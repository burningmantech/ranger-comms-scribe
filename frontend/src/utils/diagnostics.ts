import { API_URL, IS_PRODUCTION } from '../config';

/**
 * What the feedback tab sends with a message (components/FeedbackCarrot.tsx), collected from the
 * moment the app starts: network calls (with the stack that made each one), console output,
 * uncaught errors and rejections with their stacks, navigation and clicks, WebSocket
 * connections, slow or failed resources, and the browser and page. Everything is kept in small
 * in-memory buffers and only leaves the browser when someone sends feedback.
 *
 * Session IDs never leave: they are stripped from URLs and scrubbed from the result, and no
 * request headers or request bodies are kept.
 */

export interface NetworkEntry {
  at: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  error?: string;
  requestBytes?: number;
  /** The start of a failed response's body. */
  responsePreview?: string;
  /** Where the call was made from. */
  initiator?: string;
}

export interface ConsoleEntry {
  at: string;
  level: 'error' | 'warn' | 'info' | 'log';
  message: string;
}

export interface ErrorEntry {
  at: string;
  kind: 'error' | 'unhandledrejection' | 'resource';
  message: string;
  stack?: string;
  source?: string;
}

export interface Breadcrumb {
  at: string;
  kind: 'navigation' | 'click';
  detail: string;
}

interface SocketEntry {
  url: string;
  openedAt: string;
  state: string;
  closedAt?: string;
  closeCode?: number;
  closeReason?: string;
  errors: number;
  messagesIn: number;
  messagesOut: number;
}

const LIMITS = { network: 150, console: 150, errors: 50, breadcrumbs: 100, sockets: 20 };
const MAX_TEXT = 1000;

const network: NetworkEntry[] = [];
const consoleEntries: ConsoleEntry[] = [];
const errors: ErrorEntry[] = [];
const breadcrumbs: Breadcrumb[] = [];
const sockets: SocketEntry[] = [];
const loadedAt = new Date().toISOString();
let installed = false;

/** `fetch` as the browser had it, so sending feedback doesn't log itself. */
export let rawFetch: typeof window.fetch = (...args) => window.fetch(...args);

function push<T>(buffer: T[], entry: T, limit: number): T {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  return entry;
}

const now = () => new Date().toISOString();
const clip = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text);

const SECRET_PARAMS = /^(sessionid|devsession|token|access_token|id_token|code|password|key|secret)$/i;

/** A URL without session IDs or other secrets in its query. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    let changed = false;
    parsed.searchParams.forEach((_value, name) => {
      if (SECRET_PARAMS.test(name)) changed = true;
    });
    if (!changed) return url;
    for (const name of Array.from(parsed.searchParams.keys())) {
      if (SECRET_PARAMS.test(name)) parsed.searchParams.set(name, 'REDACTED');
    }
    return parsed.toString();
  } catch {
    return url.replace(/([?&](?:sessionId|devSession|token|password)=)[^&#]*/gi, '$1REDACTED');
  }
}

/** Text without bearer tokens, password fields or the current session ID. */
export function redactText(text: string): string {
  let out = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer REDACTED')
    .replace(/("(?:password|passwordHash|sessionId|token|credential|secret)"\s*:\s*)"[^"]*"/gi, '$1"REDACTED"')
    .replace(/([?&](?:sessionId|devSession|token)=)[^&#\s"]*/gi, '$1REDACTED');
  const session = currentSessionId();
  if (session && session.length >= 8) out = out.split(session).join('REDACTED');
  return out;
}

function currentSessionId(): string | null {
  try {
    return localStorage.getItem('sessionId');
  } catch {
    return null;
  }
}

/** The stack of whoever called the wrapper, without the wrapper's own frames. */
function callerStack(skip = 2): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  const frames = stack.split('\n').filter((line) => line.trim() && line.trim() !== 'Error');
  return frames.slice(skip, skip + 10).map((line) => line.trim()).join('\n') || undefined;
}

/** One console argument as text. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  try {
    const seen = new WeakSet<object>();
    return clip(JSON.stringify(value, (_key, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        if (typeof Node !== 'undefined' && v instanceof Node) return `[${v.nodeName}]`;
      }
      return v;
    }) ?? String(value), 500);
  } catch {
    return String(value);
  }
}

function bodySize(body: unknown): number | undefined {
  if (typeof body === 'string') return body.length;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return undefined;
}

/** A short description of a clicked element (never what was typed in it). */
export function describeElement(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('button, a, [role="button"], [role="tab"], [role="menuitem"], input, select, label, summary, [data-testid]') || target;
  const tag = el.tagName.toLowerCase();
  const label = el.getAttribute('aria-label') || el.getAttribute('title') || (el instanceof HTMLInputElement ? el.placeholder || el.name || el.type : '') || (el.textContent || '').trim().replace(/\s+/g, ' ');
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  const testId = el.getAttribute('data-testid');
  return `${tag}${id}${cls}${testId ? `[data-testid=${testId}]` : ''}${label ? ` "${clip(label, 60)}"` : ''}`;
}

function wrapFetch(): void {
  const original = window.fetch.bind(window);
  rawFetch = original;
  window.fetch = async function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const started = performance.now();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET') || 'GET').toUpperCase();
    const entry = push(network, {
      at: now(),
      method,
      url: redactUrl(url),
      requestBytes: bodySize(init?.body),
      initiator: callerStack(),
    }, LIMITS.network);
    try {
      const response = await original(input, init);
      entry.status = response.status;
      entry.durationMs = Math.round(performance.now() - started);
      if (!response.ok) {
        response.clone().text().then((text) => {
          entry.responsePreview = redactText(clip(text, 1500));
        }).catch(() => {});
      }
      return response;
    } catch (err) {
      entry.durationMs = Math.round(performance.now() - started);
      entry.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw err;
    }
  };
}

function wrapXhr(): void {
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  proto.open = function (this: XMLHttpRequest & { __diag?: NetworkEntry }, method: string, url: string | URL, ...rest: any[]) {
    this.__diag = { at: now(), method: String(method).toUpperCase(), url: redactUrl(String(url)), initiator: callerStack() };
    return (open as any).call(this, method, url, ...rest);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest & { __diag?: NetworkEntry }, body?: Document | XMLHttpRequestBodyInit | null) {
    const entry = this.__diag;
    if (entry) {
      const started = performance.now();
      entry.requestBytes = bodySize(body);
      push(network, entry, LIMITS.network);
      this.addEventListener('loadend', () => {
        entry.durationMs = Math.round(performance.now() - started);
        entry.status = this.status || undefined;
        if (!this.status) entry.error = 'Network error or aborted';
        else if (this.status >= 400 && (this.responseType === '' || this.responseType === 'text')) {
          entry.responsePreview = redactText(clip(String(this.responseText || ''), 1500));
        }
      });
    }
    return send.call(this, body as any);
  };
}

function wrapConsole(): void {
  // Wrapping moves the call site devtools shows, so local builds keep log/info untouched
  const levels = IS_PRODUCTION ? (['error', 'warn', 'info', 'log'] as const) : (['error', 'warn'] as const);
  levels.forEach((level) => {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      try {
        push(consoleEntries, { at: now(), level, message: redactText(clip(args.map(describeValue).join(' '))) }, LIMITS.console);
      } catch {
        // never let logging break the app
      }
      original.apply(console, args);
    };
  });
}

function listenForErrors(): void {
  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window && target instanceof Element) {
      const src = (target as HTMLImageElement).src || (target as HTMLLinkElement).href || '';
      push(errors, { at: now(), kind: 'resource', message: `${target.tagName.toLowerCase()} failed to load`, source: redactUrl(src) }, LIMITS.errors);
      return;
    }
    push(errors, {
      at: now(),
      kind: 'error',
      message: event.message || String(event.error),
      stack: event.error instanceof Error ? event.error.stack : undefined,
      source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    }, LIMITS.errors);
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    push(errors, {
      at: now(),
      kind: 'unhandledrejection',
      message: reason instanceof Error ? `${reason.name}: ${reason.message}` : describeValue(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }, LIMITS.errors);
  });
}

function trackNavigation(): void {
  const record = () => push(breadcrumbs, { at: now(), kind: 'navigation', detail: redactUrl(window.location.pathname + window.location.search) }, LIMITS.breadcrumbs);
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = window.history[name];
    window.history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      record();
      return result;
    };
  }
  window.addEventListener('popstate', record);
  document.addEventListener('click', (event) => {
    const detail = describeElement(event.target);
    if (detail) push(breadcrumbs, { at: now(), kind: 'click', detail }, LIMITS.breadcrumbs);
  }, true);
}

function trackWebSockets(): void {
  const Original = window.WebSocket;
  if (!Original) return;
  class TrackedWebSocket extends Original {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const entry = push(sockets, { url: redactUrl(String(url)), openedAt: now(), state: 'connecting', errors: 0, messagesIn: 0, messagesOut: 0 }, LIMITS.sockets);
      this.addEventListener('open', () => { entry.state = 'open'; });
      this.addEventListener('message', () => { entry.messagesIn += 1; });
      this.addEventListener('error', () => { entry.errors += 1; });
      this.addEventListener('close', (event) => {
        entry.state = 'closed';
        entry.closedAt = now();
        entry.closeCode = event.code;
        entry.closeReason = event.reason || undefined;
      });
      const send = this.send;
      this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        entry.messagesOut += 1;
        return send.call(this, data);
      };
    }
  }
  window.WebSocket = TrackedWebSocket as typeof WebSocket;
}

/** Start collecting. Called once from index.tsx before the app renders. */
export function installDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const steps = [wrapFetch, wrapXhr, wrapConsole, listenForErrors, trackNavigation, trackWebSockets];
  for (const step of steps) {
    try {
      step();
    } catch {
      // a browser without one of these still collects the rest
    }
  }
}

function environment() {
  const nav = navigator as Navigator & { connection?: any; deviceMemory?: number; userAgentData?: { platform?: string; mobile?: boolean } };
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return {
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform || nav.platform,
    mobile: nav.userAgentData?.mobile,
    language: nav.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: new Date().toString(),
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    screen: { width: window.screen?.width, height: window.screen?.height },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    online: nav.onLine,
    connection: nav.connection ? { effectiveType: nav.connection.effectiveType, downlink: nav.connection.downlink, rtt: nav.connection.rtt } : undefined,
    deviceMemoryGb: nav.deviceMemory,
    cpus: nav.hardwareConcurrency,
    jsHeapMb: memory ? { used: Math.round(memory.usedJSHeapSize / 1048576), limit: Math.round(memory.jsHeapSizeLimit / 1048576) } : undefined,
    visibility: document.visibilityState,
  };
}

function storedJson(key: string): any {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function app() {
  const main = document.querySelector<HTMLScriptElement>('script[src*="/static/js/main"]');
  let storageKeys: string[] = [];
  try {
    storageKeys = Object.keys(localStorage);
  } catch {
    // storage blocked
  }
  return {
    build: main ? main.src.split('/').pop() : process.env.NODE_ENV,
    apiUrl: API_URL,
    loadedAt,
    upForSeconds: Math.round(performance.now() / 1000),
    storageKeys,
  };
}

/** Error text on the screen right now (alerts, error messages). */
function visibleAlerts(): string[] {
  return Array.from(document.querySelectorAll('[role="alert"], .error-message, .alert-danger, .alert-warning, .invalid-feedback'))
    .filter((el) => (el as HTMLElement).offsetParent !== null)
    .map((el) => clip((el.textContent || '').trim().replace(/\s+/g, ' '), 300))
    .filter(Boolean)
    .slice(0, 10);
}

/** Resources (scripts, images, styles, fetches) that failed or were slow. */
function resources() {
  const entries = performance.getEntriesByType('resource') as Array<PerformanceResourceTiming & { responseStatus?: number }>;
  return entries
    .filter((e) => e.duration > 1000 || (e.responseStatus !== undefined && e.responseStatus >= 400))
    .slice(-30)
    .map((e) => ({ url: redactUrl(e.name), type: e.initiatorType, durationMs: Math.round(e.duration), status: e.responseStatus, bytes: e.transferSize }));
}

/** One section of the diagnostics; a browser without what it reads gets the error instead. */
function safe<T>(read: () => T): T | { unavailable: string } {
  try {
    return read();
  } catch (err) {
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

export interface Diagnostics {
  collectedAt: string;
  page: { url: string; path: string; title: string; referrer: string };
  environment: ReturnType<typeof environment> | { unavailable: string };
  app: ReturnType<typeof app> | { unavailable: string };
  user: unknown;
  permissions: unknown;
  visibleAlerts: string[] | { unavailable: string };
  network: NetworkEntry[];
  console: ConsoleEntry[];
  errors: ErrorEntry[];
  breadcrumbs: Breadcrumb[];
  websockets: SocketEntry[];
  resources: ReturnType<typeof resources> | { unavailable: string };
}

/** Everything collected so far, with secrets scrubbed. */
export function collectDiagnostics(): Diagnostics {
  const user = storedJson('user');
  if (user) delete user.passwordHash;
  const raw: Diagnostics = {
    collectedAt: now(),
    page: {
      url: redactUrl(window.location.href),
      path: window.location.pathname,
      title: document.title,
      referrer: redactUrl(document.referrer),
    },
    environment: safe(environment),
    app: safe(app),
    user,
    permissions: storedJson('userPermissions'),
    visibleAlerts: safe(visibleAlerts),
    network: network.slice(),
    console: consoleEntries.slice(),
    errors: errors.slice(),
    breadcrumbs: breadcrumbs.slice(),
    websockets: sockets.slice(),
    resources: safe(resources),
  };
  return JSON.parse(redactText(JSON.stringify(raw)));
}

/** For tests: forget everything collected. */
export function resetDiagnostics(): void {
  network.length = 0;
  consoleEntries.length = 0;
  errors.length = 0;
  breadcrumbs.length = 0;
  sockets.length = 0;
}
