import { Transport, ConnectionState, TransportCapabilities } from '@connexis/core';

export class MockTransport implements Transport {
  public readonly type = 'mock';
  private _state: ConnectionState = 'idle';
  private messageCallback: ((topic: string, data: any) => void) | null = null;
  private stateCallback: ((state: ConnectionState, error?: Error) => void) | null = null;

  public published: Array<{ topic: string; data: any }> = [];
  public subscribed: Array<{ topic: string; filter?: Record<string, any> }> = [];
  public unsubscribed: Array<{ topic: string; filter?: Record<string, any> }> = [];

  private failNextConnect = false;
  private failError: Error = new Error('Mock connection failure');
  private connectDelay = 0;

  constructor(
    private caps: TransportCapabilities = { publish: true, subscribe: true, latency: 'low' }
  ) {}

  get state(): ConnectionState {
    return this._state;
  }

  setFailNextConnect(fail: boolean, error?: Error): void {
    this.failNextConnect = fail;
    if (error) this.failError = error;
  }

  setConnectDelay(delayMs: number): void {
    this.connectDelay = delayMs;
  }

  async connect(): Promise<void> {
    if (this._state === 'connected') return;
    this.updateState('connecting');

    if (this.connectDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.connectDelay));
    }

    if (this.failNextConnect) {
      this.failNextConnect = false; // Reset
      this.updateState('error', this.failError);
      throw this.failError;
    }

    this.updateState('connected');
  }

  async disconnect(): Promise<void> {
    this.updateState('closed');
  }

  async publish(topic: string, data: any): Promise<void> {
    if (this._state !== 'connected') {
      throw new Error('Transport not connected');
    }
    this.published.push({ topic, data });
  }

  async subscribe(topic: string, filter?: Record<string, any>): Promise<void> {
    this.subscribed.push({ topic, filter });
  }

  async unsubscribe(topic: string, filter?: Record<string, any>): Promise<void> {
    this.unsubscribed.push({ topic, filter });
  }

  capabilities(): TransportCapabilities {
    return this.caps;
  }

  onMessage(cb: (topic: string, data: any) => void): void {
    this.messageCallback = cb;
  }

  onStateChange(cb: (state: ConnectionState, error?: Error) => void): void {
    this.stateCallback = cb;
  }

  clone(): MockTransport {
    const cloned = new MockTransport(this.caps);
    cloned.failNextConnect = this.failNextConnect;
    cloned.failError = this.failError;
    cloned.connectDelay = this.connectDelay;
    return cloned;
  }

  // Simulator helper methods
  simulateMessage(topic: string, data: any): void {
    if (this.messageCallback) {
      this.messageCallback(topic, data);
    }
  }

  simulateStateChange(state: ConnectionState, error?: Error): void {
    this.updateState(state, error);
  }

  private updateState(state: ConnectionState, error?: Error): void {
    this._state = state;
    if (this.stateCallback) {
      this.stateCallback(state, error);
    }
  }
}
