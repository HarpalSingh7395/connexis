/**
 * Type-safe, dependency-free event emitter.
 */
export class EventEmitter<T extends Record<string, any>> {
  private listeners: { [K in keyof T]?: Array<(data: T[K]) => void> } = {};

  on<K extends keyof T>(event: K, cb: (data: T[K]) => void): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]!.push(cb);
    return () => this.off(event, cb);
  }

  off<K extends keyof T>(event: K, cb: (data: T[K]) => void): void {
    const list = this.listeners[event];
    if (!list) return;
    this.listeners[event] = list.filter(item => item !== cb);
  }

  emit<K extends keyof T>(event: K, data: T[K]): void {
    const list = this.listeners[event];
    if (!list) return;
    [...list].forEach(cb => {
      try {
        cb(data);
      } catch (err) {
        console.error(`Error in event listener for ${String(event)}:`, err);
      }
    });
  }

  removeAllListeners(): void {
    this.listeners = {};
  }
}
