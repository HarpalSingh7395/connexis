import { Transport, ConnectionState, TransportCapabilities, Serializer } from '@connexis/core';

export interface WebSocketTransportOptions {
  protocols?: string | string[];
  serializer?: Serializer;
}

const defaultSerializer: Serializer = {
  serialize: (data: any) => JSON.stringify(data),
  deserialize: (data: string) => JSON.parse(data)
};

export class WebSocketTransport implements Transport {
  public readonly type = 'websocket';
  private ws: WebSocket | null = null;
  private _state: ConnectionState = 'idle';

  private messageCb: ((topic: string, data: any) => void) | null = null;
  private stateCb: ((state: ConnectionState, error?: Error) => void) | null = null;
  private serializer: Serializer;

  constructor(
    private url: string,
    private options: WebSocketTransportOptions = {}
  ) {
    this.serializer = options.serializer || defaultSerializer;
  }

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
        const protocols = this.options.protocols;
        this.ws = protocols ? new WebSocket(this.url, protocols) : new WebSocket(this.url);
      } catch (err) {
        this.updateState('error', err as Error);
        reject(err);
        return;
      }

      let hasOpened = false;

      this.ws.onopen = () => {
        hasOpened = true;
        this.updateState('connected');
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = (_event) => {
        const error = new Error('WebSocket error event');
        if (!hasOpened) {
          this.updateState('error', error);
          reject(error);
        } else {
          this.updateState('error', error);
        }
      };

      this.ws.onclose = (_event) => {
        this.updateState('closed');
      };
    });
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.updateState('closed');
  }

  async publish(topic: string, data: any): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    const payload = this.serializer.serialize({ topic, data });
    this.ws.send(payload);
  }

  async subscribe(topic: string, filter?: Record<string, any>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return; // will resubscribe once connected
    }
    const payload = this.serializer.serialize({
      action: 'subscribe',
      topic,
      filter
    });
    this.ws.send(payload);
  }

  async unsubscribe(topic: string, filter?: Record<string, any>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = this.serializer.serialize({
      action: 'unsubscribe',
      topic,
      filter
    });
    this.ws.send(payload);
  }

  capabilities(): TransportCapabilities {
    return {
      publish: true,
      subscribe: true,
      latency: 'low'
    };
  }

  onMessage(cb: (topic: string, data: any) => void): void {
    this.messageCb = cb;
  }

  onStateChange(cb: (state: ConnectionState, error?: Error) => void): void {
    this.stateCb = cb;
  }

  clone(): WebSocketTransport {
    return new WebSocketTransport(this.url, this.options);
  }

  private handleMessage(rawData: any): void {
    if (!this.messageCb) return;

    try {
      const parsed = typeof rawData === 'string' ? this.serializer.deserialize(rawData) : rawData;
      if (parsed && typeof parsed === 'object') {
        const { topic, data } = parsed;
        if (typeof topic === 'string') {
          this.messageCb(topic, data !== undefined ? data : parsed);
        }
      }
    } catch (err) {
      // Ignore unparseable frames
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
