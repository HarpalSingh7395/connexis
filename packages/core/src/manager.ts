import {
  Subscription,
  ConnectionPolicy,
  Transport,
  ReconnectOptions,
  HeartbeatOptions,
  ConnectionState,
  Metrics,
  ICoordinator
} from './types.js';
import { Connection } from './connection.js';
import { Logger } from './logger.js';
import { EventEmitter } from './event-emitter.js';

interface ManagerEvents {
  stateChange: { connectionKey: string; state: ConnectionState; error?: Error };
  message: { topic: string; data: any; connectionKey: string };
  metricsChange: { connectionKey: string; metrics: Metrics };
  error: { connectionKey: string; error: Error };
}

export class ConnectionManager extends EventEmitter<ManagerEvents> {
  private connections = new Map<string, Connection>();
  private refCounts = new Map<string, number>();
  
  // Local active subscriptions
  private subscriptions = new Map<
    string,
    {
      subscription: Subscription;
      connectionKey: string;
      handler: (data: any) => void;
      removeListener?: () => void;
      unsubDirect?: () => Promise<void>;
    }
  >();

  // Leader-only: Tracks follower subscription id to their unsubscribe functions
  private followerSubscriptions = new Map<string, () => Promise<void>>();

  private logger: Logger;
  private clientId: string;
  private coordinatorUnsubscribe: (() => void) | null = null;

  constructor(
    private baseTransport: Transport,
    private policy: ConnectionPolicy = 'isolated',
    private reconnectOptions: ReconnectOptions = {},
    private heartbeatOptions: HeartbeatOptions = {},
    private debug = false,
    private coordinator?: ICoordinator
  ) {
    super();
    this.logger = new Logger(debug);
    this.clientId = Math.random().toString(36).substring(2, 11);

    if (this.coordinator) {
      this.setupCoordinator();
    }
  }

  private stableStringify(obj: any): string {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      return '[' + obj.map(item => this.stableStringify(item)).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => `${JSON.stringify(k)}:${this.stableStringify(obj[k])}`).join(',') + '}';
  }

  getConnectionKey(subscription: Subscription): string {
    if (this.policy === 'isolated') {
      return `isolated_${this.clientId}`;
    }
    if (this.policy === 'shared') {
      return 'shared';
    }
    if (this.policy === 'hybrid') {
      const filterStr = this.stableStringify(subscription.filter);
      return `hybrid_${subscription.topic}_${filterStr}`;
    }
    if (typeof this.policy === 'function') {
      return `custom_${this.policy(subscription)}`;
    }
    return `default_${this.clientId}`;
  }

  /**
   * Subscribes to a subscription. Delegates to coordinator if configured and not leader.
   */
  async subscribe(
    subscription: Subscription,
    handler: (data: any) => void
  ): Promise<() => Promise<void>> {
    // If coordinator is active and we are follower, delegate
    if (this.coordinator && !this.coordinator.isLeader) {
      this.logger.info('Manager', `Delegating subscription ${subscription.id} to leader`);
      
      this.subscriptions.set(subscription.id, {
        subscription,
        connectionKey: 'shared_coordinated',
        handler
      });

      this.coordinator.sendToLeader({
        action: 'subscribe',
        subId: subscription.id,
        subscription
      });

      return async () => {
        this.subscriptions.delete(subscription.id);
        if (this.coordinator && !this.coordinator.isLeader) {
          this.coordinator.sendToLeader({
            action: 'unsubscribe',
            subId: subscription.id
          });
        }
      };
    }

    // Direct subscription (either no coordinator, or we are the leader)
    return this.subscribeDirect(subscription, handler);
  }

  private async subscribeDirect(
    subscription: Subscription,
    handler: (data: any) => void
  ): Promise<() => Promise<void>> {
    const key = this.getConnectionKey(subscription);
    this.logger.info('Manager', `Direct subscribe for key=${key}`);

    let connection = this.connections.get(key);
    if (!connection) {
      const transportInstance = this.baseTransport.clone();
      connection = new Connection(
        transportInstance,
        this.reconnectOptions,
        this.heartbeatOptions,
        this.debug
      );
      this.connections.set(key, connection);
      this.refCounts.set(key, 0);

      connection.on('stateChange', ({ state, error }) => {
        this.emit('stateChange', { connectionKey: key, state, error });
      });

      connection.on('message', ({ topic, data }) => {
        this.emit('message', { topic, data, connectionKey: key });
      });

      connection.on('metricsChange', (metrics) => {
        this.emit('metricsChange', { connectionKey: key, metrics });
      });

      connection.on('error', (error) => {
        this.emit('error', { connectionKey: key, error });
      });

      connection.connect().catch(err => {
        this.logger.error('Manager', `Direct connection connect failed for ${key}`, err);
      });
    }

    this.refCounts.set(key, (this.refCounts.get(key) || 0) + 1);

    const removeMessageListener = connection.on('message', ({ topic, data }) => {
      if (topic === subscription.topic) {
        if (subscription.filter && !this.matchFilter(data, subscription.filter)) {
          return;
        }
        handler(data);
      }
    });

    if (connection.state === 'connected') {
      await connection.subscribe(subscription.topic, subscription.filter);
    } else {
      const unsubState = connection.on('stateChange', async ({ state }) => {
        if (state === 'connected') {
          await connection?.subscribe(subscription.topic, subscription.filter);
          unsubState();
        }
      });
    }

    const unsubDirect = async () => {
      removeMessageListener();
      const connection = this.connections.get(key);
      if (connection) {
        try {
          await connection.unsubscribe(subscription.topic, subscription.filter);
        } catch (err) {
          // ignore
        }
        const refs = (this.refCounts.get(key) || 1) - 1;
        this.refCounts.set(key, refs);

        if (refs <= 0) {
          this.connections.delete(key);
          this.refCounts.delete(key);
          await connection.disconnect();
          connection.destroy();
        }
      }
    };

    this.subscriptions.set(subscription.id, {
      subscription,
      connectionKey: key,
      handler,
      unsubDirect
    });

    return unsubDirect;
  }

  private matchFilter(data: any, filter: Record<string, any>): boolean {
    if (!data || typeof data !== 'object') return false;
    for (const [key, val] of Object.entries(filter)) {
      if (data[key] !== val) return false;
    }
    return true;
  }

  async publish(topic: string, data: any): Promise<void> {
    if (this.coordinator && !this.coordinator.isLeader) {
      this.logger.info('Manager', `Delegating publish to leader`);
      this.coordinator.sendToLeader({
        action: 'publish',
        topic,
        data
      });
      return;
    }

    // Direct publish (leader or isolated)
    const activeConnection = Array.from(this.connections.values()).find(
      c => c.state === 'connected'
    );

    if (activeConnection) {
      await activeConnection.publish(topic, data);
    } else {
      const key = `temp_pub_${Math.random().toString(36).substring(2, 9)}`;
      const transportInstance = this.baseTransport.clone();
      const tempConnection = new Connection(
        transportInstance,
        this.reconnectOptions,
        this.heartbeatOptions,
        this.debug
      );
      try {
        await tempConnection.connect();
        await tempConnection.publish(topic, data);
      } finally {
        await tempConnection.disconnect();
        tempConnection.destroy();
      }
    }
  }

  /**
   * Setup coordinator messaging and failover sync.
   */
  private setupCoordinator(): void {
    if (!this.coordinator) return;

    this.coordinator.start();

    // Listen to leader changes
    const unsubLeader = this.coordinator.on('leaderChange', async ({ isLeader }) => {
      this.logger.info('Manager', `Coordinator leaderChange. isLeader=${isLeader}`);
      if (isLeader) {
        // Demoted to leader: transition all local subscriptions to direct connections
        const subsToRecreate = Array.from(this.subscriptions.values());
        this.subscriptions.clear();

        for (const subItem of subsToRecreate) {
          const unsub = await this.subscribeDirect(subItem.subscription, subItem.handler);
          subItem.unsubDirect = unsub;
          this.subscriptions.set(subItem.subscription.id, subItem);
        }
      } else {
        // Promoted to follower: tear down all direct connections, resend subs to new leader
        await this.teardownDirectConnections();
        
        const subsToRecreate = Array.from(this.subscriptions.values());
        for (const subItem of subsToRecreate) {
          subItem.connectionKey = 'shared_coordinated';
          subItem.unsubDirect = undefined;
          this.coordinator?.sendToLeader({
            action: 'subscribe',
            subId: subItem.subscription.id,
            subscription: subItem.subscription
          });
        }
      }
    });

    // Listen to coordinator communication
    const unsubMessage = this.coordinator.on('message', async ({ senderId, payload }) => {
      if (!payload || typeof payload !== 'object') return;

      if (this.coordinator?.isLeader) {
        // Process follower messages
        switch (payload.action) {
          case 'subscribe':
            this.logger.info('Manager', `Leader received sub request from ${senderId} for subId=${payload.subId}`);
            const unsub = await this.subscribeDirect(payload.subscription, (data) => {
              this.coordinator?.sendToTab(senderId, {
                action: 'event',
                subId: payload.subId,
                data
              });
            });
            this.followerSubscriptions.set(payload.subId, unsub);
            break;
          case 'unsubscribe':
            this.logger.info('Manager', `Leader received unsub request for subId=${payload.subId}`);
            const unsubFunc = this.followerSubscriptions.get(payload.subId);
            if (unsubFunc) {
              await unsubFunc();
              this.followerSubscriptions.delete(payload.subId);
            }
            break;
          case 'publish':
            await this.publish(payload.topic, payload.data);
            break;
        }
      } else {
        // Process leader messages as follower
        if (payload.action === 'event') {
          const sub = this.subscriptions.get(payload.subId);
          if (sub) {
            sub.handler(payload.data);
          }
        }
      }
    });

    this.coordinatorUnsubscribe = () => {
      unsubLeader();
      unsubMessage();
    };
  }

  private async teardownDirectConnections(): Promise<void> {
    const promises = Array.from(this.connections.values()).map(async c => {
      try {
        await c.disconnect();
      } catch (err) {
        // ignore
      }
      c.destroy();
    });
    await Promise.all(promises);
    this.connections.clear();
    this.refCounts.clear();
    this.followerSubscriptions.clear();
  }

  getConnections(): Map<string, Connection> {
    return this.connections;
  }

  getActiveSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  async destroy(): Promise<void> {
    this.logger.info('Manager', 'Destroying ConnectionManager');
    if (this.coordinatorUnsubscribe) {
      this.coordinatorUnsubscribe();
    }
    if (this.coordinator) {
      this.coordinator.destroy();
    }
    await this.teardownDirectConnections();
    this.subscriptions.clear();
    this.removeAllListeners();
  }
}
