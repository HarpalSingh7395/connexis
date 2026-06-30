import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PollingTransport } from '../index.js';

describe('PollingTransport Auth & Headers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should include Authorization Bearer header for static authToken', async () => {
    const transport = new PollingTransport('http://localhost/poll', {
      authToken: 'static-jwt-token'
    });

    await transport.connect();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost/poll'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer static-jwt-token',
          'Accept': 'application/json'
        })
      })
    );

    await transport.disconnect();
  });

  it('should resolve and include Authorization Bearer header for async getAuthToken callback', async () => {
    const mockGetToken = vi.fn().mockResolvedValue('dynamic-jwt-token');
    const transport = new PollingTransport('http://localhost/poll', {
      authToken: mockGetToken
    });

    await transport.connect();

    expect(mockGetToken).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost/poll'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer dynamic-jwt-token'
        })
      })
    );

    await transport.disconnect();
  });

  it('should resolve and merge dynamic async headers callback', async () => {
    const mockHeaders = vi.fn().mockResolvedValue({
      'X-Client-ID': 'test-client',
      'X-Custom-Auth': 'custom-val'
    });
    
    const transport = new PollingTransport('http://localhost/poll', {
      headers: mockHeaders,
      authToken: 'my-token'
    });

    await transport.connect();

    expect(mockHeaders).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost/poll'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer my-token',
          'X-Client-ID': 'test-client',
          'X-Custom-Auth': 'custom-val',
          'Accept': 'application/json'
        })
      })
    );

    await transport.disconnect();
  });

  it('should include resolved auth headers when publishing', async () => {
    const transport = new PollingTransport('http://localhost/poll', {
      publishUrl: 'http://localhost/publish',
      authToken: 'publish-token'
    });

    await transport.connect();
    await transport.publish('test_topic', { text: 'hi' });

    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      'http://localhost/publish',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer publish-token',
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ topic: 'test_topic', data: { text: 'hi' } })
      })
    );

    await transport.disconnect();
  });
});
