import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamBatcher } from '../../src/tui/stream-batcher.js';

describe('StreamBatcher (streaming ticket 06)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple schedules inside the window into one flush', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = new StreamBatcher(flush, 32);

    batcher.schedule();
    batcher.schedule();
    batcher.schedule();
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(32);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('flushes again for schedules arriving after the window', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = new StreamBatcher(flush, 32);

    batcher.schedule();
    vi.advanceTimersByTime(32);
    expect(flush).toHaveBeenCalledTimes(1);

    batcher.schedule();
    vi.advanceTimersByTime(32);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('flushNow forces an immediate flush and cancels the pending timer', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = new StreamBatcher(flush, 32);

    batcher.schedule();
    batcher.flushNow();
    expect(flush).toHaveBeenCalledTimes(1);

    // The pending window must not fire a second flush
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('flushNow without a pending schedule does not flush', () => {
    const flush = vi.fn();
    const batcher = new StreamBatcher(flush, 32);
    batcher.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });

  it('dispose cancels the pending timer without flushing', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = new StreamBatcher(flush, 32);

    batcher.schedule();
    batcher.dispose();
    vi.advanceTimersByTime(100);
    expect(flush).not.toHaveBeenCalled();
  });
});
