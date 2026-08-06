import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="toast-container" aria-live="polite" aria-label="Notifications">
      @for (toast of toastService.toasts(); track toast.id) {
        <div
          class="toast toast--{{ toast.type }}"
          role="alert"
          (click)="toastService.dismiss(toast.id)"
        >
          <span class="toast__icon">{{ toast.icon }}</span>
          <span class="toast__message">{{ toast.message }}</span>
          <button class="toast__close" aria-label="Dismiss">✕</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .toast-container {
      position: fixed;
      top: 24px;
      right: 24px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 380px;
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 18px;
      border-radius: 14px;
      backdrop-filter: blur(20px) saturate(1.4);
      -webkit-backdrop-filter: blur(20px) saturate(1.4);
      border: 1px solid transparent;
      cursor: pointer;
      pointer-events: all;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);
      animation: toastSlideIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      font-family: 'Outfit', sans-serif;
      font-size: 14px;
      line-height: 1.4;
      transition: all 0.2s ease;

      &:hover {
        transform: translateX(-4px);
      }

      &--success {
        background: rgba(34, 90, 55, 0.88);
        border-color: rgba(74, 222, 128, 0.35);
        color: #d1fae5;
      }
      &--error {
        background: rgba(90, 24, 24, 0.9);
        border-color: rgba(248, 113, 113, 0.35);
        color: #fee2e2;
      }
      &--info {
        background: rgba(20, 50, 90, 0.9);
        border-color: rgba(96, 165, 250, 0.35);
        color: #dbeafe;
      }
      &--warning {
        background: rgba(90, 60, 10, 0.9);
        border-color: rgba(251, 191, 36, 0.35);
        color: #fef3c7;
      }
    }

    .toast__icon {
      font-size: 18px;
      flex-shrink: 0;
    }

    .toast__message {
      flex: 1;
      font-weight: 500;
    }

    .toast__close {
      background: none;
      border: none;
      color: inherit;
      opacity: 0.6;
      cursor: pointer;
      font-size: 13px;
      padding: 0 2px;
      line-height: 1;
      flex-shrink: 0;
      transition: opacity 0.2s;

      &:hover { opacity: 1; }
    }

    @keyframes toastSlideIn {
      from {
        opacity: 0;
        transform: translateX(60px) scale(0.9);
      }
      to {
        opacity: 1;
        transform: translateX(0) scale(1);
      }
    }
  `]
})
export class ToastContainerComponent {
  toastService = inject(ToastService);
}
