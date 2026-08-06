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
import { VideoCallService } from '../services/video-call.service';
import { VideoStreamDirective } from '../directives/video-stream.directive';
import { ToastContainerComponent } from '../components/toast-container/toast-container.component';

// ── Interfaces ───────────────────────────────────────────────────────────────

interface OtherPlayer {
  username: string;
  x: number;
  y: number;
  avatarUrl: string;
}

interface ChatMsg {
  text: string;
  sent: boolean;
  timestamp: Date;
}

interface ChatWindow {
  id: string;
  partnerUsername: string;
  messages: ChatMsg[];
  inputText: string;
  position: { x: number; y: number };
  zIndex: number;
}

interface MoveMessage {
  type: 'move';
  username: string;
  x: number;
  y: number;
}

interface ChatWsMessage {
  type: 'message';
  sender_name: string;
  receiver_name: string;
  room_code: string;
  message: string;
}

interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate' | 'call-reject';
  sender_name: string;
  receive_name: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

type AnyWsMessage =
  Partial<MoveMessage> &
  Partial<ChatWsMessage> &
  Partial<SignalingMessage> &
  { type?: string };

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-room',
  standalone: true,
  imports: [ToastContainerComponent, FormsModule, DatePipe, VideoStreamDirective],
  templateUrl: './room.html',
  styleUrl: './room.scss'
})
export class RoomComponent implements OnInit, OnDestroy {
  username = '';
  roomId = '';
  isLeaving = false;
  wsConnected = false;

  theme: 'light' | 'dark' = 'light';
  avatarUrl = '';
  avatarX = 50;
  avatarY = 50;

  otherPlayers = signal<OtherPlayer[]>([]);
  nearbyPlayers = signal<string[]>([]);
  chatWindows   = signal<ChatWindow[]>([]);

  /** Expose video sessions to template */
  get videoSessions() { return this.videoCallService.sessions; }

  /** Movement blocked when typing in chat (not during video calls) */
  get isInMessageMode(): boolean { return this.chatWindows().length > 0; }

  // ── Chat drag state ─────────────────────────────────────────────────────────
  private draggingWindowId: string | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private topZIndex = 200;

  // ── Video drag state (separate tracker) ─────────────────────────────────────
  private draggingVideoId: string | null = null;
  private videoDragOffsetX = 0;
  private videoDragOffsetY = 0;

  // ── Movement ────────────────────────────────────────────────────────────────
  private readonly SPEED = 0.25;
  private readonly PROXIMITY_THRESHOLD = 12;
  private pressedKeys = new Set<string>();
  private animFrameId: number | null = null;
  private lastBroadcastMs = 0;

  // ── DI ──────────────────────────────────────────────────────────────────────
  private route           = inject(ActivatedRoute);
  private router          = inject(Router);
  private api             = inject(ApiService);
  private toast           = inject(ToastService);
  private ws              = inject(WebSocketService);
  private ngZone          = inject(NgZone);
  readonly videoCallService = inject(VideoCallService);

  private subs = new Subscription();

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.roomId  = this.route.snapshot.paramMap.get('roomId') ?? '';
    this.username = this.route.snapshot.queryParamMap.get('user') ?? '';

    if (!this.username || !this.roomId) {
      this.router.navigate(['/login']);
      return;
    }

    this.avatarUrl = `https://api.dicebear.com/9.x/personas/svg?seed=${encodeURIComponent(this.username)}`;
    const saved = localStorage.getItem('mv-theme') as 'light' | 'dark' | null;
    this.theme = saved ?? 'light';

    this.initWebSocket();
    this.startGameLoop();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.stopGameLoop();
    this.videoCallService.cleanup();
    this.ws.disconnect();
  }

  // ── Theme ────────────────────────────────────────────────────────────────────

  toggleTheme(): void {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('mv-theme', this.theme);
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();

    if (!this.isInMessageMode) {
      this.pressedKeys.add(e.code);
      if (e.code === 'Enter') {
        const nearby = this.nearbyPlayers();
        if (nearby.length > 0) this.openChat(nearby[0]);
      }
    }
  }

  @HostListener('document:keyup', ['$event'])
  onKeyUp(e: KeyboardEvent): void { this.pressedKeys.delete(e.code); }

  // ── Chat drag ────────────────────────────────────────────────────────────────

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

  // ── Video drag ────────────────────────────────────────────────────────────────

  startVideoDrag(partnerId: string, event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    this.draggingVideoId = partnerId;

    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;

    const session = this.videoCallService.getSession(partnerId);
    if (session) {
      this.videoDragOffsetX = clientX - session.position.x;
      this.videoDragOffsetY = clientY - session.position.y;
      this.videoCallService.bringToFront(partnerId);
    }
  }

  // ── Combined mousemove / touchmove / mouseup handlers ────────────────────────

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    this.handleChatDragMove(event.clientX, event.clientY);
    this.handleVideoDragMove(event.clientX, event.clientY);
  }

  @HostListener('document:touchmove', ['$event'])
  onTouchMove(event: TouchEvent): void {
    if (this.draggingWindowId || this.draggingVideoId) event.preventDefault();
    const t = event.touches[0];
    this.handleChatDragMove(t.clientX, t.clientY);
    this.handleVideoDragMove(t.clientX, t.clientY);
  }

  @HostListener('document:mouseup')
  @HostListener('document:touchend')
  onPointerUp(): void {
    this.draggingWindowId = null;
    this.draggingVideoId  = null;
  }

  private handleChatDragMove(clientX: number, clientY: number): void {
    if (!this.draggingWindowId) return;
    const newX = Math.max(0, clientX - this.dragOffsetX);
    const newY = Math.max(0, clientY - this.dragOffsetY);
    this.chatWindows.update(wins =>
      wins.map(w => w.id === this.draggingWindowId ? { ...w, position: { x: newX, y: newY } } : w)
    );
  }

  private handleVideoDragMove(clientX: number, clientY: number): void {
    if (!this.draggingVideoId) return;
    const newX = Math.max(0, clientX - this.videoDragOffsetX);
    const newY = Math.max(0, clientY - this.videoDragOffsetY);
    this.videoCallService.updatePosition(this.draggingVideoId, newX, newY);
  }

  // ── Game loop ────────────────────────────────────────────────────────────────

  private startGameLoop(): void {
    this.ngZone.runOutsideAngular(() => {
      const tick = () => {
        let dx = 0, dy = 0;

        if (!this.isInMessageMode) {
          if (this.pressedKeys.has('ArrowUp')    || this.pressedKeys.has('KeyW')) dy -= this.SPEED;
          if (this.pressedKeys.has('ArrowDown')  || this.pressedKeys.has('KeyS')) dy += this.SPEED;
          if (this.pressedKeys.has('ArrowLeft')  || this.pressedKeys.has('KeyA')) dx -= this.SPEED;
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

  // ── Proximity ────────────────────────────────────────────────────────────────

  private updateProximity(): void {
    const nearby = this.otherPlayers()
      .filter(p => Math.abs(p.x - this.avatarX) < this.PROXIMITY_THRESHOLD
                && Math.abs(p.y - this.avatarY) < this.PROXIMITY_THRESHOLD)
      .map(p => p.username);

    this.nearbyPlayers.set(nearby);
  }

  isNearby(username: string): boolean {
    return this.nearbyPlayers().includes(username);
  }

  // ── Chat windows ──────────────────────────────────────────────────────────────

  openChat(partnerUsername: string): void {
    if (this.chatWindows().find(w => w.id === partnerUsername)) {
      this.bringToFront(partnerUsername);
      return;
    }

    const offset = this.chatWindows().length * 30;
    this.chatWindows.update(wins => [...wins, {
      id: partnerUsername,
      partnerUsername,
      messages: [],
      inputText: '',
      position: { x: 80 + offset, y: 100 + offset },
      zIndex: ++this.topZIndex,
    }]);
  }

  closeChat(windowId: string): void {
    this.chatWindows.update(wins => wins.filter(w => w.id !== windowId));
    this.pressedKeys.clear();
  }

  sendMessage(windowId: string): void {
    const win = this.chatWindows().find(w => w.id === windowId);
    if (!win || !win.inputText.trim()) return;

    const text = win.inputText.trim();
    this.chatWindows.update(wins =>
      wins.map(w => w.id === windowId
        ? { ...w, inputText: '', messages: [...w.messages, { text, sent: true, timestamp: new Date() }] }
        : w
      )
    );

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
    event.stopPropagation();
  }

  bringToFront(windowId: string): void {
    this.chatWindows.update(wins =>
      wins.map(w => w.id === windowId ? { ...w, zIndex: ++this.topZIndex } : w)
    );
  }

  // ── Video call — public API (template calls these) ───────────────────────────

  async startVideoCall(partnerId: string): Promise<void> {
    try {
      await this.videoCallService.startCall(this.username, partnerId, (msg) => this.ws.send(msg));
    } catch (err: unknown) {
      this.toast.error('Camera/microphone permission denied. Please allow access and try again.');
      console.error('[VideoCall] startCall error:', err);
    }
  }

  async acceptVideoCall(partnerId: string): Promise<void> {
    try {
      await this.videoCallService.acceptCall(this.username, partnerId, (msg) => this.ws.send(msg));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'camera_denied') {
        this.toast.error('Camera/microphone permission denied.');
      } else {
        this.toast.error('Could not start video call.');
      }
    }
  }

  rejectVideoCall(partnerId: string): void {
    this.videoCallService.endCall(partnerId);
    // Notify the caller that we rejected
    this.ws.send({
      type: 'call-reject',
      sender_name: this.username,
      receive_name: partnerId,
    });
  }

  endVideoCall(partnerId: string): void {
    this.videoCallService.endCall(partnerId);
    // Notify partner that call ended
    this.ws.send({
      type: 'call-reject',
      sender_name: this.username,
      receive_name: partnerId,
    });
  }

  toggleMute(partnerId: string)    { this.videoCallService.toggleMute(partnerId); }
  toggleCamera(partnerId: string)  { this.videoCallService.toggleCamera(partnerId); }
  bringVideoToFront(partnerId: string) { this.videoCallService.bringToFront(partnerId); }

  // ── WebSocket ────────────────────────────────────────────────────────────────

  private initWebSocket(): void {
    this.ws.connect(this.roomId, this.username);

    this.subs.add(
      this.ws.connected$.subscribe({
        next: (connected) => {
          this.wsConnected = connected;
          if (connected) this.toast.success(`Connected to room "${this.roomId}"`);
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

        // ── Player movement ──
        if (msg.type === 'move' && msg.username && msg.username !== this.username) {
          this.updateOtherPlayer(msg.username, msg.x ?? 50, msg.y ?? 50);
        }

        // ── Position request — reply immediately ──
        if (msg.type === 'position') {
          this.ws.send({
            type: 'move',
            username: this.username,
            x: Math.round(this.avatarX * 100) / 100,
            y: Math.round(this.avatarY * 100) / 100,
          });
        }

        // ── Text chat ──
        if (msg.type === 'message' && msg.sender_name && msg.sender_name !== this.username) {
          this.receiveMessage(msg.sender_name, msg.message ?? '');
        }

        // ── WebRTC signaling ──
        if (msg.sender_name && msg.sender_name !== this.username) {

          if (msg.type === 'offer' && msg.offer) {
            this.videoCallService
              .handleIncomingOffer(this.username, msg.sender_name, msg.offer, (m) => this.ws.send(m))
              .catch(err => console.error('[WebRTC] handleIncomingOffer error', err));
          }

          if (msg.type === 'answer' && msg.answer) {
            this.videoCallService
              .handleAnswer(msg.sender_name, msg.answer)
              .catch(err => console.error('[WebRTC] handleAnswer error', err));
          }

          if (msg.type === 'ice-candidate' && msg.candidate) {
            this.videoCallService
              .handleIceCandidate(msg.sender_name, msg.candidate)
              .catch(err => console.error('[WebRTC] handleIceCandidate error', err));
          }

          if (msg.type === 'call-reject') {
            const had = this.videoCallService.getSession(msg.sender_name);
            if (had) {
              this.videoCallService.endCall(msg.sender_name);
              this.toast.warning(`${msg.sender_name} ended the call.`);
            }
          }
        }
      })
    );
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private receiveMessage(senderUsername: string, text: string): void {
    if (!this.chatWindows().find(w => w.id === senderUsername)) {
      this.openChat(senderUsername);
    }
    this.chatWindows.update(wins =>
      wins.map(w => w.id === senderUsername
        ? { ...w, messages: [...w.messages, { text, sent: false, timestamp: new Date() }] }
        : w
      )
    );
  }

  private updateOtherPlayer(username: string, x: number, y: number): void {
    this.otherPlayers.update(players => {
      const idx = players.findIndex(p => p.username === username);
      if (idx === -1) {
        return [...players, {
          username, x, y,
          avatarUrl: `https://api.dicebear.com/9.x/personas/svg?seed=${encodeURIComponent(username)}`
        }];
      }
      const updated = [...players];
      updated[idx] = { ...updated[idx], x, y };
      return updated;
    });
    this.updateProximity();
  }

  // ── Leave room ────────────────────────────────────────────────────────────────

  async leaveRoom(): Promise<void> {
    if (this.isLeaving) return;
    this.isLeaving = true;
    this.stopGameLoop();
    this.videoCallService.cleanup();
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
        this.toast.error(err.status === 0
          ? 'Cannot connect to server. Redirecting to login…'
          : `Error ${err.status}: ${err.message}`);
        setTimeout(() => this.router.navigate(['/login'], { queryParams: { user: this.username } }), 1500);
      }
    });
  }
}
