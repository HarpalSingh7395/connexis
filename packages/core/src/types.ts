/**
 * Valid connection states for a transport or client connection.
 */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'closed'
  | 'error';

/**
 * Capabilities supported by a specific transport.
 */
export interface TransportCapabilities {
  publish: boolean;
  subscribe: boolean;
  latency: 'low' | 'high';
}

/**
 * Transport interface that must be implemented by SSE, WebSocket, Polling, etc.
 */
export interface Transport {
  /** The type of transport (e.g., 'sse', 'websocket', 'polling') */
  readonly type: string;
  
  /** Current state of the transport */
  readonly state: ConnectionState;

  /** Connects to the remote server */
  connect(): Promise<void>;

  /** Disconnects from the remote server */
  disconnect(): Promise<void>;

  /** Publishes a message to a topic */
  publish(topic: string, data: any): Promise<void>;

  /** Subscribes to a topic with optional filters */
  subscribe(topic: string, filter?: Record<string, any>): Promise<void>;

  /** Unsubscribes from a topic */
  unsubscribe(topic: string, filter?: Record<string, any>): Promise<void>;

  /** Query transport capabilities */
  capabilities(): TransportCapabilities;

  /** Registers a callback for incoming messages */
  onMessage(cb: (topic: string, data: any) => void): void;

  /** Registers a callback for state changes */
  onStateChange(cb: (state: ConnectionState, error?: Error) => void): void;

  /** Creates a new instance of the transport with the same configuration */
  clone(): Transport;
}

/**
 * Formats or parses messages on a connection.
 */
export interface Serializer {
  serialize(data: any): string;
  deserialize(data: string): any;
}

/**
 * Defines a subscription request from the application.
 */
export interface Subscription {
  id: string;
  topic: string;
  filter?: Record<string, any>;
  metadata?: Record<string, any>;
  serializer?: Serializer;
}

/**
 * Determines how connections are grouped or shared across tabs and clients.
 */
export type ConnectionPolicy =
  | 'shared'
  | 'isolated'
  | 'hybrid'
  | ((subscription: Subscription) => string);

/**
 * Connection pool configuration and control options.
 */
export interface ReconnectOptions {
  /** Maximum reconnection attempts. Default is Infinity */
  maxAttempts?: number;
  /** Delay in ms or exponential backoff resolver function */
  delay?: number | ((attempt: number) => number);
  /** Timeout in ms before a connection attempt fails */
  timeout?: number;
}

/**
 * Options for sending and monitoring heartbeat messages.
 */
export interface HeartbeatOptions {
  enabled?: boolean;
  interval?: number;
  timeout?: number;
  message?: any;
}

/**
 * Interface representing browser tab coordination handles.
 */
export interface ICoordinator {
  readonly tabId: string;
  readonly isLeader: boolean;
  readonly currentLeaderId: string | null;
  start(): void;
  broadcast(payload: any): void;
  sendToLeader(payload: any): void;
  sendToTab(targetTabId: string, payload: any): void;
  on(event: string, cb: (data: any) => void): () => void;
  destroy(): void;
}

/**
 * Configuration options for the Connexis Client.
 */
export interface RealtimeClientConfig {
  /** Transport instance or factory function */
  transport: Transport;
  /** Strategy to govern transport instance reuse. Default is 'isolated' */
  connectionPolicy?: ConnectionPolicy;
  /** Configuration for reconnection behavior */
  reconnectOptions?: ReconnectOptions;
  /** Configuration for ping/pong heartbeats */
  heartbeatOptions?: HeartbeatOptions;
  /** Browser tab coordinator for shared or hybrid policies */
  coordinator?: ICoordinator;
  /** Whether to log diagnostic information to console. Default is false */
  debug?: boolean;
}

/**
 * Pipeline context passed to middlewares.
 */
export interface MiddlewareContext {
  direction: 'inbound' | 'outbound';
  topic: string;
  payload: any;
  metadata?: Record<string, any>;
}

/**
 * Middleware function interface.
 */
export type Middleware = (
  context: MiddlewareContext,
  next: () => Promise<void>
) => Promise<void>;

/**
 * Metrics tracked for performance monitoring.
 */
export interface Metrics {
  reconnectCount: number;
  latency: number;
  uptime: number;
  transportType: string;
  connectionCount: number;
  activeSubscriptions: number;
  leaderChanges: number;
  throughput: {
    inbound: number;
    outbound: number;
  };
}
