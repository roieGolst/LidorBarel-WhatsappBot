import type { Database } from '../db/client.js';
import { canReceiveProactiveMessage, type Contact } from '../db/repositories/contacts.js';
import type { Conversation } from '../db/repositories/conversations.js';
import { isOptedOut } from '../db/repositories/optOuts.js';
import type { OutboundResult } from './channel.js';
import { canSendFreeForm, sendWindow } from './window.js';

/**
 * The one choke point every outbound message passes through.
 *
 * Three rules are enforced here, together, because each of them is the kind that
 * gets forgotten at exactly one call site:
 *
 *  1. **Never message someone who opted out** (NN-1).
 *  2. **Only a consenting contact may receive a business-initiated message**
 *     (NN-2).
 *  3. **Free-form text may only be sent inside an open 24-hour window**;
 *     outside it, Meta accepts an approved template and nothing else.
 *
 * The caller states *what kind of send this is* rather than passing a bare phone
 * number, and the type system makes the required evidence unavoidable: a
 * proactive send cannot be expressed without a contact to check consent against,
 * and a reply cannot be expressed without the conversation whose window governs
 * it. That is deliberate — the previous signature took only a phone number, and
 * the consent and window guards sat implemented, tested, and never called
 * (defects D-1 and D-2).
 */

/** Thrown when a send is attempted to a contact who has opted out. */
export class OptedOutError extends Error {
  constructor(readonly phone: string) {
    super('refused to send to a contact who has opted out');
    this.name = 'OptedOutError';
  }
}

/**
 * Thrown when a business-initiated send is attempted without WhatsApp consent.
 *
 * A hard error rather than a silent skip. Reaching this point means a proactive
 * path tried to message someone who never agreed to be messaged — up to ₪1,000
 * per message under Israeli Amendment 40, plus Meta opt-in policy exposure. It
 * must surface loudly, not be swallowed.
 */
export class ConsentRequiredError extends Error {
  constructor(readonly consentStatus: Contact['consentStatus']) {
    super(
      `refused a business-initiated send: consent is "${consentStatus}", ` +
        'and only "whatsapp_opt_in" may be contacted proactively',
    );
    this.name = 'ConsentRequiredError';
  }
}

/**
 * Thrown when free-form text is attempted outside the messaging window.
 *
 * Meta would reject the send. Failing here instead makes the cause obvious and
 * forces the caller to the approved-template path rather than discovering it as
 * an opaque Graph API error.
 */
export class WindowClosedError extends Error {
  constructor() {
    super(
      'refused a free-form send outside the 24-hour messaging window; ' +
        'an approved template is required',
    );
    this.name = 'WindowClosedError';
  }
}

/** Thrown when the contact supplied does not match the number being messaged. */
export class RecipientMismatchError extends Error {
  constructor() {
    super('refused a send whose contact record does not match the recipient number');
    this.name = 'RecipientMismatchError';
  }
}

/** The window-bearing part of a conversation. */
type WindowState = Pick<Conversation, 'windowExpiresAt'>;

/**
 * What is being sent, and the evidence needed to authorise it.
 *
 * A discriminated union rather than optional fields, so the compiler rejects a
 * proactive send with no contact to check.
 */
export type SendRequest =
  | {
      /** Answering someone who messaged us. Consent is not at issue — they started it. */
      kind: 'reply';
      to: string;
      /** The conversation being replied to; its window decides free-form vs template. */
      conversation: WindowState;
      /** True when sending an approved template rather than free-form text. */
      isTemplate?: boolean;
    }
  | {
      /** Business-initiated. Requires consent, and a template unless a window is open. */
      kind: 'proactive';
      to: string;
      /** Checked against {@link canReceiveProactiveMessage}. */
      contact: Contact;
      isTemplate: boolean;
      /** Usually absent: a proactive send happens precisely when no window is open. */
      conversation?: WindowState | undefined;
    };

/**
 * Authorises a send, then performs it.
 *
 * Generic over the send itself: the caller supplies a thunk performing the actual
 * channel call (text, video, buttons, list, or template), and this decides
 * whether that thunk may run at all. One place enforces the rules regardless of
 * message shape.
 *
 * @throws {OptedOutError} the recipient asked us to stop.
 * @throws {ConsentRequiredError} proactive send without `whatsapp_opt_in`.
 * @throws {WindowClosedError} free-form send with no open window.
 * @throws {RecipientMismatchError} the contact does not match the recipient.
 */
export async function guardedSend(
  db: Database,
  request: SendRequest,
  send: () => Promise<OutboundResult>,
): Promise<OutboundResult> {
  // Consulted from the durable `opt_outs` record rather than a cached flag, and
  // checked first: an opt-out overrides every other consideration.
  if (await isOptedOut(db, request.to)) {
    throw new OptedOutError(request.to);
  }

  if (request.kind === 'proactive') {
    // Guard against authorising the send by checking a *different* person's
    // consent — a mix-up that would be invisible in the logs.
    if (request.contact.phone !== request.to) {
      throw new RecipientMismatchError();
    }
    if (!canReceiveProactiveMessage(request.contact)) {
      throw new ConsentRequiredError(request.contact.consentStatus);
    }
  }

  // An approved template is the one thing Meta accepts outside the window, so it
  // skips this check; everything else needs an open window.
  if (request.isTemplate !== true) {
    const open = request.conversation
      ? canSendFreeForm(sendWindow(request.conversation))
      : false;
    if (!open) throw new WindowClosedError();
  }

  return send();
}
