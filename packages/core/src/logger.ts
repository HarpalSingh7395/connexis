export class Logger {
  constructor(private enabled: boolean = false) {}

  info(module: string, message: string, ...args: any[]) {
    if (this.enabled) {
      console.log(
        `%c[Connexis:${module}] %c${message}`,
        'color: #00bcd4; font-weight: bold;',
        'color: inherit;',
        ...args
      );
    }
  }

  warn(module: string, message: string, ...args: any[]) {
    if (this.enabled) {
      console.warn(`[Connexis:${module}] ${message}`, ...args);
    }
  }

  error(module: string, message: string, ...args: any[]) {
    console.error(`[Connexis:${module}] ${message}`, ...args);
  }
}
