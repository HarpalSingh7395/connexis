import { Transport, ConnectionState, TransportCapabilities } from '@connexis/core';

export interface PollingTransportOptions {
  pollInterval?: number;
  publishUrl?: string;
  publish?: (topic: string, data: any) => Promise<void>;
  headers?: Record<string, string>;
}

export class PollingTransport implements Transport {
  public readonly type = 'polling';
  private _state: ConnectionState = 'idle';
  private timer: any = null;
  private isConnected = false;
  private activeSubscriptions = new Set<string>();

  private messageCb: ((topic: string, data: any) => void) | null = null;
  private stateCb: ((state: ConnectionState, error?: Error) => void) | null = null;

  private pollInterval: number;
  private headers: Record<string, string>;

  constructor(
    private url: string,
    private options: PollingTransportOptions = {}
  ) {
    this.pollInterval = options.pollInterval || 5000;
    this.headers = options.headers || {};
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;

    this.isConnected = true;
    this.updateState('connecting');

    // Run first poll immediately
    try {
      await this.poll();
      this.updateState('connected');
    } catch (err) {
      this.isConnected = false;
      this.updateState('error', err as Error);
      throw err;
    }

    this.startPollingLoop();
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.updateState('closed');
  }

  async publish(topic: string, data: any): Promise<void> {
    if (this.options.publish) {
      await this.options.publish(topic, data);
      return;
    }

    if (this.options.publishUrl) {
      const response = await fetch(this.options.publishUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers
        },
        body: JSON.stringify({ topic, data })
      });
      if (!response.ok) {
        throw new Error(`Polling publish request failed with status ${response.status}`);
      }
      return;
    }

    throw new Error(
      'Publishing is not supported by Polling without a configured publishUrl or publish function'
    );
  }

  async subscribe(topic: string, _filter?: Record<string, any>): Promise<void> {
    this.activeSubscriptions.add(topic);
  }

  async unsubscribe(topic: string, _filter?: Record<string, any>): Promise<void> {
    this.activeSubscriptions.delete(topic);
  }

  capabilities(): TransportCapabilities {
    return {
      publish: !!(this.options.publish || this.options.publishUrl),
      subscribe: true,
      latency: 'high'
    };
  }

  onMessage(cb: (topic: string, data: any) => void): void {
    this.messageCb = cb;
  }

  onStateChange(cb: (state: ConnectionState, error?: Error) => void): void {
    this.stateCb = cb;
  }

  clone(): PollingTransport {
    return new PollingTransport(this.url, this.options);
  }

  private startPollingLoop(): void {
    if (!this.isConnected) return;

    this.timer = setTimeout(async () => {
      try {
        await this.poll();
        this.updateState('connected');
      } catch (err) {
        this.updateState('error', err as Error);
      } finally {
        this.startPollingLoop();
      }
    }, this.pollInterval);
  }

  private async poll(): Promise<void> {
    if (!this.isConnected) return;

    const topics = Array.from(this.activeSubscriptions);
    const queryParams = new URLSearchParams();
    if (topics.length > 0) {
      queryParams.set('topics', topics.join(','));
    }

    const pollUrl = `${this.url}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
    const response = await fetch(pollUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...this.headers
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP Polling failed with status ${response.status}`);
    }

    const events = await response.json();
    if (Array.isArray(events)) {
      events.forEach((event: any) => {
        if (event && typeof event === 'object' && typeof event.topic === 'string') {
          this.messageCb?.(event.topic, event.data);
        }
      });
    }
  }

  private updateState(state: ConnectionState, error?: Error): void {
    if (this._state === state) return;
    this._state = state;
    if (this.stateCb) {
      this.stateCb(state, error);
    }
  }
}
