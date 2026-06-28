import {
  RealtimeClientConfig,
  Subscription,
  Middleware,
  MiddlewareContext,
  ConnectionState,
  Metrics
} from './types.js';
import { ConnectionManager } from './manager.js';
import { compose } from './middleware.js';
import { Logger } from './logger.js';
import { EventEmitter } from './event-emitter.js';

export interface SubscribeOptions {
  filter?: Record<string, any>;
  metadata?: Record<string, any>;
}

interface ClientEvents {
  stateChange: { state: ConnectionState };
  metricsChange: Metrics;
}

export class RealtimeClient<TEvents extends Record<string, any> = any> extends EventEmitter<ClientEvents> {
  private manager: ConnectionManager;
  private middlewares: Middleware[] = [];
  private logger: Logger;
  private subCount = 0;

  constructor(private config: RealtimeClientConfig) {
    super();
    this.logger = new Logger(config.debug);
    this.manager = new ConnectionManager(
      config.transport,
      config.connectionPolicy || 'isolated',
      config.reconnectOptions,
      config.heartbeatOptions,
      config.debug,
      config.coordinator
    );

    // Bubble events from manager
    this.manager.on('stateChange', () => {
      this.emit('stateChange', { state: this.state });
    });

    this.manager.on('metricsChange', () => {
      this.emit('metricsChange', this.metrics);
    });
  }

  /**
   * Registers a middleware in the client pipeline.
   */
  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * Gets the aggregated connection state across all active connections.
   */
  get state(): ConnectionState {
    const connections = Array.from(this.manager.getConnections().values());
    if (connections.length === 0) return 'idle';
    
    const states = connections.map(c => c.state);
    if (states.includes('reconnecting')) return 'reconnecting';
    if (states.includes('connecting')) return 'connecting';
    if (states.includes('connected')) return 'connected';
    if (states.includes('offline')) return 'offline';
    if (states.includes('error')) return 'error';
    return 'closed';
  }

  /**
   * Aggregates metrics from all active connections.
   */
  get metrics(): Metrics {
    const connections = Array.from(this.manager.getConnections().values());
    const result: Metrics = {
      reconnectCount: 0,
      latency: 0,
      uptime: 0,
      transportType: this.config.transport.type,
      connectionCount: connections.length,
      activeSubscriptions: this.manager.getActiveSubscriptionCount(),
      leaderChanges: 0,
      throughput: { inbound: 0, outbound: 0 }
    };

    let totalLatency = 0;
    connections.forEach(conn => {
      const m = conn.metrics;
      result.reconnectCount += m.reconnectCount;
      totalLatency += m.latency;
      result.uptime = Math.max(result.uptime, m.uptime);
      result.throughput.inbound += m.throughput.inbound;
      result.throughput.outbound += m.throughput.outbound;
    });

    if (connections.length > 0) {
      result.latency = totalLatency / connections.length;
    }

    return result;
  }

  /**
   * Subscribes to a topic.
   */
  async subscribe<K extends keyof TEvents>(
    topic: K,
    handler: (data: TEvents[K]) => void
  ): Promise<() => Promise<void>>;

  async subscribe<K extends keyof TEvents>(
    topic: K,
    options: SubscribeOptions,
    handler: (data: TEvents[K]) => void
  ): Promise<() => Promise<void>>;

  async subscribe<K extends keyof TEvents>(
    topic: K,
    optionsOrHandler: SubscribeOptions | ((data: TEvents[K]) => void),
    handlerOrUndefined?: (data: TEvents[K]) => void
  ): Promise<() => Promise<void>> {
    const options = typeof optionsOrHandler === 'object' ? optionsOrHandler : {};
    const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : handlerOrUndefined;

    if (!handler) {
      throw new Error('Subscriber handler function is required');
    }

    this.subCount++;
    const subscription: Subscription = {
      id: `sub_${this.subCount}_${Date.now()}`,
      topic: topic as string,
      filter: options.filter,
      metadata: options.metadata
    };

    // Middleware wrapped handler for inbound messages
    const wrappedHandler = async (payload: any) => {
      const context: MiddlewareContext = {
        direction: 'inbound',
        topic: topic as string,
        payload,
        metadata: options.metadata
      };

      try {
        const pipeline = compose(this.middlewares);
        await pipeline(context, async () => {
          handler(context.payload);
        });
      } catch (err) {
        this.logger.warn('Client', `Middleware rejected message for topic: ${String(topic)}`, err);
      }
    };

    return this.manager.subscribe(subscription, wrappedHandler);
  }

  /**
   * Publishes data to a topic.
   */
  async publish<K extends keyof TEvents>(topic: K, payload: TEvents[K]): Promise<void> {
    const context: MiddlewareContext = {
      direction: 'outbound',
      topic: topic as string,
      payload
    };

    const pipeline = compose(this.middlewares);
    await pipeline(context, async () => {
      await this.manager.publish(context.topic, context.payload);
    });
  }

  /**
   * Completely destroys the client instance and all connections.
   */
  async destroy(): Promise<void> {
    this.logger.info('Client', 'Destroying client');
    await this.manager.destroy();
    this.removeAllListeners();
  }
}

/**
 * Factory function to create a new RealtimeClient instance.
 */
export function createRealtimeClient<TEvents extends Record<string, any> = any>(
  config: RealtimeClientConfig
): RealtimeClient<TEvents> {
  return new RealtimeClient<TEvents>(config);
}
