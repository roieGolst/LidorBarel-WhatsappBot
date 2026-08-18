/**
 * The workflow's dependency on WhatsApp transport.
 *
 * A thin interface, not the Cloud API client directly — not for multi-provider
 * support, but so the conversation workflow can be driven and tested without
 * live Meta calls, and so transport concerns stay out of the conversation logic
 * (the plan's §1 boundary: LangGraph decides *what* to say; how to send it lives
 * behind this seam).
 *
 * Beyond free-form text, the channel carries the spec's opening sequence (§2) and
 * its buttons-first screening (§8): a video (the intro clip) and two interactive
 * message shapes — reply *buttons* (up to 3 options) and a *list* (up to 10),
 * which is how more-than-three-option questions are asked.
 */
export interface WhatsAppChannel {
  /** Sends a free-form text reply, returning the provider's message id. */
  sendText(to: string, text: string): Promise<OutboundResult>;

  /**
   * Sends a video from a local file. The implementation uploads it to Meta to
   * obtain a media id (WhatsApp cannot send a raw path) and may cache that id.
   */
  sendVideo(to: string, filePath: string, caption?: string): Promise<OutboundResult>;

  /** Sends an interactive reply-button message. WhatsApp allows at most 3. */
  sendButtons(
    to: string,
    body: string,
    buttons: readonly ReplyButton[],
  ): Promise<OutboundResult>;

  /** Sends an interactive list message. WhatsApp allows at most 10 rows. */
  sendList(
    to: string,
    body: string,
    buttonLabel: string,
    rows: readonly ListRow[],
  ): Promise<OutboundResult>;
}

/**
 * A quick-reply button. `title` is what the person sees and, on tap, is echoed
 * back as the inbound message text (so it must be classifiable); WhatsApp caps it
 * at 20 characters. `id` is an opaque payload, echoed as `button_reply.id`.
 */
export interface ReplyButton {
  /** Opaque payload, ≤ 256 chars. */
  id: string;
  /** Visible label and echoed reply text, ≤ 20 chars. */
  title: string;
}

/** A row in an interactive list. `title` ≤ 24 chars, `description` ≤ 72. */
export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface OutboundResult {
  /** Provider (Meta) message id, stored against the outbound `messages` row. */
  providerMessageId: string;
}
