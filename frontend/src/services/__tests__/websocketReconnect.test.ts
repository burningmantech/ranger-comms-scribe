/**
 * A reconnect attempt that fails before opening a socket (the session check can't reach
 * the server) gets no onclose, so it must schedule the next attempt itself.
 */
import { SubmissionWebSocketClient } from '../websocketService';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static created = 0;
  static last: MockWebSocket | null = null;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  constructor() {
    MockWebSocket.created++;
    MockWebSocket.last = this;
  }
  send(): void {}
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

(globalThis as any).WebSocket = MockWebSocket;

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('SubmissionWebSocketClient reconnect', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.created = 0;
    localStorage.setItem('sessionId', 'session-1');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('keeps retrying after attempts that fail at the session check', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock as any;

    const client = new SubmissionWebSocketClient('sub-1', 'user-1', 'Test User', 'test@example.com');
    const expired = jest.fn();
    client.on('session_expired', expired);

    await client.connect();
    expect(MockWebSocket.created).toBe(1);
    // The connection drops (e.g. the backend restarts) while the network stays up.
    MockWebSocket.last!.onclose!({ code: 1006, reason: '', wasClean: false });

    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(10000);
      await flush();
    }

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(MockWebSocket.created).toBe(2);
    expect(expired).not.toHaveBeenCalled();
    client.disconnect();
  });
});
