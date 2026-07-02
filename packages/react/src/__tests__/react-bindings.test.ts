import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useContext, useState, useEffect, useRef } from 'react';
import { 
  useRealtime, 
  useConnection, 
  useSubscription, 
  usePublish 
} from '../index.js';

// Setup Mock Client
class MockClient {
  public state = 'connected';
  public metrics = {
    reconnectCount: 0,
    latency: 5,
    uptime: 10,
    transportType: 'websocket',
    connectionCount: 1,
    activeSubscriptions: 1,
    leaderChanges: 0,
    throughput: { inbound: 0, outbound: 0 }
  };

  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, callback: (...args: any[]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => {
      this.listeners.get(event)!.delete(callback);
    };
  }

  emit(event: string, data: any) {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }

  subscribe = vi.fn().mockImplementation(() => {
    return Promise.resolve(vi.fn().mockResolvedValue(undefined));
  });

  publish = vi.fn().mockResolvedValue(undefined);
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useContext: vi.fn(),
    useState: vi.fn(),
    useEffect: vi.fn(),
    useRef: vi.fn(),
    useCallback: vi.fn((fn) => fn)
  };
});

describe('@connexis/react Hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('useRealtime should throw if context is missing', () => {
    vi.mocked(useContext).mockReturnValue(null);
    expect(() => useRealtime()).toThrow('useRealtime must be used within a RealtimeProvider');
  });

  it('useRealtime should return the client if provider is present', () => {
    const client = new MockClient();
    vi.mocked(useContext).mockReturnValue(client);
    expect(useRealtime()).toBe(client);
  });

  it('usePublish should return a callback that invokes client.publish()', async () => {
    const client = new MockClient();
    vi.mocked(useContext).mockReturnValue(client);

    const publish = usePublish();
    await publish('my_topic', { data: 'hello' });

    expect(client.publish).toHaveBeenCalledWith('my_topic', { data: 'hello' });
  });

  it('useConnection should sync state and metrics and listen to changes', () => {
    const client = new MockClient();
    vi.mocked(useContext).mockReturnValue(client);

    const mockSetState = vi.fn();
    const mockSetMetrics = vi.fn();

    vi.mocked(useState)
      .mockImplementationOnce((init) => [init, mockSetState])
      .mockImplementationOnce((init) => [init, mockSetMetrics]);

    // Stub useEffect to invoke the effect immediately
    vi.mocked(useEffect).mockImplementationOnce((effect) => {
      effect();
      return undefined;
    });

    const { state, metrics } = useConnection();

    expect(state).toBe('connected');
    expect(metrics.latency).toBe(5);

    // Emit event and verify state setter is called
    client.emit('stateChange', { state: 'connecting' });
    expect(mockSetState).toHaveBeenCalledWith('connecting');

    // Emit metrics and verify metrics setter is called
    const newMetrics = { ...client.metrics, latency: 15 };
    client.emit('metricsChange', newMetrics);
    expect(mockSetMetrics).toHaveBeenCalledWith(newMetrics);
  });

  it('useSubscription should register subscribe on mount and unsubscribe on unmount', async () => {
    const client = new MockClient();
    vi.mocked(useContext).mockReturnValue(client);

    const mockUnsub = vi.fn().mockResolvedValue(undefined);
    client.subscribe.mockResolvedValue(mockUnsub);

    let effectCleanup: (() => void) | undefined;

    vi.mocked(useEffect).mockImplementationOnce((effect) => {
      effectCleanup = effect() as any;
      return undefined;
    });

    // Mock useRef behavior
    const refObject = { current: null };
    vi.mocked(useRef).mockReturnValue(refObject);

    const handler = vi.fn();
    useSubscription('ticks', handler);

    expect(client.subscribe).toHaveBeenCalledWith('ticks', {}, expect.any(Function));

    // Verify trigger handler callback
    const subscribeCallback = client.subscribe.mock.calls[0][2] as (...args: any[]) => void;
    subscribeCallback('price_data');
    expect(handler).toHaveBeenCalledWith('price_data');

    // Trigger cleanup and check unsubscribe
    if (effectCleanup) {
      effectCleanup();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockUnsub).toHaveBeenCalled();
  });

  it('should call unsub EXACTLY ONCE when cleanup runs before Promise resolves (React Strict Mode)', async () => {
    // In React Strict Mode, effects are invoked twice: mount → cleanup → remount.
    // The cleanup fires before the subscribe Promise has resolved, so `unsubscribe`
    // is still null when cleanup runs.  The previous (buggy) implementation
    // scheduled an extra `.then(unsub => unsub())` in the cleanup path, which —
    // combined with the already-scheduled `.then(unsub => { if (!active) unsub() })`
    // in the mount path — caused `unsub` to be called TWICE, double-decrementing
    // the connection ref-count and silently destroying live connections.
    const client = new MockClient();
    vi.mocked(useContext).mockReturnValue(client);

    // Keep the Promise pending until we manually resolve it
    let resolveUnsub!: (fn: () => Promise<void>) => void;
    const pendingPromise = new Promise<() => Promise<void>>((res) => {
      resolveUnsub = res;
    });
    client.subscribe.mockReturnValue(pendingPromise);

    const mockUnsub = vi.fn().mockResolvedValue(undefined);
    let effectCleanup: (() => void) | undefined;

    vi.mocked(useEffect).mockImplementationOnce((effect) => {
      effectCleanup = effect() as any;
      return undefined;
    });

    const refObject = { current: null };
    vi.mocked(useRef).mockReturnValue(refObject);

    useSubscription('ticks', vi.fn());

    // Simulate Strict Mode: cleanup runs BEFORE the Promise resolves
    if (effectCleanup) effectCleanup();

    // Now resolve the subscribe Promise
    resolveUnsub(mockUnsub);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // unsub must be called exactly once — not twice
    expect(mockUnsub).toHaveBeenCalledTimes(1);
  });
});
