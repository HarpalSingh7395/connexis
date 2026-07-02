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

    // When the Promise resolves: if we are still active, store the unsubscribe
    // handle; otherwise call it immediately (covers the case where cleanup ran
    // before the Promise resolved, e.g. React Strict Mode double-invocation).
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
        // Promise already resolved — call the stored handle directly and clear
        // the ref so any subsequent accidental call is a no-op.
        const fn = unsubscribe;
        unsubscribe = null;
        fn();
      }
      // If the Promise has NOT resolved yet (unsubscribe is null), the .then()
      // handler above will fire with active === false and call unsub() exactly
      // once.  We must NOT schedule a second .then() here, because that would
      // result in unsub() being invoked twice:
      //   1. from the original .then() above  (active === false → unsub())
      //   2. from the extra .then() below     (always → unsub())
      // Double-calling unsubDirect decrements the connection ref-count twice
      // per subscription (22 extra decrements for 11 hooks in Strict Mode),
      // driving it to 0 and silently destroying the live connection.
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
export const usePublish = (): (<K extends string, V = any>(
  topic: K,
  payload: V
) => Promise<void>) => {
  const client = useRealtime();

  return useCallback(
    async <K extends string, V = any>(topic: K, payload: V) => {
      await client.publish(topic, payload);
    },
    [client]
  );
};
