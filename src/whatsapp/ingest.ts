import type { DbClient } from '../db/client.js';
import { findContactByPhone, upsertContactByPhone } from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  recordInboundActivity,
} from '../db/repositories/conversations.js';
import { recordInboundMessage } from '../db/repositories/messages.js';
import { updateDeliveryStatus } from '../db/repositories/messages.js';
import { campaignReferrals } from '../db/schema.js';
import { tryNormalizePhone } from '../domain/phone.js';
import type { InboundMessageEvent, StatusEvent, WebhookEvent } from './payload.js';

/**
 * Ingestion of webhook events into the database.
 *
 * Deliberately stops at persistence. Deciding what to reply is the conversation
 * workflow's job (M3); this layer's only responsibility is to turn a webhook
 * into durable state exactly once.
 */

export interface IngestResult {
  /** Conversation the message belongs to. Absent for status events. */
  conversationId?: string;
  contactId?: string;
  /** True when this webhook had already been processed. */
  duplicate: boolean;
  /** True when the message opened a brand-new conversation. */
  conversationCreated: boolean;
  /** Set when the event was ignored, with the reason. */
  skipped?: string;
}

/**
 * Persists a single inbound message.
 *
 * Everything happens in one transaction: contact, conversation, message, window
 * refresh, and referral all commit together or not at all. A partial write here
 * would produce a conversation with no message, or a contact with no
 * conversation — states nothing downstream knows how to interpret.
 */
export async function ingestMessage(
  db: DbClient,
  event: InboundMessageEvent,
): Promise<IngestResult> {
  // Meta sends `from` without a leading plus. An unparseable number cannot be
  // acted on, and rejecting the webhook would make Meta retry it forever.
  const phone = tryNormalizePhone(event.from);
  if (!phone) {
    return { duplicate: false, conversationCreated: false, skipped: 'unparseable_phone' };
  }

  return db.transaction(async (tx) => {
    // The WhatsApp profile name is a self-chosen display name and is often
    // decorated or a nickname. It is a fallback only: a name already captured
    // from the lead form is the real one and must not be overwritten.
    const existing = await findContactByPhone(tx, phone);
    const useProfileName = event.profileName && !existing?.name;

    const contact = await upsertContactByPhone(tx, {
      phone,
      ...(useProfileName ? { name: event.profileName } : {}),
      ...(event.referral ? { entryPoint: 'click_to_whatsapp' as const } : {}),
    });

    const { conversation, created } = await findOrCreateConversation(tx, contact.id);

    const { duplicate } = await recordInboundMessage(tx, {
      conversationId: conversation.id,
      providerMessageId: event.providerMessageId,
      body: event.text,
      mediaType: event.media?.kind,
      // The binary is fetched from the Graph API separately; only the id is
      // known at this point.
      mediaUrl: event.media?.id,
      createdAt: event.timestamp,
    });

    // A redelivery must not refresh the messaging window or re-record the
    // referral, and must not cause a second reply.
    if (duplicate) {
      return {
        conversationId: conversation.id,
        contactId: contact.id,
        duplicate: true,
        conversationCreated: false,
      };
    }

    await recordInboundActivity(tx, conversation.id, event.timestamp);

    if (event.referral) {
      await tx
        .insert(campaignReferrals)
        .values({
          contactId: contact.id,
          adId: event.referral.sourceId ?? null,
          sourceUrl: event.referral.sourceUrl ?? null,
          headline: event.referral.headline ?? null,
          rawPayload: event.referral,
        })
        .onConflictDoNothing();
    }

    return {
      conversationId: conversation.id,
      contactId: contact.id,
      duplicate: false,
      conversationCreated: created,
    };
  });
}

/** Applies a delivery status update to the message it refers to. */
export async function ingestStatus(db: DbClient, event: StatusEvent): Promise<void> {
  const status = mapDeliveryStatus(event.status);
  if (!status) return;

  await updateDeliveryStatus(db, event.providerMessageId, status, event.errorTitle);
}

/** Maps Meta's status strings onto our enum, ignoring ones we do not model. */
function mapDeliveryStatus(
  status: string,
): 'sent' | 'delivered' | 'read' | 'failed' | undefined {
  switch (status) {
    case 'sent':
    case 'delivered':
    case 'read':
    case 'failed':
      return status;
    default:
      return undefined;
  }
}

/**
 * Ingests every event in a webhook batch.
 *
 * Each event is handled independently: one failure must not prevent the others
 * from being stored, or a single bad event would hold up real conversations
 * through Meta's retries.
 */
export async function ingestEvents(
  db: DbClient,
  events: WebhookEvent[],
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];

  for (const event of events) {
    if (event.kind === 'message') {
      results.push(await ingestMessage(db, event));
    } else {
      await ingestStatus(db, event);
    }
  }

  return results;
}
