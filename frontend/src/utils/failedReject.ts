/**
 * Collaborative mode: after a reject that couldn't revert the document, the error toast
 * offers to reject the same change again to mark it rejected without changing the
 * document. That second reject is honoured only right after the failure, for the same
 * change: any other decision (or an undo) clears the failure, and it expires. So a failed
 * decision never lingers to turn a later, unrelated action into a document-less reject.
 */
export const FORCE_REJECT_WINDOW_MS = 60_000;

export class FailedRejectGate {
  private last: { id: string; at: number } | null = null;

  /**
   * A decision on `changeId` is being made: whether a reject of it may be forced (it is
   * the change whose reject just failed). Clears the remembered failure either way.
   */
  begin(changeId: string, now: number = Date.now()): boolean {
    const last = this.last;
    this.last = null;
    return !!last && last.id === changeId && now - last.at < FORCE_REJECT_WINDOW_MS;
  }

  /** The reject of `changeId` couldn't revert the document. */
  fail(changeId: string, now: number = Date.now()): void {
    this.last = { id: changeId, at: now };
  }

  /** Forget any failure (an undo, another decision). */
  clear(): void {
    this.last = null;
  }

  /** The change whose reject failed last, if still remembered. */
  get failedId(): string | null {
    return this.last?.id ?? null;
  }
}
