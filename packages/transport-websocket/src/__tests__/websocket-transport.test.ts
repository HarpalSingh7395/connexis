import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketTransport } from '../index.js';

// Setup Mock WebSocket class
class MockWebSocket {
  public static lastInstance: MockWebSocket | null = null;
  public onopen: (() => void) | null = null;
  public onmessage: ((e: { data: any }) => void) | null = null;
  public onerror: ((e: any) => void) | null = null;
  public onclose: (() => void) | null = null;
  public url: string;
  public protocols: string | string[] | undefined;
  public readyState = 1; // OPEN

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.lastInstance = this;

    // Simulate async connection success
    setTimeout(() => {
      this.onopen?.();
    }, 10);
  }

  send(_data: any) {}
  close() {
    setTimeout(() => {
      this.onclose?.();
    }, 10);
  }
}

describe('WebSocketTransport Auth', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    MockWebSocket.lastInstance = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should append token as query parameter for static authToken', async () => {
    const transport = new WebSocketTransport('ws://localhost/ws', {
      authToken: 'static-socket-token'
    });

    await transport.connect();

    expect(MockWebSocket.lastInstance).not.toBeNull();
    expect(MockWebSocket.lastInstance!.url).toBe('ws://localhost/ws?token=static-socket-token');

    await transport.disconnect();
  });

  it('should append token correctly using & if URL already contains query params', async () => {
    const transport = new WebSocketTransport('ws://localhost/ws?foo=bar', {
      authToken: 'static-socket-token'
    });

    await transport.connect();

    expect(MockWebSocket.lastInstance).not.toBeNull();
    expect(MockWebSocket.lastInstance!.url).toBe('ws://localhost/ws?foo=bar&token=static-socket-token');

    await transport.disconnect();
  });

  it('should resolve and append token for dynamic async getAuthToken callback', async () => {
    const mockGetToken = vi.fn().mockResolvedValue('dynamic-socket-token');
    const transport = new WebSocketTransport('ws://localhost/ws', {
      authToken: mockGetToken
    });

    await transport.connect();

    expect(mockGetToken).toHaveBeenCalled();
    expect(MockWebSocket.lastInstance).not.toBeNull();
    expect(MockWebSocket.lastInstance!.url).toBe('ws://localhost/ws?token=dynamic-socket-token');

    await transport.disconnect();
  });
});
