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

  /**
   * Sends a pre-approved message template.
   *
   * The only thing WhatsApp accepts outside the 24-hour customer-service window,
   * and therefore the only way to open a business-initiated conversation. The
   * wording is fixed at approval time and cannot be varied at send time — only
   * the declared parameters change — which is precisely why it is a separate
   * method rather than another free-form shape.
   *
   * A template send does **not** open a messaging window. Only the person's reply
   * does.
   */
  sendTemplate(to: string, template: OutboundTemplate): Promise<OutboundResult>;

  /**
   * Shows the "typing…" indicator to the person while the bot composes a reply,
   * and marks their message read. Keyed by the INBOUND message's id (Meta requires
   * it). The indicator clears when the next message is sent or after ~25s, so it is
   * sent just before the slow model work. Purely cosmetic — callers treat a failure
   * as non-fatal and never let it block the reply.
   */
  markTyping(inboundMessageId: string): Promise<void>;
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

/**
 * A template to send, resolved to what the Graph API needs.
 *
 * Deliberately narrow: this models the templates this product actually sends —
 * an optional video header and no body variables — rather than Meta's full
 * component grammar. The approved `welcome_message` template has a VIDEO header
 * and no placeholders, and a wording change means re-approval anyway, so the
 * general case can be added when a template needs it.
 */
export interface OutboundTemplate {
  /** The approved template's name, e.g. `welcome_message`. */
  name: string;
  /** Its approved language code, e.g. `he`. Must match exactly. */
  language: string;
  /**
   * Local path to the video for a VIDEO header. The implementation uploads it
   * for a media id, reusing a cached one where possible. Omit for a template
   * with no media header.
   */
  headerVideoPath?: string;
}

export interface OutboundResult {
  /** Provider (Meta) message id, stored against the outbound `messages` row. */
  providerMessageId: string;
}

/**
 * A durable store for Meta media ids, so an uploaded file (the intro clip) is not
 * re-uploaded on every process restart. Injected into the channel; a missing one
 * just means in-memory caching only (uploads once per process).
 */
export interface MediaCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, mediaId: string): Promise<void>;
}
