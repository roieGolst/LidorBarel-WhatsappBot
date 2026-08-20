/**
 * The workflow's dependency on WhatsApp transport.
 *
 * A thin interface, not the Cloud API client directly — not for multi-provider
 * support, but so the conversation workflow can be driven and tested without
 * live Meta calls, and so transport concerns stay out of the conversation logic
 * (the plan's §1 boundary: LangGraph decides *what* to say; how to send it lives
 * behind this seam).
 *
 * M3 needs only free-form replies. M4 extends this with template sends and
 * message-window state for business-initiated messages.
 */
export interface WhatsAppChannel {
  /** Sends a free-form text reply, returning the provider's message id. */
  sendText(to: string, text: string): Promise<OutboundResult>;

  /**
   * Sends a video by its Meta media id (uploaded and cached ahead of time; see
   * `whatsapp/media.ts`), with an optional caption. Used for testimonial and
   * promo videos. Throwing {@link InvalidMediaError} tells the caller the id has
   * expired so it can re-upload and retry.
   */
  sendVideo(to: string, mediaId: string, caption?: string): Promise<OutboundResult>;
}

export interface OutboundResult {
  /** Provider (Meta) message id, stored against the outbound `messages` row. */
  providerMessageId: string;
}

/**
 * Thrown by {@link WhatsAppChannel.sendVideo} when Meta rejects the media id as
 * expired/unknown, so the caller can re-upload the file and retry once.
 */
export class InvalidMediaError extends Error {
  constructor(readonly mediaId: string) {
    super(`Meta rejected media id ${mediaId} as invalid or expired`);
    this.name = 'InvalidMediaError';
  }
}
