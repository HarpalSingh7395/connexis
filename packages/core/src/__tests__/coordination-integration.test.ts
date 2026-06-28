import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRealtimeClient } from '../client.js';
import { Coordinator } from '../../../coordinator/src/index.js';
import { MockTransport } from '../../../testing/src/mock-transport.js';

// Setup Mock BroadcastChannel in global scope
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
    // Async delivery to simulate actual event loop tick
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

describe('Multi-tab Connection Sharing Integration', () => {
  let transport: MockTransport;

  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      navigator: { onLine: true }
    });
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.useFakeTimers();
    transport = new MockTransport();
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should only open one shared connection and delegate subscriptions', async () => {
    // Client 1 (Leader tab)
    const coord1 = new Coordinator('shared_integ');
    const client1 = createRealtimeClient({
      transport,
      connectionPolicy: 'shared',
      coordinator: coord1
    });

    // Client 2 (Follower tab)
    const coord2 = new Coordinator('shared_integ');
    const client2 = createRealtimeClient({
      transport,
      connectionPolicy: 'shared',
      coordinator: coord2
    });

    // Start election
    await vi.advanceTimersByTimeAsync(1000);

    const leaderCoord = coord1.isLeader ? coord1 : coord2;
    const followerCoord = coord1.isLeader ? coord2 : coord1;

    const leaderClient = coord1.isLeader ? client1 : client2;
    const followerClient = coord1.isLeader ? client2 : client1;

    expect(leaderCoord.isLeader).toBe(true);
    expect(followerCoord.isLeader).toBe(false);

    // Follower subscribes
    const handler = vi.fn();
    await followerClient.subscribe('alerts', handler);

    // Yield so BroadcastChannel delivers subscription request to leader
    await vi.advanceTimersByTimeAsync(100);

    // Check that Follower client has NO active connections (since it is a follower)
    const mgrFollower = (followerClient as any).manager;
    expect(mgrFollower.getConnections().size).toBe(0);

    // Check that Leader client HAS the active connection
    const mgrLeader = (leaderClient as any).manager;
    expect(mgrLeader.getConnections().size).toBe(1);

    const leaderConnKey = Array.from(mgrLeader.getConnections().keys())[0];
    const leaderConn = mgrLeader.getConnections().get(leaderConnKey);
    const activeTransport = leaderConn.transport as MockTransport;

    // Simulate event arriving at leader transport
    activeTransport.simulateMessage('alerts', { message: 'fire' });

    // Tick the event loop so mock BroadcastChannel message delivers
    await vi.advanceTimersByTimeAsync(100);

    // Follower handler should have been executed!
    expect(handler).toHaveBeenCalledWith({ message: 'fire' });

    // Tear down leader (failover occurs!)
    await leaderClient.destroy();

    // Tick election timers
    await vi.advanceTimersByTimeAsync(2000);

    // Follower should now be promoted to leader
    expect(followerCoord.isLeader).toBe(true);

    // Client should now have spun up its own connection to the transport
    expect(mgrFollower.getConnections().size).toBe(1);

    const followerConnKey = Array.from(mgrFollower.getConnections().keys())[0];
    const followerConn = mgrFollower.getConnections().get(followerConnKey);
    const newTransport = followerConn.transport as MockTransport;

    // Send another event to the new transport
    newTransport.simulateMessage('alerts', { message: 'water' });

    // Delivery should happen locally now since client2 is leader
    expect(handler).toHaveBeenCalledWith({ message: 'water' });

    await followerClient.destroy();
  });
});
