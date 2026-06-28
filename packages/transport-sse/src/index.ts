import { Transport, ConnectionState, TransportCapabilities } from '@connexis/core';

export interface SSETransportOptions {
  publishUrl?: string;
  publish?: (topic: string, data: any) => Promise<void>;
  withCredentials?: boolean;
}

export class SSETransport implements Transport {
  public readonly type = 'sse';
  private eventSource: EventSource | null = null;
  private _state: ConnectionState = 'idle';

  private messageCb: ((topic: string, data: any) => void) | null = null;
  private stateCb: ((state: ConnectionState, error?: Error) => void) | null = null;
  private activeListeners = new Map<string, (e: MessageEvent) => void>();

  constructor(
    private url: string,
    private options: SSETransportOptions = {}
  ) {}

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') {
      return;
    }

    this.updateState('connecting');

    return new Promise<void>((resolve, reject) => {
      try {
        this.eventSource = new EventSource(this.url, {
          withCredentials: this.options.withCredentials
        });
      } catch (err) {
        this.updateState('error', err as Error);
        reject(err);
        return;
      }

      let hasOpened = false;

      this.eventSource.onopen = () => {
        hasOpened = true;
        this.updateState('connected');
        resolve();
      };

      this.eventSource.onerror = (_event) => {
        const error = new Error('SSE EventSource connection error');
        if (!hasOpened) {
          this.updateState('error', error);
          this.disconnect();
          reject(error);
        } else {
          // If already connected, transition to error so Connection triggers reconnect
          this.updateState('error', error);
          this.disconnect();
        }
      };

      // Listen to generic messages
      this.eventSource.onmessage = (event) => {
        this.handleGenericMessage(event.data);
      };

      // Re-register any active topic listeners
      for (const [topic, listener] of this.activeListeners.entries()) {
        this.eventSource.addEventListener(topic, listener as any);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.eventSource) {
      // Remove all event listeners to avoid leaks
      for (const [topic, listener] of this.activeListeners.entries()) {
        this.eventSource.removeEventListener(topic, listener as any);
      }
      this.eventSource.close();
      this.eventSource = null;
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
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ topic, data })
      });
      if (!response.ok) {
        throw new Error(`SSE publish HTTP request failed with status ${response.status}`);
      }
      return;
    }

    throw new Error(
      'Publishing is not supported by SSE without a configured publishUrl or publish function'
    );
  }

  async subscribe(topic: string, _filter?: Record<string, any>): Promise<void> {
    if (this.activeListeners.has(topic)) return;

    const listener = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data);
        this.messageCb?.(topic, parsed);
      } catch (err) {
        this.messageCb?.(topic, event.data);
      }
    };

    this.activeListeners.set(topic, listener);

    if (this.eventSource && this.eventSource.readyState === EventSource.OPEN) {
      this.eventSource.addEventListener(topic, listener as any);
    }
  }

  async unsubscribe(topic: string, _filter?: Record<string, any>): Promise<void> {
    const listener = this.activeListeners.get(topic);
    if (!listener) return;

    if (this.eventSource) {
      this.eventSource.removeEventListener(topic, listener as any);
    }
    this.activeListeners.delete(topic);
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

  clone(): SSETransport {
    return new SSETransport(this.url, this.options);
  }

  private handleGenericMessage(rawData: string): void {
    if (!this.messageCb) return;

    try {
      const parsed = JSON.parse(rawData);
      if (parsed && typeof parsed === 'object') {
        const { topic, data } = parsed;
        if (typeof topic === 'string') {
          this.messageCb(topic, data !== undefined ? data : parsed);
          return;
        }
      }
      this.messageCb('message', parsed);
    } catch (err) {
      this.messageCb('message', rawData);
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
