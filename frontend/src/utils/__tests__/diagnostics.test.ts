import { collectDiagnostics, describeElement, installDiagnostics, rawFetch, redactText, redactUrl, resetDiagnostics } from '../diagnostics';

const SESSION = 'sess-1234567890abcdef';
let underlying: jest.Mock;

function response(status: number, body = '') {
  return { ok: status < 400, status, clone: () => ({ text: () => Promise.resolve(body) }) } as unknown as Response;
}

beforeAll(() => {
  underlying = jest.fn();
  (window as any).fetch = underlying;
  // Quiet underneath the wrappers, which still record
  console.error = () => {};
  console.warn = () => {};
  installDiagnostics();
});

beforeEach(() => {
  resetDiagnostics();
  underlying.mockReset();
  localStorage.clear();
  localStorage.setItem('sessionId', SESSION);
});

describe('redaction', () => {
  it('strips session IDs and other secrets from URLs', () => {
    expect(redactUrl(`wss://scribe.example.org/api/ws/yjs/submissions/s1?sessionId=${SESSION}&testUser=member`))
      .toBe('wss://scribe.example.org/api/ws/yjs/submissions/s1?sessionId=REDACTED&testUser=member');
    expect(redactUrl('/requests?devSession=abc')).toBe('http://localhost/requests?devSession=REDACTED');
    expect(redactUrl('https://scribe.example.org/api/content/submissions?status=draft')).toBe('https://scribe.example.org/api/content/submissions?status=draft');
  });

  it('strips bearer tokens, password fields and the session ID from text', () => {
    const text = `Authorization: Bearer abc.def {"password":"hunter2","name":"Pat"} id=${SESSION}`;
    expect(redactText(text)).toBe('Authorization: Bearer REDACTED {"password":"REDACTED","name":"Pat"} id=REDACTED');
  });

  it('describes what was clicked, never what was typed', () => {
    const input = document.createElement('input');
    input.name = 'subject';
    input.value = 'private draft';
    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.innerHTML = '<i></i> Save changes';
    expect(describeElement(input)).toBe('input "subject"');
    expect(describeElement(button.querySelector('i'))).toBe('button.btn.btn-primary "Save changes"');
  });
});

describe('collecting', () => {
  it('records each request with its status, where it was made and a failed response', async () => {
    underlying.mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(500, '{"error":"Boom"}'));
    await window.fetch('/api/content/submissions');
    await window.fetch(`/api/ws/x?sessionId=${SESSION}`, { method: 'put', body: 'abcd', headers: { Authorization: `Bearer ${SESSION}` } });
    await new Promise((resolve) => setTimeout(resolve, 0)); // the failed body is read in the background

    const { network } = collectDiagnostics();
    expect(network).toHaveLength(2);
    expect(network[0]).toMatchObject({ method: 'GET', url: '/api/content/submissions', status: 200 });
    expect(network[0].initiator).toEqual(expect.any(String));
    expect(network[1]).toMatchObject({ method: 'PUT', status: 500, requestBytes: 4, responsePreview: '{"error":"Boom"}' });
    expect(network[1].url).toContain('sessionId=REDACTED');
    expect(JSON.stringify(network)).not.toContain(SESSION);
  });

  it('records a request that never got an answer', async () => {
    underlying.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(window.fetch('/api/feedback/config')).rejects.toThrow('Failed to fetch');
    expect(collectDiagnostics().network[0]).toMatchObject({ error: 'TypeError: Failed to fetch' });
  });

  it('does not record requests made with rawFetch', async () => {
    underlying.mockResolvedValueOnce(response(201));
    await rawFetch('/api/feedback', { method: 'POST' });
    expect(collectDiagnostics().network).toHaveLength(0);
  });

  it('records console errors, uncaught errors with their stacks, and the steps taken', () => {
    console.error('Save failed', { id: 's1', password: 'x' });

    const error = new Error('x is undefined');
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: x is undefined', error, filename: 'main.js', lineno: 1, colno: 2 }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('Request timed out');
    window.dispatchEvent(rejection);

    window.history.pushState({}, '', '/tracked-changes/s1');
    const button = document.createElement('button');
    button.textContent = 'Approve';
    document.body.appendChild(button);
    button.click();
    button.remove();

    const d = collectDiagnostics();
    expect(d.console.find((c) => c.level === 'error')?.message).toBe('Save failed {"id":"s1","password":"REDACTED"}');
    expect(d.errors[0]).toMatchObject({ kind: 'error', message: 'Uncaught Error: x is undefined', source: 'main.js:1:2' });
    expect(d.errors[0].stack).toContain('x is undefined');
    expect(d.errors[1]).toMatchObject({ kind: 'unhandledrejection', message: 'Error: Request timed out' });
    expect(d.breadcrumbs.map((b) => [b.kind, b.detail])).toEqual([
      ['navigation', '/tracked-changes/s1'],
      ['click', 'button "Approve"'],
    ]);
    expect(d.page.path).toBe('/tracked-changes/s1');
  });

  it('includes the person without their password hash, and never the session ID', () => {
    localStorage.setItem('user', JSON.stringify({ email: 'pat@x.org', passwordHash: 'h', note: SESSION }));
    const d = collectDiagnostics();
    expect(d.user).toEqual({ email: 'pat@x.org', note: 'REDACTED' });
    expect((d.app as any).storageKeys).toEqual(expect.arrayContaining(['sessionId', 'user']));
    expect(JSON.stringify(d)).not.toContain(SESSION);
  });
});
