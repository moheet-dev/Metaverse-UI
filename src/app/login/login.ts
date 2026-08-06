import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService } from '../services/api.service';
import { ToastService } from '../services/toast.service';
import { ToastContainerComponent } from '../components/toast-container/toast-container.component';

type Stage = 'auth' | 'room-choice' | 'create-room' | 'join-room';
type AuthMode = 'login' | 'register';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, ToastContainerComponent],
  templateUrl: './login.html',
  styleUrl: './login.scss'
})
export class LoginComponent implements OnInit {

  /* ── Stage control (signals — guaranteed reactive) ── */
  stage = signal<Stage>('auth');
  authMode = signal<AuthMode>('login');

  /* ── Loading states (signals) ── */
  isLoadingAuth = signal(false);
  isLoadingCreate = signal(false);
  isLoadingJoin = signal(false);

  /* ── Inline field errors (signals) ── */
  usernameError = signal('');
  passwordError = signal('');
  confirmPasswordError = signal('');
  roomCodeError = signal('');
  roomPasswordError = signal('');

  /* ── Form fields (plain, two-way bound via ngModel) ── */
  username = '';
  password = '';
  confirmPassword = '';
  roomCode = '';
  roomPassword = '';

  /** Theme — 'light' | 'dark', synced with localStorage and room page */
  theme: 'light' | 'dark' = 'light';

  /** Wood strip positions for the animated background */
  readonly woodStrips = [
    { left: '8%' }, { left: '18%' }, { left: '30%' }, { left: '44%' },
    { left: '57%' }, { left: '68%' }, { left: '80%' }, { left: '91%' },
  ];

  private api = inject(ApiService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  ngOnInit(): void {
    // Restore saved theme (shared with room page via localStorage)
    const saved = localStorage.getItem('mv-theme') as 'light' | 'dark' | null;
    this.theme = saved ?? 'light';

    // When returning from a room (leave-room passes ?user=username),
    // pre-fill the username and jump straight to room-choice stage.
    const returnUser = this.route.snapshot.queryParamMap.get('user');
    if (returnUser) {
      this.username = returnUser;
      this.stage.set('room-choice');
    }
  }

  toggleTheme(): void {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('mv-theme', this.theme);
  }

  /* ── Navigation helpers ── */

  switchMode(mode: AuthMode): void {
    if (this.authMode() === mode) return;
    this.authMode.set(mode);
    this.clearAuthErrors();
    this.confirmPassword = '';
  }

  goBackToAuth(): void {
    this.stage.set('auth');
  }

  goBackToChoice(): void {
    this.roomCode = '';
    this.roomPassword = '';
    this.clearRoomErrors();
    this.stage.set('room-choice');
  }

  chooseCreate(): void {
    this.roomCode = '';
    this.roomPassword = '';
    this.clearRoomErrors();
    this.stage.set('create-room');
  }

  chooseJoin(): void {
    this.roomCode = '';
    this.roomPassword = '';
    this.clearRoomErrors();
    this.stage.set('join-room');
  }

  /* ── Error helpers ── */

  private clearAuthErrors(): void {
    this.usernameError.set('');
    this.passwordError.set('');
    this.confirmPasswordError.set('');
  }

  private clearRoomErrors(): void {
    this.roomCodeError.set('');
    this.roomPasswordError.set('');
  }

  /* ── Validation ── */

  private validateAuth(): boolean {
    this.clearAuthErrors();
    let valid = true;

    if (!this.username.trim()) {
      this.usernameError.set('Username is required.');
      valid = false;
    } else if (this.username.trim().length < 3) {
      this.usernameError.set('Username must be at least 3 characters.');
      valid = false;
    }

    if (!this.password) {
      this.passwordError.set('Password is required.');
      valid = false;
    } else if (this.password.length < 6) {
      this.passwordError.set('Password must be at least 6 characters.');
      valid = false;
    }

    if (this.authMode() === 'register') {
      if (!this.confirmPassword) {
        this.confirmPasswordError.set('Please confirm your password.');
        valid = false;
      } else if (this.confirmPassword !== this.password) {
        this.confirmPasswordError.set('Passwords do not match.');
        valid = false;
      }
    }

    return valid;
  }

  private validateRoom(): boolean {
    this.clearRoomErrors();
    let valid = true;

    if (!this.roomCode.trim()) {
      this.roomCodeError.set('Room code is required.');
      valid = false;
    } else if (!/^[a-zA-Z0-9_-]+$/.test(this.roomCode.trim())) {
      this.roomCodeError.set('Only letters, numbers, hyphens and underscores allowed.');
      valid = false;
    }

    if (!this.roomPassword) {
      this.roomPasswordError.set('Room password is required.');
      valid = false;
    } else if (this.roomPassword.length < 4) {
      this.roomPasswordError.set('Room password must be at least 4 characters.');
      valid = false;
    }

    return valid;
  }

  /* ── Stage 1: Auth submit ── */

  onAuthSubmit(): void {
    if (!this.validateAuth()) {
      this.toast.warning('Please fix the highlighted fields before continuing.');
      return;
    }

    this.isLoadingAuth.set(true);
    const payload = { username: this.username.trim(), password: this.password };

    const request$ = this.authMode() === 'register'
      ? this.api.register(payload)
      : this.api.login(payload);

    request$.subscribe({
      next: (res) => {
        this.isLoadingAuth.set(false);

        if (res.status === 200 || res.status === 201) {
          const verb = this.authMode() === 'register' ? 'Account created' : 'Welcome back';
          this.toast.success(`${verb}, ${this.username.trim()}! Choose your room.`);
          this.stage.set('room-choice');
          return;
        }

        this.toast.error(res.message ?? 'Unexpected response from server.');
      },
      error: (err: HttpErrorResponse) => {
        this.isLoadingAuth.set(false);
        if (err.status === 0) {
          this.toast.error('Cannot connect to server. Is the backend running?');
        } else if (err.status === 401) {
          this.passwordError.set('Incorrect password.');
          this.toast.error('Invalid credentials. Please try again.');
        } else if (err.status === 404) {
          this.usernameError.set('No account found with this username.');
          this.toast.error('User not found. Try registering instead.');
        } else if (err.status === 409) {
          this.usernameError.set('Username already taken. Please choose another.');
          this.toast.error('Username already exists.');
        } else {
          this.toast.error(`Error ${err.status}: ${err.message}`);
        }
      }
    });
  }

  /* ── Stage 3a: Create Room ── */

  submitCreateRoom(): void {
    if (!this.validateRoom()) {
      this.toast.warning('Please fix the highlighted fields before continuing.');
      return;
    }

    this.isLoadingCreate.set(true);
    this.toast.info('Creating your room…');

    this.api.createRoom({
      username: this.username.trim(),
      room_code: this.roomCode.trim(),
      room_password: this.roomPassword
    }).subscribe({
      next: (res) => {
        this.isLoadingCreate.set(false);

        if (res.status === 200 || res.status === 201) {
          this.toast.success(`Room "${this.roomCode}" created! Welcome, ${this.username}!`);
          setTimeout(() => {
            this.router.navigate(['/room', this.roomCode.trim()], {
              queryParams: { user: this.username.trim() }
            });
          }, 800);
          return;
        }

        this.toast.error(res.message ?? 'Unexpected response from server.');
      },
      error: (err: HttpErrorResponse) => {
        this.isLoadingCreate.set(false);
        if (err.status === 0) {
          this.toast.error('Cannot connect to server. Is the backend running?');
        } else if (err.status === 400 || err.status === 409) {
          this.roomCodeError.set('A room with this code already exists.');
          this.toast.error('Room code already taken. Try a different one.');
        } else {
          this.toast.error(`Error ${err.status}: ${err.message}`);
        }
      }
    });
  }

  /* ── Stage 3b: Join Room ── */

  submitJoinRoom(): void {
    if (!this.validateRoom()) {
      this.toast.warning('Please fix the highlighted fields before continuing.');
      return;
    }

    this.isLoadingJoin.set(true);
    this.toast.info('Joining room…');

    this.api.joinRoom({
      username: this.username.trim(),
      room_code: this.roomCode.trim(),
      room_password: this.roomPassword
    }).subscribe({
      next: (res) => {
        this.isLoadingJoin.set(false);

        if (res.status === 200) {
          this.toast.success(`Joined room "${this.roomCode}"! Welcome, ${this.username}!`);
          setTimeout(() => {
            this.router.navigate(['/room', this.roomCode.trim()], {
              queryParams: { user: this.username.trim() }
            });
          }, 800);
          return;
        }

        this.toast.error(res.message ?? 'Unexpected response from server.');
      },
      error: (err: HttpErrorResponse) => {
        this.isLoadingJoin.set(false);
        if (err.status === 0) {
          this.toast.error('Cannot connect to server. Is the backend running?');
        } else if (err.status === 401) {
          this.roomPasswordError.set('Incorrect room password.');
          this.toast.error('Wrong room password. Please try again.');
        } else if (err.status === 404) {
          this.roomCodeError.set('Room not found or incorrect credentials.');
          this.toast.error('Room not found or wrong password.');
        } else {
          this.toast.error(`Error ${err.status}: ${err.message}`);
        }
      }
    });
  }

  onSubmit(): void {
    // Handled by button clicks / onAuthSubmit
  }
}
