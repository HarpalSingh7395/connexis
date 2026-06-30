import {
  ConnectionState,
  Transport,
  ReconnectOptions,
  HeartbeatOptions,
  Metrics
} from './types.js';
import { EventEmitter } from './event-emitter.js';
import { Logger } from './logger.js';

interface ConnectionEvents {
  stateChange: { state: ConnectionState; error?: Error };
  message: { topic: string; data: any };
  metricsChange: Metrics;
  error: Error;
}

export class Connection extends EventEmitter<ConnectionEvents> {
  private _state: ConnectionState = 'idle';
  private _metrics: Metrics;
  private reconnectAttempt = 0;
  private reconnectTimer: any = null;
  private stableTimer: any = null;
  private heartbeatIntervalTimer: any = null;
  private heartbeatTimeoutTimer: any = null;
  private lastActiveTime = Date.now();
  private connectStartTime = 0;
  private logger: Logger;
  private isIntentionallyClosed = false;

  constructor(
    public readonly transport: Transport,
    private reconnectOptions: ReconnectOptions = {},
    private heartbeatOptions: HeartbeatOptions = {},
    debug = false
  ) {
    super();
    this.logger = new Logger(debug);
    this._metrics = this.initMetrics();

    // Default options
    this.reconnectOptions = {
      maxAttempts: Infinity,
      delay: (attempt) => Math.min(1000 * Math.pow(2, attempt - 1), 30000), // exponential backoff
      timeout: 10000,
      ...reconnectOptions
    };

    this.heartbeatOptions = {
      enabled: true,
      interval: 30000,
      timeout: 5000,
      message: 'ping',
      ...heartbeatOptions
    };

    // Set up transport listeners
    this.transport.onMessage((topic, data) => {
      this.handleMessage(topic, data);
    });

    this.transport.onStateChange((state, error) => {
      this.handleTransportStateChange(state, error);
    });

    // Browser online detection
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
    }
  }

  get state(): ConnectionState {
    return this._state;
  }

  get metrics(): Metrics {
    return { ...this._metrics };
  }

  private initMetrics(): Metrics {
    return {
      reconnectCount: 0,
      latency: 0,
      uptime: 0,
      transportType: this.transport.type,
      connectionCount: 1,
      activeSubscriptions: 0,
      leaderChanges: 0,
      throughput: {
        inbound: 0,
        outbound: 0
      }
    };
  }

  async connect(): Promise<void> {
    this.isIntentionallyClosed = false;
    if (this._state === 'connected' || this._state === 'connecting') {
      return;
    }
    this.transition('connecting');
    this.connectStartTime = Date.now();

    const timeoutMs = this.reconnectOptions.timeout ?? 10000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), timeoutMs)
    );

    try {
      await Promise.race([this.transport.connect(), timeoutPromise]);
      
      const threshold = this.reconnectOptions.stableThreshold ?? 5000;
      this.clearStableTimer();
      this.stableTimer = setTimeout(() => {
        this.reconnectAttempt = 0;
        this.logger.info('Connection', 'Connection stabilized. Resetting reconnect attempts.');
        this.stableTimer = null;
      }, threshold);

      this.transition('connected');
    } catch (err) {
      this.logger.error('Connection', 'Connect failed', err);
      this.handleFailure(err as Error);
    }
  }

  async disconnect(): Promise<void> {
    this.isIntentionallyClosed = true;
    this.clearTimers();
    this.transition('closed');
    try {
      await this.transport.disconnect();
    } catch (err) {
      this.logger.error('Connection', 'Disconnect failed', err);
    }
  }

  async publish(topic: string, data: any): Promise<void> {
    if (this._state !== 'connected') {
      throw new Error(`Cannot publish while in state ${this._state}`);
    }
    try {
      await this.transport.publish(topic, data);
      this._metrics.throughput.outbound++;
      this.emit('metricsChange', this.metrics);
    } catch (err) {
      this.emit('error', err as Error);
      throw err;
    }
  }

  async subscribe(topic: string, filter?: Record<string, any>): Promise<void> {
    try {
      await this.transport.subscribe(topic, filter);
      this._metrics.activeSubscriptions++;
      this.emit('metricsChange', this.metrics);
    } catch (err) {
      this.emit('error', err as Error);
      throw err;
    }
  }

  async unsubscribe(topic: string, filter?: Record<string, any>): Promise<void> {
    try {
      await this.transport.unsubscribe(topic, filter);
      this._metrics.activeSubscriptions = Math.max(0, this._metrics.activeSubscriptions - 1);
      this.emit('metricsChange', this.metrics);
    } catch (err) {
      this.emit('error', err as Error);
      throw err;
    }
  }

  private transition(nextState: ConnectionState, error?: Error): void {
    if (this._state === nextState) return;
    this.logger.info('Connection', `Transitioning from ${this._state} to ${nextState}`);
    this._state = nextState;
    this.emit('stateChange', { state: nextState, error });

    if (nextState === 'connected') {
      this.startHeartbeat();
      this.updateUptime();
    } else {
      this.stopHeartbeat();
    }
  }

  private handleTransportStateChange(state: ConnectionState, error?: Error) {
    if (this.isIntentionallyClosed) {
      return;
    }
    if (state === 'closed' || state === 'error') {
      this.handleFailure(error || new Error(`Transport transitioned to ${state}`));
    } else {
      this.transition(state, error);
    }
  }

  private handleFailure(error: Error): void {
    if (this._state === 'reconnecting') {
      return;
    }

    this.clearTimers();

    if (this.isIntentionallyClosed) {
      this.transition('closed');
      return;
    }

    if (typeof window !== 'undefined' && !window.navigator.onLine) {
      this.transition('offline', error);
      return;
    }

    const maxAttempts = this.reconnectOptions.maxAttempts ?? Infinity;
    if (this.reconnectAttempt >= maxAttempts) {
      this.logger.warn(
        'Connection',
        `Max reconnect attempts (${maxAttempts}) reached. Setting state to error.`
      );
      this.transition('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempt++;
    this._metrics.reconnectCount++;
    this.emit('metricsChange', this.metrics);
    this.transition('reconnecting', error);

    const delayOption = this.reconnectOptions.delay ?? 1000;
    const delay =
      typeof delayOption === 'function' ? delayOption(this.reconnectAttempt) : delayOption;

    this.logger.info(
      'Connection',
      `Scheduling reconnect attempt ${this.reconnectAttempt} in ${delay}ms`
    );
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private handleMessage(topic: string, data: any): void {
    this._metrics.throughput.inbound++;
    this.emit('metricsChange', this.metrics);

    // Check if it is a heartbeat response
    if (
      topic === '__heartbeat__' ||
      (topic === this.heartbeatOptions.message && data === 'pong') ||
      data === 'pong'
    ) {
      this.handleHeartbeatResponse();
    }

    this.emit('message', { topic, data });
  }

  private handleHeartbeatResponse(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
    const currentLatency = Date.now() - this.lastActiveTime;
    this._metrics.latency = currentLatency;
    this.emit('metricsChange', this.metrics);
  }

  private startHeartbeat(): void {
    if (!this.heartbeatOptions.enabled) return;
    this.stopHeartbeat();

    this.heartbeatIntervalTimer = setInterval(async () => {
      if (this._state !== 'connected') return;

      this.lastActiveTime = Date.now();

      // Start timeout timer
      const timeoutMs = this.heartbeatOptions.timeout ?? 5000;
      this.heartbeatTimeoutTimer = setTimeout(() => {
        this.logger.warn('Connection', 'Heartbeat timeout. Assuming dead connection.');
        this.handleFailure(new Error('Heartbeat timeout'));
      }, timeoutMs);

      try {
        // Send heartbeat ping
        if (this.transport.capabilities().publish) {
          await this.transport.publish('__heartbeat__', this.heartbeatOptions.message);
        }
      } catch (err) {
        this.logger.warn('Connection', 'Failed to send heartbeat', err);
      }
    }, this.heartbeatOptions.interval ?? 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatIntervalTimer) {
      clearInterval(this.heartbeatIntervalTimer);
      this.heartbeatIntervalTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private updateUptime(): void {
    if (this._state === 'connected') {
      this._metrics.uptime = Date.now() - this.connectStartTime;
      this.emit('metricsChange', this.metrics);
    }
  }

  private handleOnline = () => {
    this.logger.info('Connection', 'Browser came online');
    if (this._state === 'offline' || this._state === 'error' || this._state === 'closed') {
      if (!this.isIntentionallyClosed) {
        this.reconnectAttempt = 0;
        this.connect();
      }
    }
  };

  private handleOffline = () => {
    this.logger.info('Connection', 'Browser went offline');
    this.clearTimers();
    this.transition('offline');
  };

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearStableTimer();
    this.stopHeartbeat();
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  destroy(): void {
    this.clearTimers();
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('offline', this.handleOffline);
    }
    this.removeAllListeners();
  }
}
