import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { getLogger } from '../logger.js';
import type {
  ListRow,
  MediaCache,
  OutboundResult,
  ReplyButton,
  WhatsAppChannel,
} from './channel.js';

/**
 * The credentials a {@link CloudApiChannel} needs to reach Meta.
 *
 * Injected rather than read from {@link getConfig} inside the channel so the
 * class is trivially unit-testable with a mocked `fetch` and no environment,
 * and so the "are the Meta secrets actually present?" check happens once, at
 * construction, in {@link createCloudApiChannel} — the point of use the config
 * module's comments describe.
 */
export interface CloudApiCredentials {
  accessToken: string;
  phoneNumberId: string;
  /** Graph API version, e.g. `v21.0`. */
  graphApiVersion: string;
}

/**
 * The shape of Meta's message-send response we depend on.
 *
 * Parsed rather than trusted: a 2xx with an unexpected body (an API change, a
 * proxy interposing) would otherwise surface much later as an `undefined`
 * provider message id written against an outbound row. Validating here turns
 * that into a clear failure at the send site.
 */
const sendResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).min(1),
});

/** Meta's `POST /media` upload response: the reusable media id. */
const uploadResponseSchema = z.object({ id: z.string().min(1) });

/**
 * A real {@link WhatsAppChannel} over the Meta WhatsApp Cloud API: free-form
 * text, video, and the two interactive shapes (reply buttons and a list).
 *
 * All of these are session messages, valid only inside the 24-hour
 * customer-service window (see {@link ../db/repositories/conversations.js}).
 * Business-initiated messages outside the window require an approved template,
 * which is blocked on Meta Business verification and is not built here.
 *
 * The channel never enforces opt-out itself — every send still goes through
 * {@link ./guardedSend.js}, the single choke point, so the rule cannot be
 * skipped by swapping the transport.
 */
export class CloudApiChannel implements WhatsAppChannel {
  private readonly logger = getLogger();

  /**
   * In-memory uploaded-media ids, keyed by an asset key (`<path>:<mtimeMs>`).
   * WhatsApp needs a media id rather than a raw file, and an id from `POST /media`
   * is reusable, so the intro clip is uploaded once and reused. The optional
   * {@link MediaCache} extends this across process restarts.
   */
  private readonly mediaIds = new Map<string, string>();

  constructor(
    private readonly credentials: CloudApiCredentials,
    private readonly cache?: MediaCache,
  ) {}

  sendText(to: string, text: string): Promise<OutboundResult> {
    return this.postMessage({ to, type: 'text', text: { body: text } });
  }

  async sendVideo(
    to: string,
    filePath: string,
    caption?: string,
  ): Promise<OutboundResult> {
    const id = await this.uploadMediaCached(filePath, 'video/mp4');
    return this.postMessage({
      to,
      type: 'video',
      video: { id, ...(caption ? { caption } : {}) },
    });
  }

  sendButtons(
    to: string,
    body: string,
    buttons: readonly ReplyButton[],
  ): Promise<OutboundResult> {
    return this.postMessage({
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    });
  }

  sendList(
    to: string,
    body: string,
    buttonLabel: string,
    rows: readonly ListRow[],
  ): Promise<OutboundResult> {
    return this.postMessage({
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: buttonLabel,
          sections: [
            {
              rows: rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
              })),
            },
          ],
        },
      },
    });
  }

  /**
   * Marks the inbound message read and shows a typing indicator. Uses the same
   * `/messages` endpoint but a different payload shape (a status update, not a
   * message), so it does not go through {@link postMessage} — there is no outbound
   * message id to return.
   */
  async markTyping(inboundMessageId: string): Promise<void> {
    const { accessToken, phoneNumberId, graphApiVersion } = this.credentials;
    const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: inboundMessageId,
        typing_indicator: { type: 'text' },
      }),
    });
    await this.assertOk(response, 'typing indicator');
  }

  /**
   * Uploads a file for a media id, memoized in-process and (if configured) in the
   * durable {@link MediaCache}. Keyed by path + modified-time, so replacing the
   * file forces exactly one fresh upload.
   */
  private async uploadMediaCached(filePath: string, mimeType: string): Promise<string> {
    const { mtimeMs } = await stat(filePath);
    const key = `${filePath}:${mtimeMs}`;

    const inMemory = this.mediaIds.get(key);
    if (inMemory) return inMemory;

    const persisted = await this.cache?.get(key);
    if (persisted) {
      this.mediaIds.set(key, persisted);
      return persisted;
    }

    const { accessToken, phoneNumberId, graphApiVersion } = this.credentials;
    const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/media`;

    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([bytes], { type: mimeType }), basename(filePath));

    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    await this.assertOk(response, 'media upload');

    const parsed = uploadResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(
        `WhatsApp Cloud API media upload returned no id: ${parsed.error.message}`,
      );
    }
    this.mediaIds.set(key, parsed.data.id);
    await this.cache?.set(key, parsed.data.id);
    return parsed.data.id;
  }

  /** POSTs a message payload to the Graph API and returns its provider id. */
  private async postMessage(payload: Record<string, unknown>): Promise<OutboundResult> {
    const { accessToken, phoneNumberId, graphApiVersion } = this.credentials;
    const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // The access token is a bearer secret. It lives only in this header and
        // must never reach a log line or an error message.
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    await this.assertOk(response, 'send');

    const parsed = sendResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(
        'WhatsApp Cloud API returned a 2xx response without a message id; ' +
          `the response shape was unexpected: ${parsed.error.message}`,
      );
    }
    // messages[0] is guaranteed present: the schema requires a non-empty array.
    return { providerMessageId: parsed.data.messages[0]!.id };
  }

  /** Throws a token-free, actionable error on a non-2xx Meta response. */
  private async assertOk(response: Response, op: string): Promise<void> {
    if (response.ok) return;
    // Meta returns JSON `{ error: {...} }` on failure, but a gateway may return
    // HTML or nothing. Read as text so a non-JSON error still gives an actionable
    // message. The request — and therefore the token — is never included.
    const detail = await response.text().catch(() => '<unreadable response body>');
    this.logger.warn(
      { status: response.status, phoneNumberId: this.credentials.phoneNumberId, op },
      'WhatsApp Cloud API request failed',
    );
    throw new Error(
      `WhatsApp Cloud API ${op} failed: ${response.status} ${response.statusText} — ${detail}`,
    );
  }
}

/**
 * Builds a {@link CloudApiChannel} from validated application configuration.
 *
 * The Meta credentials are optional as a group in {@link getConfig} so the app
 * boots for tests against the fake transport. This is the point of use, so this
 * is where their absence becomes a clear, immediate failure — rather than a
 * confusing 401 from Meta once a live send is attempted.
 *
 * @throws {Error} if any required Meta credential is missing, naming the
 *   variables (never their values).
 */
export function createCloudApiChannel(cache?: MediaCache): CloudApiChannel {
  const config = getConfig();

  const missing: string[] = [];
  if (!config.metaAccessToken) missing.push('META_ACCESS_TOKEN');
  if (!config.metaPhoneNumberId) missing.push('META_PHONE_NUMBER_ID');
  if (missing.length > 0) {
    throw new Error(
      `Cannot create the WhatsApp Cloud API channel: missing ${missing.join(', ')}. ` +
        'See .env.example.',
    );
  }

  return new CloudApiChannel(
    {
      // Non-null asserted: the guard above proves both are present, but the
      // optional-by-group typing cannot narrow across the array check.
      accessToken: config.metaAccessToken!,
      phoneNumberId: config.metaPhoneNumberId!,
      graphApiVersion: config.metaGraphApiVersion,
    },
    cache,
  );
}
