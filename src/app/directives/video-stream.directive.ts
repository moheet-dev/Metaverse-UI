import { Directive, ElementRef, Input, inject } from '@angular/core';

/**
 * Directive to set `srcObject` on a <video> element from Angular binding.
 * We can't use [srcObject] directly in templates because it's not a standard HTML attribute;
 * this directive bridges Angular signals → DOM property.
 *
 * Usage: <video appVideoStream [stream]="session.remoteStream" autoplay playsinline></video>
 */
@Directive({
  selector: 'video[appVideoStream]',
  standalone: true,
})
export class VideoStreamDirective {
  private el = inject(ElementRef<HTMLVideoElement>);

  @Input() set stream(src: MediaStream | null | undefined) {
    const video = this.el.nativeElement;
    if (src) {
      if (video.srcObject !== src) {
        video.srcObject = src;
        video.muted = true; // guarantees autoplay is allowed
        video.play()
          .then(() => { video.muted = false; }) // unmute once playing
          .catch((err: any) => console.warn('[VideoStream] play() blocked:', err.name, err.message));
      }
    } else {
      video.srcObject = null;
    }
  }
}
