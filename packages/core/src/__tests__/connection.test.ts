import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection } from '../connection.js';
import { MockTransport } from '../../../testing/src/mock-transport.js';

describe('Connection Lifecycle and State Machine', () => {
  let transport: MockTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new MockTransport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize with idle state', () => {
    const conn = new Connection(transport);
    expect(conn.state).toBe('idle');
    expect(conn.metrics.reconnectCount).toBe(0);
    conn.destroy();
  });

  it('should transition to connecting then connected on connect()', async () => {
    const conn = new Connection(transport);
    transport.setConnectDelay(10);
    const stateChanges: string[] = [];
    conn.on('stateChange', ({ state }) => {
      stateChanges.push(state);
    });

    const connectPromise = conn.connect();
    expect(conn.state).toBe('connecting');

    await vi.advanceTimersByTimeAsync(15);
    await connectPromise;
    expect(conn.state).toBe('connected');
    expect(stateChanges).toEqual(['connecting', 'connected']);
    conn.destroy();
  });

  it('should trigger reconnection on failure', async () => {
    const conn = new Connection(
      transport,
      { maxAttempts: 3, delay: 100 },
      { enabled: false }
    );
    
    transport.setFailNextConnect(true);

    const stateChanges: string[] = [];
    conn.on('stateChange', ({ state }) => {
      stateChanges.push(state);
    });

    // Try to connect, it will fail and schedule reconnect
    const connectPromise = conn.connect();
    await vi.runAllTimersAsync();
    await connectPromise;

    expect(conn.state).toBe('connected');
    expect(stateChanges).toContain('reconnecting');
    expect(conn.metrics.reconnectCount).toBe(1);
    conn.destroy();
  });

  it('should transition to error state if maxAttempts is reached', async () => {
    const conn = new Connection(
      transport,
      { maxAttempts: 1, delay: 100 },
      { enabled: false }
    );

    transport.setFailNextConnect(true);
    
    // First attempt fails, triggers 1 reconnect attempt which also fails
    await conn.connect();
    
    // Fail the reconnect attempt too
    transport.setFailNextConnect(true);
    await vi.runAllTimersAsync();

    expect(conn.state).toBe('error');
    conn.destroy();
  });

  it('should send heartbeats and calculate latency', async () => {
    const conn = new Connection(
      transport,
      {},
      { enabled: true, interval: 1000, timeout: 500, message: 'ping' }
    );

    await conn.connect();
    
    // Travel forward in time to trigger heartbeat
    await vi.advanceTimersByTimeAsync(1100);
    
    // Heartbeat sent, now simulate receiving pong back
    const pingMessage = transport.published.find(p => p.topic === '__heartbeat__');
    expect(pingMessage).toBeDefined();

    // Advance clock to simulate network latency
    await vi.advanceTimersByTimeAsync(50);
    
    transport.simulateMessage('__heartbeat__', 'pong');
    
    expect(conn.metrics.latency).toBeGreaterThan(0);
    conn.destroy();
  });
});
