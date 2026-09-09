/**
 * Coalesces high-frequency stream deltas (onToken/onThinking) into at most
 * one UI commit per window (streaming ticket 06). Long sessions must not
 * degrade: N deltas inside the window cause a single setState, and the end
 * of a stream forces a flush so no tail is ever lost.
 */
export class StreamBatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param flush Called at most once per window when schedules coalesce.
   * @param intervalMs Coalescing window; 0 flushes on the next tick.
   */
  constructor(
    private readonly flush: () => void,
    private readonly intervalMs: number = 32,
  ) {}

  /** Request a flush; multiple requests inside the window coalesce into one. */
  schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.intervalMs);
  }

  /** Force an immediate flush and cancel any pending window. */
  flushNow(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }

  /** Cancel the pending timer without flushing (unmount cleanup). */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
