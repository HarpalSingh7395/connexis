import { createRealtimeClient, ConnectionManager, ConnectionState } from '@connexis/core';
import { MockTransport } from './mock-transport.js';

/**
 * Benchmark Results Interface
 */
export interface BenchmarkReport {
  operation: string;
  count: number;
  durationMs: number;
  opsPerSecond: number;
}

/**
 * Runs a performance benchmark for core client operations.
 */
export async function runBenchmarks(): Promise<BenchmarkReport[]> {
  const reports: BenchmarkReport[] = [];
  const transport = new MockTransport();

  // 1. Subscribe/Unsubscribe Benchmark
  {
    const client = createRealtimeClient({ transport });
    const start = performance.now();
    const count = 10000;
    const unsubs: Array<() => Promise<void>> = [];

    for (let i = 0; i < count; i++) {
      const unsub = await client.subscribe(`topic_${i}`, () => {});
      unsubs.push(unsub);
    }
    for (const unsub of unsubs) {
      await unsub();
    }
    const duration = performance.now() - start;
    reports.push({
      operation: 'subscribe + unsubscribe',
      count,
      durationMs: duration,
      opsPerSecond: (count * 2) / (duration / 1000)
    });
    await client.destroy();
  }

  // 2. Publish Throughput & Latency Benchmark
  {
    const client = createRealtimeClient({ transport });
    // Spin up connection
    await client.subscribe('test', () => {});
    
    const count = 50000;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      await client.publish('test', { seq: i });
    }
    const duration = performance.now() - start;
    reports.push({
      operation: 'publish message',
      count,
      durationMs: duration,
      opsPerSecond: count / (duration / 1000)
    });
    await client.destroy();
  }

  return reports;
}

/**
 * Scenario: Stress test hybrid policy deduplication with 1,000 subscriptions.
 */
export async function runHybridStressTest(): Promise<{ connectionsCount: number; subscriptionsCount: number }> {
  const transport = new MockTransport();
  const manager = new ConnectionManager(transport, 'hybrid');

  const count = 1000;
  // Deduplicate onto 5 unique filters
  const filters = [
    { region: 'US' },
    { region: 'EU' },
    { region: 'AP' },
    { region: 'US' }, // duplicate of 0
    { region: 'EU' }  // duplicate of 1
  ];

  for (let i = 0; i < count; i++) {
    const filter = filters[i % filters.length];
    await manager.subscribe({ id: `sub_${i}`, topic: 'orders', filter }, () => {});
  }

  const connectionsCount = manager.getConnections().size;
  const subscriptionsCount = manager.getActiveSubscriptionCount();

  await manager.destroy();

  return { connectionsCount, subscriptionsCount };
}

/**
 * Scenario: Simulate 10 tabs and trigger random network online/offline events.
 */
export async function runNetworkChaosStressTest(cycles = 20): Promise<{ success: boolean }> {
  const transport = new MockTransport();
  const connections: any[] = [];

  for (let i = 0; i < 10; i++) {
    const conn = createRealtimeClient({ transport });
    await conn.subscribe('alerts', () => {});
    connections.push(conn);
  }

  for (let i = 0; i < cycles; i++) {
    const shouldOffline = Math.random() > 0.5;
    if (shouldOffline) {
      transport.simulateStateChange('offline');
    } else {
      transport.simulateStateChange('connected');
    }
  }

  // Recover everything
  transport.simulateStateChange('connected');

  for (const conn of connections) {
    await conn.destroy();
  }

  return { success: true };
}
