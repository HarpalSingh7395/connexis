import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSETransport } from '../index.js';

// Setup Mock EventSource class
class MockEventSource {
  public static lastInstance: MockEventSource | null = null;
  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((e: any) => void) | null = null;
  public url: string;
  public options: any;

  constructor(url: string, options?: any) {
    this.url = url;
    this.options = options;
    MockEventSource.lastInstance = this;

    setTimeout(() => {
      this.onopen?.();
    }, 10);
  }

  close() {}
}

describe('SSETransport Auth', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    MockEventSource.lastInstance = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should append token as query parameter for static authToken', async () => {
    const transport = new SSETransport('http://localhost/sse', {
      authToken: 'static-sse-token'
    });

    await transport.connect();

    expect(MockEventSource.lastInstance).not.toBeNull();
    expect(MockEventSource.lastInstance!.url).toBe('http://localhost/sse?token=static-sse-token');

    await transport.disconnect();
  });

  it('should resolve and append token for dynamic async getAuthToken callback', async () => {
    const mockGetToken = vi.fn().mockResolvedValue('dynamic-sse-token');
    const transport = new SSETransport('http://localhost/sse', {
      authToken: mockGetToken
    });

    await transport.connect();

    expect(mockGetToken).toHaveBeenCalled();
    expect(MockEventSource.lastInstance).not.toBeNull();
    expect(MockEventSource.lastInstance!.url).toBe('http://localhost/sse?token=dynamic-sse-token');

    await transport.disconnect();
  });

  it('should include Authorization Bearer header when publishing via HTTP publishUrl', async () => {
    const transport = new SSETransport('http://localhost/sse', {
      publishUrl: 'http://localhost/publish',
      authToken: 'publish-sse-token'
    });

    await transport.connect();
    await transport.publish('test_topic', { value: 123 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost/publish',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer publish-sse-token',
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ topic: 'test_topic', data: { value: 123 } })
      })
    );

    await transport.disconnect();
  });
});
