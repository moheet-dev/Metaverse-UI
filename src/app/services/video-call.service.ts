import { Injectable, signal } from '@angular/core';

/** State of a single call session */
export type CallState = 'calling' | 'incoming' | 'connected';

/** One video call session (one per remote partner) */
export interface VideoCallSession {
  partnerId: string;
  peer: RTCPeerConnection;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  state: CallState;
  position: { x: number; y: number };
  zIndex: number;
  isMuted: boolean;
  isCameraOff: boolean;
  /** ICE candidates buffered before remoteDescription is set */
  pendingCandidates: RTCIceCandidateInit[];
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

@Injectable({ providedIn: 'root' })
export class VideoCallService {
  /** All active/pending call sessions — signal-driven for template reactivity */
  readonly sessions = signal<VideoCallSession[]>([]);

  private topZIndex = 300;

  // ── Outgoing call (caller) ──────────────────────────────────────────────────

  async startCall(
    myId: string,
    partnerId: string,
    send: (msg: Record<string, unknown>) => void
  ): Promise<void> {
    if (this.getSession(partnerId)) {
      this.bringToFront(partnerId);
      return;
    }

    const localStream = await this.getMedia();
    const peer = this.createPeer(myId, partnerId, send);

    // Add tracks BEFORE creating offer so remote knows about them
    localStream.getTracks().forEach(t => peer.addTrack(t, localStream));

    const session: VideoCallSession = {
      partnerId,
      peer,
      localStream,
      remoteStream: null,
      state: 'calling',
      position: { x: 100 + this.sessions().length * 40, y: 80 },
      zIndex: ++this.topZIndex,
      isMuted: false,
      isCameraOff: false,
      pendingCandidates: [],
    };

    this.sessions.update(ss => [...ss, session]);

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    send({
      type: 'offer',
      sender_name: myId,
      receiver_name: partnerId,
      offer: peer.localDescription,
    });
  }

  // ── Incoming call (callee — offer received) ─────────────────────────────────

  async handleIncomingOffer(
    myId: string,
    fromId: string,
    offer: RTCSessionDescriptionInit,
    send: (msg: Record<string, unknown>) => void
  ): Promise<void> {
    // If already in a session with this peer, ignore duplicate offers
    if (this.getSession(fromId)) return;

    const peer = this.createPeer(myId, fromId, send);

    const session: VideoCallSession = {
      partnerId: fromId,
      peer,
      localStream: null,
      remoteStream: null,
      state: 'incoming',
      position: { x: 100 + this.sessions().length * 40, y: 80 },
      zIndex: ++this.topZIndex,
      isMuted: false,
      isCameraOff: false,
      pendingCandidates: [],
    };

    this.sessions.update(ss => [...ss, session]);

    await peer.setRemoteDescription(offer);
    // Flush any ICE candidates that arrived before the offer was processed
    await this.flushPendingCandidates(fromId);
  }

  // ── Accept incoming call (callee) ───────────────────────────────────────────

  async acceptCall(
    myId: string,
    partnerId: string,
    send: (msg: Record<string, unknown>) => void
  ): Promise<void> {
    const session = this.getSession(partnerId);
    if (!session) return;

    let localStream: MediaStream;
    try {
      localStream = await this.getMedia();
    } catch {
      throw new Error('camera_denied');
    }

    localStream.getTracks().forEach(t => session.peer.addTrack(t, localStream));

    // Update local stream and state together
    this.sessions.update(ss =>
      ss.map(s => s.partnerId === partnerId ? { ...s, localStream, state: 'connected' } : s)
    );

    const answer = await session.peer.createAnswer();
    await session.peer.setLocalDescription(answer);

    send({
      type: 'answer',
      sender_name: myId,
      receiver_name: partnerId,
      answer: session.peer.localDescription,
    });
  }

  // ── Caller receives answer ──────────────────────────────────────────────────

  async handleAnswer(fromId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const session = this.getSession(fromId);
    if (!session) return;

    await session.peer.setRemoteDescription(answer);
    this.updateSessionField(fromId, 'state', 'connected');
    await this.flushPendingCandidates(fromId);
  }

  // ── ICE candidates ──────────────────────────────────────────────────────────

  async handleIceCandidate(fromId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const session = this.getSession(fromId);
    if (!session) return;

    if (session.peer.remoteDescription) {
      try { await session.peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* ignore */ }
    } else {
      // Buffer until remoteDescription is ready
      this.sessions.update(ss =>
        ss.map(s => s.partnerId === fromId
          ? { ...s, pendingCandidates: [...s.pendingCandidates, candidate] }
          : s
        )
      );
    }
  }

  // ── End / reject call ───────────────────────────────────────────────────────

  endCall(partnerId: string): void {
    const session = this.getSession(partnerId);
    if (!session) return;

    session.localStream?.getTracks().forEach(t => t.stop());
    session.peer.close();
    this.sessions.update(ss => ss.filter(s => s.partnerId !== partnerId));
  }

  /** Clean up ALL sessions (called on room leave / destroy) */
  cleanup(): void {
    this.sessions().forEach(s => {
      s.localStream?.getTracks().forEach(t => t.stop());
      s.peer.close();
    });
    this.sessions.set([]);
  }

  // ── Media controls ──────────────────────────────────────────────────────────

  toggleMute(partnerId: string): void {
    const session = this.getSession(partnerId);
    if (!session?.localStream) return;

    const newMuted = !session.isMuted;
    session.localStream.getAudioTracks().forEach(t => { t.enabled = !newMuted; });
    this.updateSessionField(partnerId, 'isMuted', newMuted);
  }

  toggleCamera(partnerId: string): void {
    const session = this.getSession(partnerId);
    if (!session?.localStream) return;

    const newCameraOff = !session.isCameraOff;
    session.localStream.getVideoTracks().forEach(t => { t.enabled = !newCameraOff; });
    this.updateSessionField(partnerId, 'isCameraOff', newCameraOff);
  }

  // ── Window management ───────────────────────────────────────────────────────

  bringToFront(partnerId: string): void {
    this.sessions.update(ss =>
      ss.map(s => s.partnerId === partnerId ? { ...s, zIndex: ++this.topZIndex } : s)
    );
  }

  updatePosition(partnerId: string, x: number, y: number): void {
    this.sessions.update(ss =>
      ss.map(s => s.partnerId === partnerId ? { ...s, position: { x, y } } : s)
    );
  }

  getSession(partnerId: string): VideoCallSession | undefined {
    return this.sessions().find(s => s.partnerId === partnerId);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private createPeer(
    myId: string,
    partnerId: string,
    send: (msg: Record<string, unknown>) => void
  ): RTCPeerConnection {
    const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Forward ICE candidates to partner via WebSocket
    peer.onicecandidate = ({ candidate }) => {
      if (candidate) {
        send({
          type: 'ice-candidate',
          sender_name: myId,
          receiver_name: partnerId,
          candidate: candidate.toJSON(),
        });
      }
    };

    // When remote track arrives, attach it as remoteStream
    peer.ontrack = (event) => {
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      this.sessions.update(ss =>
        ss.map(s => {
          if (s.partnerId !== partnerId) return s;
          const nextState: CallState = s.state === 'incoming' ? 'incoming' : 'connected';
          return { ...s, remoteStream, state: nextState };
        })
      );
    };

    // Auto-clean up on disconnection
    peer.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(peer.connectionState)) {
        this.endCall(partnerId);
      }
    };

    return peer;
  }

  private async getMedia(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }

  private async flushPendingCandidates(partnerId: string): Promise<void> {
    const session = this.getSession(partnerId);
    if (!session?.pendingCandidates.length) return;

    for (const c of session.pendingCandidates) {
      try { await session.peer.addIceCandidate(new RTCIceCandidate(c)); } catch { /* ignore */ }
    }

    this.sessions.update(ss =>
      ss.map(s => s.partnerId === partnerId ? { ...s, pendingCandidates: [] } : s)
    );
  }

  private updateSessionField<K extends keyof VideoCallSession>(
    partnerId: string,
    field: K,
    value: VideoCallSession[K]
  ): void {
    this.sessions.update(ss =>
      ss.map(s => s.partnerId === partnerId ? { ...s, [field]: value } : s)
    );
  }
}
