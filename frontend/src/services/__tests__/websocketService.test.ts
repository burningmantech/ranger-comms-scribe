/**
 * Tests for WebSocket service — transaction message types.
 *
 * These tests verify that the SubmissionWebSocketClient correctly formats
 * and sends the new transaction-related message types:
 * - sendTransactionSettled
 * - sendTransactionUndone
 * - sendTransactionRedone
 */

import {
  SubmissionWebSocketClient,
  WebSocketMessage,
} from '../websocketService';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  sentMessages: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

// Override global WebSocket for the module under test
(globalThis as any).WebSocket = MockWebSocket;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(): SubmissionWebSocketClient {
  return new SubmissionWebSocketClient(
    'sub-001',
    'user-1',
    'Test User',
    'test@example.com',
  );
}

/**
 * Inject a mock WebSocket into the client so we can call send methods
 * without going through the full connect() flow (which requires fetch).
 */
function injectMockWs(client: SubmissionWebSocketClient): MockWebSocket {
  const mockWs = new MockWebSocket();
  // Access the private ws field via bracket notation (test-only)
  (client as any).ws = mockWs;
  return mockWs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubmissionWebSocketClient — transaction messages', () => {
  let client: SubmissionWebSocketClient;
  let mockWs: MockWebSocket;

  beforeEach(() => {
    client = createClient();
    mockWs = injectMockWs(client);
  });

  afterEach(() => {
    client.disconnect();
  });

  test('sendTransactionSettled sends correct message shape', () => {
    const changeData = {
      changeId: 'chg-42',
      field: 'content',
      oldValue: 'hello',
      newValue: 'hello world',
      regionMap: { field: 'content', ranges: [{ start: 5, end: 11 }] },
    };

    client.sendTransactionSettled(changeData);

    expect(mockWs.sentMessages).toHaveLength(1);
    const parsed: WebSocketMessage = JSON.parse(mockWs.sentMessages[0]);

    expect(parsed.type).toBe('transaction_settled');
    expect(parsed.submissionId).toBe('sub-001');
    expect(parsed.userId).toBe('user-1');
    expect(parsed.userName).toBe('Test User');
    expect(parsed.userEmail).toBe('test@example.com');
    expect(parsed.data).toEqual(changeData);
    expect(parsed.timestamp).toBeDefined();
  });

  test('sendTransactionUndone sends removedChangeIds', () => {
    client.sendTransactionUndone(['chg-1', 'chg-2', 'chg-3']);

    expect(mockWs.sentMessages).toHaveLength(1);
    const parsed: WebSocketMessage = JSON.parse(mockWs.sentMessages[0]);

    expect(parsed.type).toBe('transaction_undone');
    expect(parsed.data).toEqual({ removedChangeIds: ['chg-1', 'chg-2', 'chg-3'] });
    expect(parsed.submissionId).toBe('sub-001');
  });

  test('sendTransactionRedone sends correct message shape', () => {
    const changeData = {
      changeId: 'chg-99',
      field: 'content',
      oldValue: 'before',
      newValue: 'after',
    };

    client.sendTransactionRedone(changeData);

    expect(mockWs.sentMessages).toHaveLength(1);
    const parsed: WebSocketMessage = JSON.parse(mockWs.sentMessages[0]);

    expect(parsed.type).toBe('transaction_redone');
    expect(parsed.data).toEqual(changeData);
    expect(parsed.userId).toBe('user-1');
  });

  test('messages are queued when WebSocket is not connected', () => {
    // Close the mock WS
    mockWs.readyState = MockWebSocket.CLOSED;
    (client as any).ws = null;

    // Patch connect to be a no-op (prevent actual network call)
    (client as any).connect = jest.fn().mockResolvedValue(undefined);

    client.sendTransactionSettled({
      changeId: 'chg-1',
      field: 'content',
      oldValue: 'a',
      newValue: 'b',
    });

    // Message should be in the queue, not sent
    expect(mockWs.sentMessages).toHaveLength(0);
    expect((client as any).messageQueue).toHaveLength(1);
  });
});
