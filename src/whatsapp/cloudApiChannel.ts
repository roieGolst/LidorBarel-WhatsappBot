import { z } from 'zod';
import { getConfig } from '../config.js';
import { getLogger } from '../logger.js';
import type { OutboundResult, WhatsAppChannel } from './channel.js';

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

/**
 * A real {@link WhatsAppChannel} that sends a free-form text message through the
 * Meta WhatsApp Cloud API.
 *
 * Free-form text only, deliberately: this is the M4 reply transport, which is
 * valid only inside the 24-hour customer-service window (see {@link
 * ../db/repositories/conversations.js}). Business-initiated messages outside the
 * window require an approved template, which is blocked on Meta Business
 * verification and is not built here.
 *
 * The channel never enforces opt-out itself — every send still goes through
 * {@link ./guardedSend.js}, the single choke point, so the rule cannot be
 * skipped by swapping the transport.
 */
export class CloudApiChannel implements WhatsAppChannel {
  private readonly logger = getLogger();

  constructor(private readonly credentials: CloudApiCredentials) {}

  async sendText(to: string, text: string): Promise<OutboundResult> {
    const { accessToken, phoneNumberId, graphApiVersion } = this.credentials;
    const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // The access token is a bearer secret. It lives only in this header and
        // must never reach a log line or an error message — hence the care taken
        // below to report Meta's response body but never the request.
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    });

    if (!response.ok) {
      // Meta returns a JSON `{ error: { message, code, ... } }` on failure, but a
      // gateway in front of it may return HTML or nothing. Read the body as text
      // so a non-JSON error still gives an actionable message rather than a
      // parse error masking the real one. The request — and therefore the token —
      // is never included.
      const detail = await response.text().catch(() => '<unreadable response body>');
      this.logger.warn(
        { status: response.status, phoneNumberId },
        'WhatsApp Cloud API send failed',
      );
      throw new Error(
        `WhatsApp Cloud API send failed: ${response.status} ${response.statusText} — ${detail}`,
      );
    }

    const body: unknown = await response.json();
    const parsed = sendResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        'WhatsApp Cloud API returned a 2xx response without a message id; ' +
          `the response shape was unexpected: ${parsed.error.message}`,
      );
    }

    // messages[0] is guaranteed present: the schema requires a non-empty array.
    const providerMessageId = parsed.data.messages[0]!.id;
    return { providerMessageId };
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
export function createCloudApiChannel(): CloudApiChannel {
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

  return new CloudApiChannel({
    // Non-null asserted: the guard above proves both are present, but the
    // optional-by-group typing cannot narrow across the array check.
    accessToken: config.metaAccessToken!,
    phoneNumberId: config.metaPhoneNumberId!,
    graphApiVersion: config.metaGraphApiVersion,
  });
}
