import type { OutboundResult, WhatsAppChannel } from './channel.js';

/**
 * In-memory WhatsApp channel for tests and the simulation harness (§13).
 *
 * Records every send and hands back a stable, unique message id — no network,
 * no Meta. {@link failNext} makes the next sends throw, which is how the
 * crash-resume tests inject a failure between the reply being generated and the
 * turn being persisted.
 */
export class FakeChannel implements WhatsAppChannel {
  /** Every successful send, in order. */
  readonly sent: { to: string; text: string; providerMessageId: string }[] = [];
  private counter = 0;
  private failures = 0;

  /** Make the next `n` sends reject before recording anything. */
  failNext(n = 1): void {
    this.failures += n;
  }

  sendText(to: string, text: string): Promise<OutboundResult> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('FakeChannel: send failed'));
    }

    const providerMessageId = `fake-out-${(this.counter += 1)}`;
    this.sent.push({ to, text, providerMessageId });
    return Promise.resolve({ providerMessageId });
  }
}
