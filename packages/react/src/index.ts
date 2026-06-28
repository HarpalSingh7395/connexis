import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { RealtimeClient, ConnectionState, Metrics, SubscribeOptions } from '@connexis/core';

const RealtimeContext = createContext<RealtimeClient | null>(null);

export interface RealtimeProviderProps {
  client: RealtimeClient;
  children: React.ReactNode;
}

/**
 * Context Provider enabling access to the Realtime Client across the React component tree.
 */
export const RealtimeProvider: React.FC<RealtimeProviderProps> = ({ client, children }) => {
  return React.createElement(RealtimeContext.Provider, { value: client }, children);
};

/**
 * Accesses the raw RealtimeClient instance from Context.
 */
export const useRealtime = (): RealtimeClient => {
  const client = useContext(RealtimeContext);
  if (!client) {
    throw new Error('useRealtime must be used within a RealtimeProvider');
  }
  return client;
};

/**
 * Hook to subscribe to connection state and performance metrics.
 */
export const useConnection = (): { state: ConnectionState; metrics: Metrics } => {
  const client = useRealtime();
  const [state, setState] = useState<ConnectionState>(client.state);
  const [metrics, setMetrics] = useState<Metrics>(client.metrics);

  useEffect(() => {
    // Initial sync
    setState(client.state);
    setMetrics(client.metrics);

    const unsubState = client.on('stateChange', ({ state }) => {
      setState(state);
    });

    const unsubMetrics = client.on('metricsChange', (metrics) => {
      setMetrics(metrics);
    });

    return () => {
      unsubState();
      unsubMetrics();
    };
  }, [client]);

  return { state, metrics };
};

/**
 * Hook to subscribe to a realtime topic with automatic subscription lifecycle management.
 */
export const useSubscription = <T = any>(
  topic: string,
  optionsOrHandler: SubscribeOptions | ((data: T) => void),
  handlerOrUndefined?: (data: T) => void
): void => {
  const client = useRealtime();
  
  const options = typeof optionsOrHandler === 'object' ? optionsOrHandler : {};
  const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : handlerOrUndefined;

  if (!handler) {
    throw new Error('Subscription handler function is required');
  }

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const filterString = options.filter ? JSON.stringify(options.filter) : '';

  useEffect(() => {
    let active = true;
    let unsubPromise: Promise<() => Promise<void>> | null = null;
    let unsubscribe: (() => Promise<void>) | null = null;

    const subOpts = options.filter ? { filter: options.filter } : {};

    unsubPromise = client.subscribe(topic, subOpts, (data) => {
      if (active) {
        handlerRef.current(data);
      }
    });

    unsubPromise.then((unsub) => {
      if (!active) {
        unsub();
      } else {
        unsubscribe = unsub;
      }
    });

    return () => {
      active = false;
      if (unsubscribe) {
        unsubscribe();
      } else if (unsubPromise) {
        unsubPromise.then((unsub) => unsub());
      }
    };
  }, [client, topic, filterString]);
};

/**
 * Semantic alias for `useSubscription` conforming to the useChannel requirement.
 */
export const useChannel = useSubscription;

/**
 * Hook returning a callback to publish events to a topic.
 */
export const usePublish = (): <K extends string, V = any>(topic: K, payload: V) => Promise<void> => {
  const client = useRealtime();
  
  return useCallback(
    async <K extends string, V = any>(topic: K, payload: V) => {
      await client.publish(topic, payload);
    },
    [client]
  );
};
