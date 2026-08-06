import {
  Component, OnInit, OnDestroy, inject,
  HostListener, NgZone, signal
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Subscription } from 'rxjs';
import { ApiService } from '../services/api.service';
import { ToastService } from '../services/toast.service';
import { WebSocketService } from '../services/websocket.service';
import { ToastContainerComponent } from '../components/toast-container/toast-container.component';

/** Shape of every other player tracked in the room */
interface OtherPlayer {
  username: string;
  x: number;
  y: number;
  avatarUrl: string;
}

/** A single chat message bubble */
interface ChatMsg {
  text: string;
  sent: boolean;       // true = sent by local player
  timestamp: Date;
}

/** A draggable chat window (one per conversation partner) */
interface ChatWindow {
  id: string;          // equals partnerUsername — unique per conversation
  partnerUsername: string;
  messages: ChatMsg[];
  inputText: string;
  position: { x: number; y: number };
  zIndex: number;
}

/** Movement payload sent/received over WebSocket */
interface MoveMessage {
  type: 'move';
  username: string;
  x: number;
  y: number;
}

/** Chat message payload over WebSocket */
interface ChatWsMessage {
  type: 'message';
  sender_name: string;
  receiver_name: string;
  room_code: string;
  message: string;
}

type AnyWsMessage = Partial<MoveMessage> & Partial<ChatWsMessage> & { type?: string };

@Component({
  selector: 'app-room',
  standalone: true,
  imports: [ToastContainerComponent, FormsModule, DatePipe],
  templateUrl: './room.html',
  styleUrl: './room.scss'
})
export class RoomComponent implements OnInit, OnDestroy {
  username = '';
  roomId = '';
  isLeaving = false;
  wsConnected = false;

  /** 'light' | 'dark' — persisted in localStorage, default light */
  theme: 'light' | 'dark' = 'light';

  /** DiceBear avatar URL seeded by username */
  avatarUrl = '';

  /** Local player position as percentage (0–100) of the wrapper */
  avatarX = 50;
  avatarY = 50;

  /** Other players — signal so the template reacts instantly regardless of zone context */
  otherPlayers = signal<OtherPlayer[]>([]);

  /** Usernames of players currently within proximity threshold */
  nearbyPlayers = signal<string[]>([]);

  /** Open chat windows — multiple can be open simultaneously */
  chatWindows = signal<ChatWindow[]>([]);

  /** Movement is blocked while any chat window is open */
  get isInMessageMode(): boolean {
    return this.chatWindows().length > 0;
  }

  // ── Drag state ──────────────────────────────────────────────────────────────
  private draggingWindowId: string | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private topZIndex = 200;

  // ── Movement internals ──────────────────────────────────────────────────────
  private readonly SPEED = 0.25;               // % per animation frame
  private readonly PROXIMITY_THRESHOLD = 12;   // % units (both axes)
  private pressedKeys = new Set<string>();
  private animFrameId: number | null = null;
  private lastBroadcastMs = 0;

  // ── DI ─────────────────────────────────────────────────────────────────────
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private ws = inject(WebSocketService);
  private ngZone = inject(NgZone);

  private subs = new Subscription();

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  ngOnInit(): void {
    this.roomId = this.route.snapshot.paramMap.get('roomId') ?? '';
    this.username = this.route.snapshot.queryParamMap.get('user') ?? '';

    if (!this.username || !this.roomId) {
      this.router.navigate(['/login']);
      return;
    }

    this.avatarUrl = `https://api.dicebear.com/9.x/personas/svg?seed=${encodeURIComponent(this.username)}`;

    // Restore saved theme, fall back to 'light'
    const saved = localStorage.getItem('mv-theme') as 'light' | 'dark' | null;
    this.theme = saved ?? 'light';

    this.initWebSocket();
    this.startGameLoop();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.stopGameLoop();
    this.ws.disconnect();
  }

  // ── Theme ───────────────────────────────────────────────────────────────────
  toggleTheme(): void {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('mv-theme', this.theme);
  }

  // ── Keyboard events ─────────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }

    // Block movement keys while in message mode
    if (!this.isInMessageMode) {
      this.pressedKeys.add(e.code);

      // Press Enter near another player to open chat
      if (e.code === 'Enter') {
        const nearby = this.nearbyPlayers();
        if (nearby.length > 0) {
          this.openChat(nearby[0]);
        }
      }
    }
  }

  @HostListener('document:keyup', ['$event'])
  onKeyUp(e: KeyboardEvent): void {
    this.pressedKeys.delete(e.code);
  }

  // ── Drag handlers ────────────────────────────────────────────────────────────

  startDrag(windowId: string, event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    this.draggingWindowId = windowId;

    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;

    const win = this.chatWindows().find(w => w.id === windowId);
    if (win) {
      this.dragOffsetX = clientX - win.position.x;
      this.dragOffsetY = clientY - win.position.y;
      this.bringToFront(windowId);
    }
  }

  @HostListener('document:mousemove', ['$event'])
  onDragMoveM(event: MouseEvent): void {
    this.handleDragMove(event.clientX, event.clientY);
  }

  @HostListener('document:touchmove', ['$event'])
  onDragMoveT(event: TouchEvent): void {
    if (this.draggingWindowId) event.preventDefault();
    this.handleDragMove(event.touches[0].clientX, event.touches[0].clientY);
  }

  private handleDragMove(clientX: number, clientY: number): void {
    if (!this.draggingWindowId) return;

    const newX = Math.max(0, clientX - this.dragOffsetX);
    const newY = Math.max(0, clientY - this.dragOffsetY);

    this.chatWindows.update(wins =>
      wins.map(w =>
        w.id === this.draggingWindowId
          ? { ...w, position: { x: newX, y: newY } }
          : w
      )
    );
  }

  @HostListener('document:mouseup')
  @HostListener('document:touchend')
  onDragEnd(): void {
    this.draggingWindowId = null;
  }

  // ── Game loop ───────────────────────────────────────────────────────────────

  private startGameLoop(): void {
    // Run outside Angular zone — RAF doesn't trigger CD every frame
    this.ngZone.runOutsideAngular(() => {
      const tick = () => {
        let dx = 0;
        let dy = 0;

        // Movement disabled when any chat window is open
        if (!this.isInMessageMode) {
          if (this.pressedKeys.has('ArrowUp') || this.pressedKeys.has('KeyW')) dy -= this.SPEED;
          if (this.pressedKeys.has('ArrowDown') || this.pressedKeys.has('KeyS')) dy += this.SPEED;
          if (this.pressedKeys.has('ArrowLeft') || this.pressedKeys.has('KeyA')) dx -= this.SPEED;
          if (this.pressedKeys.has('ArrowRight') || this.pressedKeys.has('KeyD')) dx += this.SPEED;
        }

        if (dx !== 0 || dy !== 0) {
          const newX = Math.min(100, Math.max(0, this.avatarX + dx));
          const newY = Math.min(100, Math.max(0, this.avatarY + dy));

          this.ngZone.run(() => {
            this.avatarX = newX;
            this.avatarY = newY;
            this.updateProximity();
          });

          this.broadcastPosition(newX, newY);
        }

        this.animFrameId = requestAnimationFrame(tick);
      };

      this.animFrameId = requestAnimationFrame(tick);
    });
  }

  private stopGameLoop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  /** Throttled to ~20 sends/sec to avoid flooding the server */
  private broadcastPosition(x: number, y: number): void {
    const now = Date.now();
    if (now - this.lastBroadcastMs < 50) return;
    this.lastBroadcastMs = now;
    this.ws.send({
      type: 'move',
      username: this.username,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
    });
  }

  // ── Proximity ───────────────────────────────────────────────────────────────

  private updateProximity(): void {
    const nearby = this.otherPlayers()
      .filter(p => {
        const dx = Math.abs(p.x - this.avatarX);
        const dy = Math.abs(p.y - this.avatarY);
        return dx < this.PROXIMITY_THRESHOLD && dy < this.PROXIMITY_THRESHOLD;
      })
      .map(p => p.username);

    this.nearbyPlayers.set(nearby);
  }

  isNearby(username: string): boolean {
    return this.nearbyPlayers().includes(username);
  }

  // ── Chat windows ─────────────────────────────────────────────────────────────

  openChat(partnerUsername: string): void {
    const existing = this.chatWindows().find(w => w.id === partnerUsername);
    if (existing) {
      this.bringToFront(partnerUsername);
      return;
    }

    // Offset each new window so they don't perfectly overlap
    const offset = this.chatWindows().length * 30;
    const newWindow: ChatWindow = {
      id: partnerUsername,
      partnerUsername,
      messages: [],
      inputText: '',
      position: { x: 80 + offset, y: 100 + offset },
      zIndex: ++this.topZIndex,
    };

    this.chatWindows.update(wins => [...wins, newWindow]);
  }

  closeChat(windowId: string): void {
    this.chatWindows.update(wins => wins.filter(w => w.id !== windowId));
    // Clear pressed keys so the player doesn't drift on chat close
    this.pressedKeys.clear();
  }

  sendMessage(windowId: string): void {
    const win = this.chatWindows().find(w => w.id === windowId);
    if (!win || !win.inputText.trim()) return;

    const text = win.inputText.trim();

    // Append to local window immediately (optimistic)
    this.chatWindows.update(wins =>
      wins.map(w =>
        w.id === windowId
          ? { ...w, inputText: '', messages: [...w.messages, { text, sent: true, timestamp: new Date() }] }
          : w
      )
    );

    // Broadcast via WebSocket
    this.ws.send({
      type: 'message',
      sender_name: this.username,
      receiver_name: windowId,
      room_code: this.roomId,
      message: text,
    });
  }

  updateInput(windowId: string, value: string): void {
    this.chatWindows.update(wins =>
      wins.map(w => w.id === windowId ? { ...w, inputText: value } : w)
    );
  }

  onInputKeydown(event: KeyboardEvent, windowId: string): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage(windowId);
    }
    // Consume the event so it doesn't fire the document keydown handler
    event.stopPropagation();
  }

  bringToFront(windowId: string): void {
    this.chatWindows.update(wins =>
      wins.map(w => w.id === windowId ? { ...w, zIndex: ++this.topZIndex } : w)
    );
  }

  // ── WebSocket ───────────────────────────────────────────────────────────────

  private initWebSocket(): void {
    this.ws.connect(this.roomId, this.username);

    this.subs.add(
      this.ws.connected$.subscribe({
        next: (connected) => {
          this.wsConnected = connected;
          if (connected) {
            this.toast.success(`Connected to room "${this.roomId}"`);
          }
        },
        error: () => {
          this.toast.error('Server rejected the connection. Please re-login.');
          setTimeout(() => this.router.navigate(['/login'], { queryParams: { user: this.username } }), 1500);
        }
      })
    );

    this.subs.add(
      this.ws.message$.subscribe((raw) => {
        const msg = raw as AnyWsMessage;

        // Handle player movement
        if (msg.type === 'move' && msg.username && msg.username !== this.username) {
          this.updateOtherPlayer(msg.username, msg.x ?? 50, msg.y ?? 50);
        }

        // Server requests our current position — reply immediately with a move message
        if (msg.type === 'position') {
          this.ws.send({
            type: 'move',
            username: this.username,
            x: Math.round(this.avatarX * 100) / 100,
            y: Math.round(this.avatarY * 100) / 100,
          });
        }

        // Handle incoming chat message
        if (msg.type === 'message' && msg.sender_name && msg.sender_name !== this.username) {
          this.receiveMessage(msg.sender_name, msg.message ?? '');
        }
      })
    );
  }

  private receiveMessage(senderUsername: string, text: string): void {
    // Auto-open a window for this sender if not already open
    if (!this.chatWindows().find(w => w.id === senderUsername)) {
      this.openChat(senderUsername);
    }

    this.chatWindows.update(wins =>
      wins.map(w =>
        w.id === senderUsername
          ? { ...w, messages: [...w.messages, { text, sent: false, timestamp: new Date() }] }
          : w
      )
    );
  }

  private updateOtherPlayer(username: string, x: number, y: number): void {
    this.otherPlayers.update(players => {
      const idx = players.findIndex(p => p.username === username);

      if (idx === -1) {
        return [
          ...players,
          {
            username,
            x,
            y,
            avatarUrl: `https://api.dicebear.com/9.x/personas/svg?seed=${encodeURIComponent(username)}`
          }
        ];
      }

      const updated = [...players];
      updated[idx] = { ...updated[idx], x, y };
      return updated;
    });

    // Re-check proximity whenever another player moves
    this.updateProximity();
  }

  // ── Leave room ──────────────────────────────────────────────────────────────

  async leaveRoom(): Promise<void> {
    if (this.isLeaving) return;
    this.isLeaving = true;
    this.stopGameLoop();

    await this.ws.disconnect();

    this.api.leaveRoom({ username: this.username, room_code: this.roomId }).subscribe({
      next: (res) => {
        this.isLeaving = false;

        if (res.status === 200) {
          this.toast.success(`You've left the room. See you next time, ${this.username}!`);
          setTimeout(() => this.router.navigate(['/login'], { queryParams: { user: this.username } }), 1000);
          return;
        }

        this.toast.warning(res.message ?? 'Could not leave room gracefully.');
        setTimeout(() => this.router.navigate(['/login'], { queryParams: { user: this.username } }), 1200);
      },
      error: (err: HttpErrorResponse) => {
        this.isLeaving = false;
        if (err.status === 0) {
          this.toast.error('Cannot connect to server. Redirecting to login…');
        } else {
          this.toast.error(`Error ${err.status}: ${err.message}`);
        }
        setTimeout(() => this.router.navigate(['/login'], { queryParams: { user: this.username } }), 1500);
      }
    });
  }
}
