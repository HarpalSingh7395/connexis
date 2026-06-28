import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Coordinator } from '../index.js';

// Setup Mock BroadcastChannel in global scope for tests
class MockBroadcastChannel {
  private static channels = new Map<string, Set<MockBroadcastChannel>>();
  public onmessage: ((e: MessageEvent) => void) | null = null;

  constructor(public readonly name: string) {
    if (!MockBroadcastChannel.channels.has(name)) {
      MockBroadcastChannel.channels.set(name, new Set());
    }
    MockBroadcastChannel.channels.get(name)!.add(this);
  }

  postMessage(data: any) {
    const list = MockBroadcastChannel.channels.get(this.name);
    if (!list) return;
    // Async delivery to simulate actual browser event loop tick
    setTimeout(() => {
      list.forEach((c) => {
        if (c !== this && c.onmessage) {
          c.onmessage({ data } as MessageEvent);
        }
      });
    }, 10);
  }

  close() {
    const list = MockBroadcastChannel.channels.get(this.name);
    if (list) {
      list.delete(this);
    }
  }

  static reset() {
    MockBroadcastChannel.channels.clear();
  }
}

describe('Coordinator Leader Election & Failover', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      navigator: { onLine: true }
    });
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.useFakeTimers();
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should elect the first starting tab as the leader', async () => {
    const coord1 = new Coordinator('test_namespace');
    coord1.start();

    // Run query_leader and election timers
    await vi.advanceTimersByTimeAsync(1000);

    expect(coord1.isLeader).toBe(true);
    coord1.destroy();
  });

  it('should make second tab a follower', async () => {
    const coord1 = new Coordinator('test_namespace');
    coord1.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(coord1.isLeader).toBe(true);

    const coord2 = new Coordinator('test_namespace');
    coord2.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(coord2.isLeader).toBe(false);
    expect(coord2.currentLeaderId).toBe(coord1.tabId);

    coord1.destroy();
    coord2.destroy();
  });

  it('should perform failover when leader is destroyed', async () => {
    const coord1 = new Coordinator('test_namespace');
    const coord2 = new Coordinator('test_namespace');

    coord1.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(coord1.isLeader).toBe(true);

    coord2.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(coord2.isLeader).toBe(false);

    // leader exit triggers clean election
    coord1.destroy();

    // Process the election ticks
    await vi.advanceTimersByTimeAsync(2000);

    expect(coord2.isLeader).toBe(true);
    coord2.destroy();
  });
});
