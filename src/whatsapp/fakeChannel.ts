import type { ListRow, OutboundResult, ReplyButton, WhatsAppChannel } from './channel.js';

/** A send before it has a provider id, discriminated by kind. */
export type DraftMessage =
  | { kind: 'text'; to: string; text: string }
  | { kind: 'video'; to: string; filePath: string; caption?: string }
  | { kind: 'buttons'; to: string; body: string; buttons: readonly ReplyButton[] }
  | {
      kind: 'list';
      to: string;
      body: string;
      buttonLabel: string;
      rows: readonly ListRow[];
    };

/** One recorded send. Intersecting the union with the id keeps each member. */
export type SentMessage = DraftMessage & { providerMessageId: string };

/**
 * In-memory WhatsApp channel for tests and the simulation harness (§13).
 *
 * Records every send and hands back a stable, unique message id — no network,
 * no Meta. {@link failNext} makes the next sends throw, which is how the
 * crash-resume tests inject a failure between the reply being generated and the
 * turn being persisted.
 */
export class FakeChannel implements WhatsAppChannel {
  /** Every successful send, in order, with its full shape. */
  readonly sent: SentMessage[] = [];
  private counter = 0;
  private failures = 0;

  /** Make the next `n` sends reject before recording anything. */
  failNext(n = 1): void {
    this.failures += n;
  }

  sendText(to: string, text: string): Promise<OutboundResult> {
    return this.record({ kind: 'text', to, text });
  }

  sendVideo(to: string, filePath: string, caption?: string): Promise<OutboundResult> {
    return this.record({
      kind: 'video',
      to,
      filePath,
      ...(caption !== undefined ? { caption } : {}),
    });
  }

  sendButtons(
    to: string,
    body: string,
    buttons: readonly ReplyButton[],
  ): Promise<OutboundResult> {
    return this.record({ kind: 'buttons', to, body, buttons });
  }

  sendList(
    to: string,
    body: string,
    buttonLabel: string,
    rows: readonly ListRow[],
  ): Promise<OutboundResult> {
    return this.record({ kind: 'list', to, body, buttonLabel, rows });
  }

  private record(message: DraftMessage): Promise<OutboundResult> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('FakeChannel: send failed'));
    }
    const providerMessageId = `fake-out-${(this.counter += 1)}`;
    this.sent.push({ ...message, providerMessageId });
    return Promise.resolve({ providerMessageId });
  }
}
