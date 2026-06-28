import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRealtimeClient } from '../client.js';
import { MockTransport } from '../../../testing/src/mock-transport.js';

interface TestEvents {
  orders: { id: string; region: string; total: number };
  notifications: { text: string };
}

describe('RealtimeClient', () => {
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
  });

  it('should publish messages through middleware', async () => {
    const client = createRealtimeClient<TestEvents>({ transport });

    const middlewareLogs: string[] = [];
    client.use(async (ctx, next) => {
      middlewareLogs.push(`${ctx.direction}:${ctx.topic}`);
      if (ctx.direction === 'outbound' && ctx.topic === 'orders') {
        ctx.payload.total += 10; // modify payload
      }
      await next();
    });

    const subHandler = vi.fn();
    await client.subscribe('orders', subHandler);

    // Get the underlying transport clone that gets spun up by the manager
    const connectionKey = Array.from((client as any).manager.getConnections().keys())[0];
    const activeTransport = (client as any).manager.getConnections().get(connectionKey)
      .transport as MockTransport;

    await client.publish('orders', { id: 'o1', region: 'US', total: 100 });

    expect(activeTransport.published[0].data).toEqual({ id: 'o1', region: 'US', total: 110 });
    expect(middlewareLogs).toContain('outbound:orders');

    await client.destroy();
  });

  it('should deliver inbound messages through middleware to subscribers', async () => {
    const client = createRealtimeClient<TestEvents>({ transport });

    client.use(async (ctx, next) => {
      if (ctx.direction === 'inbound' && ctx.topic === 'notifications') {
        ctx.payload.text = ctx.payload.text.toUpperCase();
      }
      await next();
    });

    const subHandler = vi.fn();
    await client.subscribe('notifications', subHandler);

    const connectionKey = Array.from((client as any).manager.getConnections().keys())[0];
    const activeTransport = (client as any).manager.getConnections().get(connectionKey)
      .transport as MockTransport;

    activeTransport.simulateMessage('notifications', { text: 'hello' });

    expect(subHandler).toHaveBeenCalledWith({ text: 'HELLO' });

    await client.destroy();
  });
});
