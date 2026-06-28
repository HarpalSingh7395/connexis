# @connexis Realtime Client

A production-grade, framework-agnostic, universal browser realtime client with intelligent connection management and multi-tab synchronization.

📖 **[Read the Documentation Website](https://HarpalSingh7395.github.io/connexis/)**

**This is NOT just an SSE library. This is NOT a simple WebSocket wrapper.**

`@connexis` acts as a connection manager for browser realtime transports, handling state machines, heartbeats, exponential reconnects, multi-tab leader election, connection sharing, subscription deduplication, and framework hooks.

---

## Key Features

* 🔌 **Transport Agnostic**: Support for WebSockets, SSE (EventSource), and HTTP Polling. Extensible to WebTransport.
* 👥 **Multi-Tab Connection Sharing**: Elects a single leader tab to maintain the socket connection. All other tabs communicate with the leader via `SharedWorker` or `BroadcastChannel`.
* ⚖️ **Flexible Connection Policies**:
  * **Isolated**: Each client has its own dedicated connection.
  * **Shared**: A single shared connection per browser window/tab group.
  * **Hybrid**: Automatically deduplicates subscriptions with matching filters onto a single shared connection while spawning dedicated connections for distinct filters.
  * **Custom**: Provide a custom key selector function.
* ⚙️ **Middleware Pipeline**: Inspect, log, modify, or reject inbound/outbound payloads using Koa-style `next()` middlewares.
* ⚛️ **Framework Hooks**: Sleek React wrapper (`@connexis/react`) providing simple hooks like `useConnection`, `useSubscription` (or `useChannel`), and `usePublish`.
* 📈 **Latency & Throughput Metrics**: Active calculation of latency (via heartbeat ping/pong rounds), uptime, reconnect counts, and inbound/outbound throughput.

---

## Monorepo Packages

```
packages/
  ├── core/               # Lifecycle State Machine, Connection Pool, Middleware, Client API
  ├── coordinator/        # BroadcastChannel & SharedWorker Coordination, Leader Election, Failover
  ├── transport-sse/      # EventSource Server-Sent Events Transport with HTTP POST publish fallback
  ├── transport-websocket/# Native WebSocket Transport
  ├── transport-polling/  # HTTP Polling Transport
  ├── react/              # React Context Provider & Hooks
  └── testing/            # Controllable MockTransport & Benchmark Runner
```

---

## Architecture Diagram

```mermaid
graph TD
    App[Application Code] --> React[React Wrapper]
    React --> Client[Connexis Client]
    App --> Client
    Client --> ConnMgr[Connection Manager]
    ConnMgr --> Coordinator[Coordinator]
    ConnMgr --> ConnPool[Connection Pool]
    ConnPool --> SSE[SSE Transport]
    ConnPool --> WS[WebSocket Transport]
    ConnPool --> Polling[Polling Transport]
```

### Connection State Machine

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> connecting : connect()
    connecting --> connected : transport open
    connecting --> reconnecting : fail / disconnect
    connected --> reconnecting : connection lost
    connected --> closed : disconnect()
    reconnecting --> connected : open success
    reconnecting --> offline : max retries / network offline
    offline --> reconnecting : network online / manual retry
    reconnecting --> error : fatal error
    error --> closed
    closed --> [*]
```

---

## Quick Start Example

```typescript
import { createRealtimeClient } from '@connexis/core';
import { WebSocketTransport } from '@connexis/transport-websocket';
import { Coordinator } from '@connexis/coordinator';

// 1. Initialize the client
const client = createRealtimeClient({
  transport: new WebSocketTransport('wss://api.example.com/realtime'),
  connectionPolicy: 'shared',
  coordinator: new Coordinator('my_app') // Optional: Enables multi-tab connection sharing
});

// 2. Define typed events (TypeScript first)
interface AppEvents {
  orders: { id: string; region: string; total: number };
  notifications: { text: string };
}

const typedClient = client as RealtimeClient<AppEvents>;

// 3. Register Middlewares
typedClient.use(async (context, next) => {
  console.log(`[Middleware] ${context.direction} message on ${context.topic}`, context.payload);
  await next();
});

// 4. Subscribe to topics
const unsubscribe = await typedClient.subscribe('orders', { filter: { region: 'US' } }, (order) => {
  console.log(`New Order in US: $${order.total}`);
});

// 5. Publish events
await typedClient.publish('orders', { id: 'order_123', region: 'US', total: 250 });

// 6. Access Metrics
console.log('Uptime:', typedClient.metrics.uptime);
console.log('Average Latency:', typedClient.metrics.latency, 'ms');
```

---

## React Hooks Example

Wrap your application in `RealtimeProvider` and use the built-in hooks:

```tsx
import React from 'react';
import { RealtimeProvider, useConnection, useSubscription, usePublish } from '@connexis/react';
import { client } from './client';

export function Dashboard() {
  const { state, metrics } = useConnection();
  const publish = usePublish();

  // Automatic subscribe on mount, unsubscribe on unmount
  useSubscription('orders', { filter: { region: 'US' } }, (order) => {
    console.log('Received order:', order);
  });

  return (
    <div>
      <div>Status: {state}</div>
      <div>Latency: {metrics.latency.toFixed(1)} ms</div>
      <button onClick={() => publish('notifications', { text: 'Hello World' })}>
        Send Alert
      </button>
    </div>
  );
}

export function App() {
  return (
    <RealtimeProvider client={client}>
      <Dashboard />
    </RealtimeProvider>
  );
}
```

---

## Failover Sequence Diagram

When the Leader tab closes, a clean `leader_exit` broadcast is sent, prompting follower tabs to immediately start an election and migrate subscriptions to the new leader:

```mermaid
sequenceDiagram
    participant TabA as Leader Tab (Closing)
    participant TabB as Follower Tab
    participant Server as Realtime Server

    Note over TabA,Server: Normal operation: Tab B delegates to Tab A
    TabA->>Server: Real Transport Connection (active)
    Note over TabA: User closes Tab A / Refreshes
    TabA->>TabB: BroadcastChannel ('leader_exit')
    TabA->>Server: Close Socket
    Note over TabB: Tab B detects leader exit
    TabB->>TabB: Start Election (Oldest wins)
    Note over TabB: Tab B is promoted to Leader
    TabB->>Server: Open Direct Connection
    TabB->>Server: Re-subscribe active filters
```

---

## Performance & Stress Testing

We include a comprehensive mock-driven benchmark and stress suite under `packages/testing`:

* **Subscription Throttling**: Verifies reference counting and connection recycling.
* **Hybrid Deduplication**: Asserts that 1,000 subscriptions split over 3 unique filter values generate exactly 3 connection handles.
* **Online/Offline Chaos Simulation**: Simulates severe network volatility (online/offline transitions) to ensure eventual consistency.
* **Throughput Benchmarks**: Tracks overhead of Koa-style middlewares.

To run the benchmarks:
```bash
pnpm run test
```

*Typical benchmark numbers on a local development machine:*
```
┌─────────┬───────────────────────────┬───────┬────────────┬──────────────┐
│ (index) │ operation                 │ count │ durationMs │ opsPerSecond │
├─────────┼───────────────────────────┼───────┼────────────┼──────────────┤
│ 0       │ 'subscribe + unsubscribe' │ 10000 │ 1242.3     │ 16098.0      │
│ 1       │ 'publish message'         │ 50000 │ 133.6      │ 374174.6     │
└─────────┴───────────────────────────┴───────┴────────────┴──────────────┘
```

---

## License

MIT - See the [LICENSE](LICENSE) file for details.
