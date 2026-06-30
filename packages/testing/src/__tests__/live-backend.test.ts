import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { createRealtimeClient } from '@connexis/core';
import { WebSocketTransport } from '@connexis/transport-websocket';
import { SSETransport } from '@connexis/transport-sse';
import { PollingTransport } from '@connexis/transport-polling';
import * as ES from 'eventsource';

// Resolve ESM default export wrapper for EventSource
const EventSource = (ES as any).default || ES;

if (typeof globalThis.EventSource === 'undefined') {
  (globalThis as any).EventSource = EventSource;
}

const checkBackendRunning = async (): Promise<boolean> => {
  try {
    const res = await fetch('http://localhost:3000/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'HealthCheck' })
    });
    return res.status === 200 || res.status === 201;
  } catch {
    return false;
  }
};

const backendRunning = await checkBackendRunning();

if (!backendRunning) {
  console.log('⚠️ NestJS backend is not running at http://localhost:3000. Skipping live integration tests.');
}

describe.runIf(backendRunning)('Aggressive Live Backend Integration Tests', () => {
  let activeToken = '';

  const getValidToken = async () => {
    const res = await fetch('http://localhost:3000/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'IntegrationTest' })
    });
    const data = await res.json();
    return data.token;
  };

  beforeEach(async () => {
    activeToken = await getValidToken();
  });

  it('should successfully connect, subscribe, and publish over real WebSockets', async () => {
    const transport = new WebSocketTransport('ws://localhost:3000/api/realtime/socket', {
      authToken: () => Promise.resolve(activeToken)
    });

    const client = createRealtimeClient({
      transport,
      connectionPolicy: 'direct'
    });

    const received: any[] = [];
    const unsubscribe = await client.subscribe('ticks', (tick) => {
      received.push(tick);
    });

    // Wait for price ticker events to stream over WebSocket
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(client.state).toBe('connected');
    expect(received.length).toBeGreaterThan(0);
    expect(received[0].symbol).toBe('BTC/USD');

    await unsubscribe();
    await client.destroy();
  });

  it('should successfully connect and stream ticks over real SSE transport', async () => {
    const transport = new SSETransport('http://localhost:3000/api/realtime/stream', {
      publishUrl: 'http://localhost:3000/api/realtime/publish',
      authToken: () => Promise.resolve(activeToken)
    });

    const client = createRealtimeClient({
      transport,
      connectionPolicy: 'direct'
    });

    (client as any).manager.on('stateChange', ({ state, error }: any) => {
      console.log(`[Test SSE Connection State] -> ${state}, error:`, error?.message || error);
    });

    const received: any[] = [];
    const unsubscribe = await client.subscribe('ticks', (tick) => {
      received.push(tick);
    });

    // Wait for price ticker to stream over SSE
    await new Promise((resolve) => setTimeout(resolve, 4000));

    expect(client.state).toBe('connected');
    expect(received.length).toBeGreaterThan(0);
    expect(received[0].symbol).toBe('BTC/USD');

    await unsubscribe();
    await client.destroy();
  }, 10000);

  it('should successfully connect and poll ticks over real HTTP Polling transport', async () => {
    const transport = new PollingTransport('http://localhost:3000/api/realtime/poll', {
      publishUrl: 'http://localhost:3000/api/realtime/publish',
      authToken: () => Promise.resolve(activeToken),
      pollInterval: 1000
    });

    const client = createRealtimeClient({
      transport,
      connectionPolicy: 'direct'
    });

    const received: any[] = [];
    const unsubscribe = await client.subscribe('ticks', (tick) => {
      received.push(tick);
    });

    // Wait for at least one HTTP poll interval
    await new Promise((resolve) => setTimeout(resolve, 4000));

    expect(client.state).toBe('connected');
    expect(received.length).toBeGreaterThan(0);
    expect(received[0].symbol).toBe('BTC/USD');

    await unsubscribe();
    await client.destroy();
  });

  it('should fail connection and transition to error on invalid tokens', async () => {
    const transport = new WebSocketTransport('ws://localhost:3000/api/realtime/socket', {
      authToken: 'invalid-auth-token'
    });

    const client = createRealtimeClient({
      transport,
      connectionPolicy: 'direct',
      reconnectOptions: { maxAttempts: 1, delay: 500 }
    });

    // Make a subscription to trigger connection
    const unsubscribe = await client.subscribe('ticks', () => {});

    // Wait ample time (4s) for the connection attempts to fail and exhaust retries
    await new Promise((resolve) => setTimeout(resolve, 4000));

    expect(client.state).toBe('error');

    await unsubscribe();
    await client.destroy();
  });

  it('should dynamically recover from expired tokens using authToken callbacks on retry', async () => {
    let tokenToUse = 'expired-or-invalid-token';

    const transport = new WebSocketTransport('ws://localhost:3000/api/realtime/socket', {
      authToken: () => Promise.resolve(tokenToUse)
    });

    const client = createRealtimeClient({
      transport,
      connectionPolicy: 'direct',
      reconnectOptions: { maxAttempts: 5, delay: 1000 }
    });

    // Subscribe to trigger connection
    const unsubscribe = await client.subscribe('ticks', () => {});

    // Wait for connection to fail initially
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(client.state).toBe('reconnecting');

    // Dynamically update the token variable to a valid token in the background
    const freshToken = await getValidToken();
    tokenToUse = freshToken;

    // Await core reconnect loop to retry and succeed
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(client.state).toBe('connected');

    await unsubscribe();
    await client.destroy();
  }, 10000);
});
