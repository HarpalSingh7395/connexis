import { describe, it, expect } from 'vitest';
import { runBenchmarks, runHybridStressTest, runNetworkChaosStressTest } from '../stress-and-bench.js';

describe('Performance Benchmarks & Stress Tests', () => {
  it('should run core performance benchmarks and yield throughput values', async () => {
    const reports = await runBenchmarks();
    
    // Print reports to stdout
    console.table(reports);
    
    expect(reports.length).toBe(2);
    expect(reports[0].opsPerSecond).toBeGreaterThan(0);
    expect(reports[1].opsPerSecond).toBeGreaterThan(0);
  });

  it('should run hybrid stress test and correctly deduplicate connection count', async () => {
    // 1,000 subscriptions split across 5 unique filter groups -> should result in exactly 3 unique filter signatures
    // (since region US, EU, AP are 3 distinct values, and the duplicates group onto them)
    const { connectionsCount, subscriptionsCount } = await runHybridStressTest();
    
    expect(subscriptionsCount).toBe(1000);
    expect(connectionsCount).toBe(3); // 'orders' with region US, EU, AP
  });

  it('should run network chaos stress test without leaking subscriptions or crashing', async () => {
    const { success } = await runNetworkChaosStressTest(10);
    expect(success).toBe(true);
  });
});
