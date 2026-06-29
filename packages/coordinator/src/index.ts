import { EventEmitter } from '@connexis/core';

export interface CoordinatorEvents {
  leaderChange: { leaderId: string; isLeader: boolean };
  message: { senderId: string; payload: any };
  tabJoin: { tabId: string };
  tabLeave: { tabId: string };
}

// Serialized SharedWorker code string
const SHARED_WORKER_CODE = `
const ports = [];
let leaderPort = null;
let leaderId = null;

self.onconnect = function(e) {
  const port = e.ports[0];
  ports.push(port);

  port.onmessage = function(event) {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'register') {
      port.tabId = msg.tabId;
      port.lastSeen = Date.now();
      if (!leaderPort) {
        electLeader(port);
      } else {
        port.postMessage({ type: 'leader_announce', leaderId: leaderId });
      }
    } else if (msg.type === 'unload') {
      removePort(port);
    } else if (msg.type === 'heartbeat_reply') {
      port.lastSeen = Date.now();
    } else if (msg.type === 'broadcast') {
      ports.forEach(p => {
        if (p !== port) p.postMessage(msg);
      });
    } else if (msg.type === 'to_leader') {
      if (leaderPort) {
        leaderPort.postMessage({ type: 'from_tab', tabId: port.tabId, payload: msg.payload });
      }
    } else if (msg.type === 'from_leader') {
      const target = ports.find(p => p.tabId === msg.targetTabId);
      if (target) {
        target.postMessage({ type: 'to_tab', payload: msg.payload });
      }
    }
  };
};

function electLeader(port) {
  leaderPort = port;
  leaderId = port.tabId;
  broadcast({ type: 'leader_announce', leaderId: leaderId });
}

function broadcast(msg) {
  ports.forEach(p => p.postMessage(msg));
}

function removePort(port) {
  const idx = ports.indexOf(port);
  if (idx !== -1) {
    ports.splice(idx, 1);
    if (leaderPort === port) {
      leaderPort = null;
      leaderId = null;
      if (ports.length > 0) {
        electLeader(ports[0]);
      } else {
        broadcast({ type: 'leader_announce', leaderId: null });
      }
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (let i = ports.length - 1; i >= 0; i--) {
    const port = ports[i];
    if (port.lastSeen && now - port.lastSeen > 6000) {
      removePort(port);
    } else {
      port.postMessage({ type: 'heartbeat_ping' });
    }
  }
}, 2000);
`;

export class Coordinator extends EventEmitter<CoordinatorEvents> {
  public readonly tabId: string;
  private openedAt: number;
  private _isLeader = false;
  private leaderId: string | null = null;
  private isDestroyed = false;

  // SharedWorker reference
  private sharedWorker: SharedWorker | null = null;

  // BroadcastChannel references
  private channel: BroadcastChannel | null = null;
  private leaderHeartbeatTimer: any = null;
  private followerCheckTimer: any = null;
  private lastLeaderHeartbeat = Date.now();
  private electionCandidates = new Map<string, number>();
  private isElecting = false;

  constructor(private namespace = 'connexis') {
    super();
    this.tabId = Math.random().toString(36).substring(2, 11);
    this.openedAt = Date.now();
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  get currentLeaderId(): string | null {
    return this.leaderId;
  }

  start(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('beforeunload', this.handleUnload);

    // Default to BroadcastChannel for zero-config multi-tab communication.
    // Falls back to single tab mode if BroadcastChannel is not supported.
    this.initBroadcastChannel();
  }

  private trySharedWorker(): void {
    if (typeof SharedWorker === 'undefined') {
      throw new Error('SharedWorker not supported');
    }

    const blob = new Blob([SHARED_WORKER_CODE], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);

    this.sharedWorker = new SharedWorker(workerUrl, this.namespace);
    this.sharedWorker.port.onmessage = (event) => {
      this.handleSharedWorkerMessage(event.data);
    };

    this.sharedWorker.port.start();

    // Register self
    this.sharedWorker.port.postMessage({
      type: 'register',
      tabId: this.tabId
    });
  }

  private handleSharedWorkerMessage(msg: any): void {
    if (this.isDestroyed || !msg) return;

    switch (msg.type) {
      case 'leader_announce':
        this.updateLeader(msg.leaderId);
        break;
      case 'heartbeat_ping':
        this.sharedWorker?.port.postMessage({ type: 'heartbeat_reply' });
        break;
      case 'broadcast':
        this.emit('message', { senderId: msg.senderId, payload: msg.payload });
        break;
      case 'from_tab':
        this.emit('message', { senderId: msg.tabId, payload: msg.payload });
        break;
      case 'to_tab':
        this.emit('message', { senderId: this.leaderId || 'leader', payload: msg.payload });
        break;
    }
  }

  private initBroadcastChannel(): void {
    if (typeof BroadcastChannel === 'undefined') {
      // Fallback to single tab mode without coordinator
      this.updateLeader(this.tabId);
      return;
    }

    this.channel = new BroadcastChannel(`${this.namespace}_coordination`);
    this.channel.onmessage = (event) => {
      this.handleBroadcastMessage(event.data);
    };

    // Query for existing leader
    this.channel.postMessage({
      type: 'query_leader',
      senderId: this.tabId
    });

    // Start follower check loop
    this.followerCheckTimer = setInterval(() => {
      if (this._isLeader) return;

      const now = Date.now();
      if (now - this.lastLeaderHeartbeat > 3500) {
        // Leader dead, trigger election
        this.startElection();
      }
    }, 1000);

    // Give some time for existing leader to announce, else elect
    setTimeout(() => {
      if (!this.leaderId && !this.isElecting) {
        this.startElection();
      }
    }, 400);
  }

  private handleBroadcastMessage(msg: any): void {
    if (this.isDestroyed || !msg) return;

    switch (msg.type) {
      case 'query_leader':
        if (this._isLeader) {
          this.announceLeader();
        }
        break;
      case 'announce_leader':
        this.lastLeaderHeartbeat = Date.now();
        this.updateLeader(msg.leaderId);
        break;
      case 'election_start':
        if (this.isElecting) {
          this.electionCandidates.set(msg.senderId, msg.openedAt);
        } else {
          // Join the election
          this.startElection();
          this.electionCandidates.set(msg.senderId, msg.openedAt);
        }
        break;
      case 'leader_exit':
        this.leaderId = null;
        this.startElection();
        break;
      case 'broadcast':
        this.emit('message', { senderId: msg.senderId, payload: msg.payload });
        break;
      case 'to_leader':
        if (this._isLeader) {
          this.emit('message', { senderId: msg.senderId, payload: msg.payload });
        }
        break;
      case 'to_tab':
        if (msg.targetTabId === this.tabId) {
          this.emit('message', { senderId: this.leaderId || 'leader', payload: msg.payload });
        }
        break;
    }
  }

  private startElection(): void {
    if (this.isElecting || this.isDestroyed) return;
    this.isElecting = true;
    this.electionCandidates.clear();

    // Broadcast self candidacy
    this.channel?.postMessage({
      type: 'election_start',
      senderId: this.tabId,
      openedAt: this.openedAt
    });

    // Wait for other candidates
    setTimeout(() => {
      this.evaluateElection();
    }, 300);
  }

  private evaluateElection(): void {
    this.isElecting = false;
    let won = true;

    for (const [candId, candOpened] of this.electionCandidates.entries()) {
      if (candOpened < this.openedAt) {
        won = false;
        break;
      } else if (candOpened === this.openedAt) {
        // Tie breaker
        if (candId < this.tabId) {
          won = false;
          break;
        }
      }
    }

    if (won) {
      this.updateLeader(this.tabId);
      this.announceLeader();
      this.startLeaderHeartbeat();
    }
  }

  private announceLeader(): void {
    this.channel?.postMessage({
      type: 'announce_leader',
      leaderId: this.tabId
    });
  }

  private startLeaderHeartbeat(): void {
    if (this.leaderHeartbeatTimer) clearInterval(this.leaderHeartbeatTimer);

    this.leaderHeartbeatTimer = setInterval(() => {
      if (this._isLeader) {
        this.announceLeader();
      }
    }, 1000);
  }

  private updateLeader(newLeaderId: string | null): void {
    const isNowLeader = newLeaderId === this.tabId;
    const changed = this.leaderId !== newLeaderId || this._isLeader !== isNowLeader;

    this.leaderId = newLeaderId;
    this._isLeader = isNowLeader;

    if (changed) {
      if (!isNowLeader && this.leaderHeartbeatTimer) {
        clearInterval(this.leaderHeartbeatTimer);
        this.leaderHeartbeatTimer = null;
      }
      this.emit('leaderChange', { leaderId: newLeaderId || '', isLeader: isNowLeader });
    }
  }

  /**
   * Broadcasts a message to all tabs.
   */
  broadcast(payload: any): void {
    if (this.sharedWorker) {
      this.sharedWorker.port.postMessage({
        type: 'broadcast',
        senderId: this.tabId,
        payload
      });
    } else {
      this.channel?.postMessage({
        type: 'broadcast',
        senderId: this.tabId,
        payload
      });
    }
  }

  /**
   * Sends a message to the leader tab.
   */
  sendToLeader(payload: any): void {
    if (this._isLeader) {
      this.emit('message', { senderId: this.tabId, payload });
      return;
    }

    if (this.sharedWorker) {
      this.sharedWorker.port.postMessage({
        type: 'to_leader',
        payload
      });
    } else {
      this.channel?.postMessage({
        type: 'to_leader',
        senderId: this.tabId,
        payload
      });
    }
  }

  /**
   * Sends a message from the leader tab to a specific target tab.
   */
  sendToTab(targetTabId: string, payload: any): void {
    if (!this._isLeader) return;

    if (targetTabId === this.tabId) {
      this.emit('message', { senderId: this.tabId, payload });
      return;
    }

    if (this.sharedWorker) {
      this.sharedWorker.port.postMessage({
        type: 'from_leader',
        targetTabId,
        payload
      });
    } else {
      this.channel?.postMessage({
        type: 'to_tab',
        targetTabId,
        payload
      });
    }
  }

  private handleUnload = () => {
    if (this.sharedWorker) {
      this.sharedWorker.port.postMessage({ type: 'unload' });
    } else {
      if (this._isLeader) {
        this.channel?.postMessage({ type: 'leader_exit' });
      }
    }
  };

  destroy(): void {
    this.isDestroyed = true;
    window.removeEventListener('beforeunload', this.handleUnload);

    if (this._isLeader) {
      if (this.sharedWorker) {
        this.sharedWorker.port.postMessage({ type: 'unload' });
      } else {
        try {
          this.channel?.postMessage({ type: 'leader_exit' });
        } catch (e) {
          // ignore
        }
      }
    }

    if (this.leaderHeartbeatTimer) clearInterval(this.leaderHeartbeatTimer);
    if (this.followerCheckTimer) clearInterval(this.followerCheckTimer);

    if (this.sharedWorker) {
      this.sharedWorker.port.postMessage({ type: 'unload' });
      this.sharedWorker = null;
    }

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    this.removeAllListeners();
  }
}
