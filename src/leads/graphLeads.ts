import { z } from 'zod';
import { getConfig } from '../config.js';
import { getLogger } from '../logger.js';

/**
 * Retrieval of a lead's submitted answers from the Meta Graph API.
 *
 * The `leadgen` webhook carries identifiers only — never the answers. They are
 * fetched here with the `leadgen_id`, which requires a **Page** access token with
 * the `leads_retrieval` permission. That is a different credential from the
 * WhatsApp Business Account token used to send messages.
 */

/** One answer as Meta returns it. */
export interface LeadFieldDatum {
  name?: string | undefined;
  values?: string[] | undefined;
}

const leadResponseSchema = z
  .object({
    id: z.string().min(1),
    /** ISO 8601, e.g. `2015-08-20T22:26:24+0000`. */
    created_time: z.string().optional(),
    form_id: z.string().optional(),
    ad_id: z.string().optional(),
    campaign_id: z.string().optional(),
    field_data: z
      .array(
        z
          .object({
            name: z.string().optional(),
            values: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** A lead's answers, plus the raw response kept verbatim for the audit trail. */
export interface RetrievedLead {
  id: string;
  createdTime?: Date;
  formId?: string;
  adId?: string;
  campaignId?: string;
  fieldData: LeadFieldDatum[];
  /** Exactly what Meta returned. Stored on `campaign_referrals.raw_payload`. */
  raw: unknown;
}

/**
 * A failed retrieval, carrying whether retrying could ever help.
 *
 * This distinction decides the webhook's status code, and therefore whether Meta
 * redelivers. A transient failure must return non-2xx so the lead is redelivered;
 * a permanent one (a deleted lead, a token lacking `leads_retrieval`) must return
 * 2xx, because Meta would otherwise redeliver a payload that can never succeed,
 * forever.
 */
export class LeadRetrievalError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LeadRetrievalError';
  }
}

/** Credentials for the Graph API, injected so the client is testable. */
export interface GraphLeadsCredentials {
  /** Page access token with `leads_retrieval`. Never logged. */
  pageAccessToken: string;
  /** Graph API version, e.g. `v21.0`. */
  graphApiVersion: string;
}

/** Fields requested for each lead. */
const LEAD_FIELDS = 'id,created_time,field_data,form_id,ad_id,campaign_id';

/**
 * How long to wait for Meta before giving up.
 *
 * Retrieval happens inside the webhook request (see `ingestLead.ts` for why), so
 * this bounds how long Meta is kept waiting for its own ACK. A timeout is
 * reported as retryable, so the lead comes back on redelivery rather than
 * being lost.
 */
const REQUEST_TIMEOUT_MS = 8_000;

export class GraphLeadsClient {
  private readonly logger = getLogger();

  constructor(private readonly credentials: GraphLeadsCredentials) {}

  private readonly formNames = new Map<string, string | undefined>();

  /**
   * Resolves a form's display name, memoized for the process.
   *
   * A failure returns `undefined` rather than throwing: a missing form name must
   * never stop a lead reaching the CRM.
   */
  async formName(formId: string): Promise<string | undefined> {
    if (this.formNames.has(formId)) return this.formNames.get(formId);

    const { pageAccessToken, graphApiVersion } = this.credentials;
    try {
      const response = await fetch(
        `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(formId)}?fields=name`,
        {
          headers: { Authorization: `Bearer ${pageAccessToken}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        this.formNames.set(formId, undefined);
        return undefined;
      }
      const body = (await response.json()) as { name?: string };
      this.formNames.set(formId, body.name);
      return body.name;
    } catch {
      this.formNames.set(formId, undefined);
      return undefined;
    }
  }

  /**
   * Fetches one lead's answers by its `leadgen_id`.
   *
   * @throws {LeadRetrievalError} with `retryable` set appropriately.
   */
  async fetchLead(leadgenId: string): Promise<RetrievedLead> {
    const { pageAccessToken, graphApiVersion } = this.credentials;
    const url =
      `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(leadgenId)}` +
      `?fields=${LEAD_FIELDS}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          // A bearer secret. It lives only in this header and must never reach a
          // log line, an error message, or a query string.
          Authorization: `Bearer ${pageAccessToken}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure or timeout — always worth another delivery.
      throw new LeadRetrievalError(
        `lead retrieval request failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        true,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable response body>');
      // 429 and 5xx are transient. Every other 4xx means this request will never
      // succeed: a deleted lead, a malformed id, or a token without
      // `leads_retrieval`.
      const retryable = response.status === 429 || response.status >= 500;
      this.logger.warn(
        { status: response.status, retryable, leadgenId },
        'lead retrieval failed',
      );
      throw new LeadRetrievalError(
        `lead retrieval failed: ${response.status} ${response.statusText} — ${detail}`,
        retryable,
        response.status,
      );
    }

    const body: unknown = await response.json().catch(() => undefined);
    const parsed = leadResponseSchema.safeParse(body);
    if (!parsed.success) {
      // A 2xx whose shape we do not understand will not improve on redelivery.
      throw new LeadRetrievalError(
        `lead retrieval returned an unexpected shape: ${parsed.error.message}`,
        false,
      );
    }

    const data = parsed.data;
    const createdTime = data.created_time ? new Date(data.created_time) : undefined;

    return {
      id: data.id,
      ...(createdTime && !Number.isNaN(createdTime.getTime()) ? { createdTime } : {}),
      ...(data.form_id ? { formId: data.form_id } : {}),
      ...(data.ad_id ? { adId: data.ad_id } : {}),
      ...(data.campaign_id ? { campaignId: data.campaign_id } : {}),
      fieldData: data.field_data ?? [],
      raw: body,
    };
  }
}

/**
 * The display name of a lead form, cached for the process.
 *
 * Monday shows Lidor which form a lead came from, and an id tells him nothing.
 * Form names change rarely and the account has a handful of forms, so one
 * lookup per form per process is cheaper than storing the name on every lead —
 * and a failed lookup degrades to no name rather than blocking the projection.
 */
export async function fetchFormName(
  client: GraphLeadsClient,
  formId: string,
): Promise<string | undefined> {
  return client.formName(formId);
}

/**
 * Builds a {@link GraphLeadsClient} from validated configuration, or returns
 * `undefined` when the Page token is absent.
 *
 * Absence is a supported state rather than a crash: the app boots for local
 * development and tests without live Meta credentials. The webhook route treats a
 * missing client as "cannot accept leads right now" and fails closed with a 503,
 * so Meta redelivers once the token is configured — rather than ACKing a paid
 * lead we are unable to store.
 */
export function createGraphLeadsClient(): GraphLeadsClient | undefined {
  const config = getConfig();
  if (!config.metaPageAccessToken) return undefined;

  return new GraphLeadsClient({
    pageAccessToken: config.metaPageAccessToken,
    graphApiVersion: config.metaGraphApiVersion,
  });
}
