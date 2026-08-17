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
}

export interface OutboundResult {
  /** Provider (Meta) message id, stored against the outbound `messages` row. */
  providerMessageId: string;
}
