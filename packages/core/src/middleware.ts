import { Middleware, MiddlewareContext } from './types.js';
import { Logger } from './logger.js';

/**
 * Composes a list of middleware functions into a single pipeline runner.
 */
export function compose(middlewares: Middleware[]) {
  return function (context: MiddlewareContext, next: () => Promise<void>): Promise<void> {
    let index = -1;
    
    function dispatch(i: number): Promise<void> {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      index = i;
      let fn = middlewares[i];
      if (i === middlewares.length) {
        return next();
      }
      if (!fn) return Promise.resolve();
      try {
        return Promise.resolve(fn(context, () => dispatch(i + 1)));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    
    return dispatch(0);
  };
}

/**
 * Built-in middleware to log all inbound and outbound messages.
 */
export function loggerMiddleware(debugEnabled = false): Middleware {
  const logger = new Logger(debugEnabled);
  return async (ctx, next) => {
    logger.info('Middleware', `${ctx.direction.toUpperCase()} topic=${ctx.topic}`, ctx.payload);
    await next();
  };
}

/**
 * Built-in middleware to track throughput statistics.
 */
export function metricsMiddleware(onIncrement: (direction: 'inbound' | 'outbound') => void): Middleware {
  return async (ctx, next) => {
    onIncrement(ctx.direction);
    await next();
  };
}
