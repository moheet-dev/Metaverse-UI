import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface WsMessage {
  [key: string]: unknown;
}

@Injectable({
  providedIn: 'root'
})
export class WebSocketService {
  private socket: WebSocket | null = null;

  /** Emits every JSON message received from the server */
  readonly message$ = new Subject<WsMessage>();

  /** Emits true when connected, false when closed/errored */
  readonly connected$ = new Subject<boolean>();

  connect(roomId: string, username: string): void {
    // Avoid duplicate connections
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    const url = `ws://localhost:8000/ws/${roomId}/${username}`;
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.connected$.next(true);
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsMessage;
        this.message$.next(data);
      } catch {
        // Non-JSON frame — ignore
      }
    };

    this.socket.onerror = () => {
      this.connected$.next(false);
    };

    this.socket.onclose = (event) => {
      this.connected$.next(false);
      this.socket = null;

      // code 1008 means the server rejected the connection (room/user not found)
      if (event.code === 1008) {
        this.connected$.error(new Error('Connection rejected by server (1008).'));
      }
    };
  }

  /**
   * Send a JSON payload to all room members via the server broadcast.
   */
  send(payload: WsMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  /**
   * Close the socket cleanly (code 1000 = normal closure).
   * Returns a promise that resolves once the socket is fully closed.
   */
  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      const onClose = () => {
        this.socket = null;
        resolve();
      };

      this.socket.addEventListener('close', onClose, { once: true });
      this.socket.close(1000, 'User left the room');
    });
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
