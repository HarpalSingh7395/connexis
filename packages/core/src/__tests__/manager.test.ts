import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionManager } from '../manager.js';
import { MockTransport } from '../../../testing/src/mock-transport.js';

describe('ConnectionManager', () => {
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
  });

  it('should implement isolated policy (each client instance has its own connection)', async () => {
    const mgr1 = new ConnectionManager(transport, 'isolated');
    const mgr2 = new ConnectionManager(transport, 'isolated');

    await mgr1.subscribe({ id: '1', topic: 'news' }, () => {});
    await mgr2.subscribe({ id: '2', topic: 'news' }, () => {});

    expect(mgr1.getConnections().size).toBe(1);
    expect(mgr2.getConnections().size).toBe(1);

    const keys1 = Array.from(mgr1.getConnections().keys());
    const keys2 = Array.from(mgr2.getConnections().keys());
    expect(keys1[0]).not.toBe(keys2[0]);

    await mgr1.destroy();
    await mgr2.destroy();
  });

  it('should implement hybrid policy (deduplicates subscriptions by topic & filter)', async () => {
    const mgr = new ConnectionManager(transport, 'hybrid');

    // Identical subscriptions
    const unsub1 = await mgr.subscribe({ id: '1', topic: 'orders', filter: { region: 'US' } }, () => {});
    const unsub2 = await mgr.subscribe({ id: '2', topic: 'orders', filter: { region: 'US' } }, () => {});

    // Total connections should be 1
    expect(mgr.getConnections().size).toBe(1);

    // Different filter
    const unsub3 = await mgr.subscribe({ id: '3', topic: 'orders', filter: { region: 'EU' } }, () => {});
    expect(mgr.getConnections().size).toBe(2);

    await unsub1();
    await unsub2();
    // Releasing the US subscriptions should clean up that connection, leaving only EU active
    expect(mgr.getConnections().size).toBe(1);

    await unsub3();
    expect(mgr.getConnections().size).toBe(0);
    await mgr.destroy();
  });

  it('should support custom policy', async () => {
    const customPolicy = (sub: any) => sub.metadata?.shardKey || 'default';
    const mgr = new ConnectionManager(transport, customPolicy);

    await mgr.subscribe({ id: '1', topic: 'orders', metadata: { shardKey: 'shard_A' } }, () => {});
    await mgr.subscribe({ id: '2', topic: 'orders', metadata: { shardKey: 'shard_A' } }, () => {});
    await mgr.subscribe({ id: '3', topic: 'orders', metadata: { shardKey: 'shard_B' } }, () => {});

    expect(mgr.getConnections().size).toBe(2);
    expect(Array.from(mgr.getConnections().keys()).sort()).toEqual(['custom_shard_A', 'custom_shard_B']);
    
    await mgr.destroy();
  });
});
