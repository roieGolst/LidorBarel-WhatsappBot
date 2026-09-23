import { getConfig } from '../config.js';
import { getLogger } from '../logger.js';

/**
 * Minimal Monday.com GraphQL client.
 *
 * Narrow on purpose: this projects leads and appointments onto two boards, and
 * that is all it will ever do. A general Monday SDK would carry a great deal of
 * surface nobody here calls, and every extra mutation is another way to write to
 * a board the bot has no business touching.
 */

/**
 * One item's column values, as both rendered text and raw JSON.
 *
 * Both are kept because they differ in ways that matter: for a date column,
 * `text` is rendered in the **account's** timezone while `value` holds UTC.
 * Reading `text` and parsing it on a UTC server shifts every date by the offset
 * — three hours, for this account — which for a calendar means booking over
 * existing meetings. Anything time-sensitive must read `value`.
 */
export interface MondayItem {
  id: string;
  columnValues: Record<string, { text: string | null; value: string | null }>;
}

/** Monday rejects a query it dislikes with HTTP 200 and an `errors` array. */
export class MondayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MondayError';
  }
}

export interface MondayCredentials {
  apiToken: string;
  /** Pinned so Monday cannot change the schema under us. */
  apiVersion: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class MondayClient {
  private readonly logger = getLogger();

  constructor(private readonly credentials: MondayCredentials) {}

  /**
   * Runs one GraphQL request.
   *
   * Failure classification decides whether the outbox retries. Monday returns
   * 200 with an `errors` array for a bad query — which will never succeed on a
   * retry — while rate limits and 5xx are worth another attempt. Getting this
   * backwards either spins forever on a malformed mutation or drops a lead's
   * projection on a transient blip.
   */
  private async request<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
          // A bearer secret: header only, never a log line or an error message.
          Authorization: this.credentials.apiToken,
          'Content-Type': 'application/json',
          'API-Version': this.credentials.apiVersion,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MondayError(
        `request failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        true,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      this.logger.warn(
        { status: response.status, retryable },
        'Monday API request failed',
      );
      throw new MondayError(
        `Monday API returned ${response.status} ${response.statusText}`,
        retryable,
        response.status,
      );
    }

    const body = (await response.json().catch(() => undefined)) as
      { data?: T; errors?: { message?: string }[]; error_code?: string } | undefined;

    if (!body) throw new MondayError('Monday API returned an unreadable body', false);

    if (body.errors?.length) {
      const detail = body.errors.map((e) => e.message ?? 'unknown').join('; ');
      // Complexity budget exhaustion is the one 200-with-errors worth retrying:
      // it is a rate limit wearing a different hat.
      const retryable = /complexity|budget|rate.?limit/i.test(detail);
      throw new MondayError(`Monday API error: ${detail}`, retryable);
    }

    if (!body.data) throw new MondayError('Monday API returned no data', false);
    return body.data;
  }

  /**
   * Creates an item, without setting its status.
   *
   * The board has an automation that sets `סטטוס` on creation. Passing a status
   * here races it, so status is always a separate follow-up call — see
   * `docs/MONDAY-MAPPING.md`.
   */
  async createItem(
    boardId: string,
    itemName: string,
    columnValues: Record<string, unknown>,
  ): Promise<string> {
    const data = await this.request<{ create_item: { id: string } }>(
      `mutation($board:ID!,$name:String!,$vals:JSON!){
         create_item(board_id:$board,item_name:$name,column_values:$vals,create_labels_if_missing:false){ id }
       }`,
      { board: boardId, name: itemName, vals: JSON.stringify(columnValues) },
    );
    return data.create_item.id;
  }

  /** Sets several column values at once. */
  async updateItem(
    boardId: string,
    itemId: string,
    columnValues: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      `mutation($board:ID!,$item:ID!,$vals:JSON!){
         change_multiple_column_values(board_id:$board,item_id:$item,column_values:$vals,create_labels_if_missing:false){ id }
       }`,
      { board: boardId, item: itemId, vals: JSON.stringify(columnValues) },
    );
  }

  /** Moves an item to a group. Used only where no automation covers the status. */
  async moveToGroup(itemId: string, groupId: string): Promise<void> {
    await this.request(
      `mutation($item:ID!,$group:String!){ move_item_to_group(item_id:$item,group_id:$group){ id } }`,
      { item: itemId, group: groupId },
    );
  }

  /**
   * Whether an item is still live on its board.
   *
   * Not merely "returned by id": Monday keeps deleted and archived items
   * queryable, with `state` set accordingly, so `items(ids: …)` answers for a
   * deleted item as readily as for a live one. Checking the array length alone
   * made the "recreate if deleted by hand" path in `syncLead` unreachable — found
   * while verifying a booking live, when two freshly deleted test items still
   * reported present.
   */
  async itemExists(itemId: string): Promise<boolean> {
    const data = await this.request<{ items: { id: string; state?: string }[] }>(
      `query($item:[ID!]){ items(ids:$item){ id state } }`,
      { item: [itemId] },
    );
    return data.items.some((item) => item.state === 'active');
  }

  /**
   * Items on a board with their column values, for reading state back.
   *
   * Pages through the board rather than filtering server-side. Monday's rule
   * syntax for date ranges is awkward and the activity board holds a few hundred
   * items at most, so the range is applied in code. If that board ever grows into
   * the thousands, this is the call to push the filter into.
   */
  async listItems(
    boardId: string,
    columnIds: string[],
    limit = 500,
  ): Promise<MondayItem[]> {
    const data = await this.request<{
      boards: {
        items_page: {
          items: {
            id: string;
            column_values: { id: string; text: string | null; value: string | null }[];
          }[];
        };
      }[];
    }>(
      `query($board:[ID!],$cols:[String!],$limit:Int!){
         boards(ids:$board){
           items_page(limit:$limit){
             items { id column_values(ids:$cols){ id text value } }
           }
         }
       }`,
      { board: [boardId], cols: columnIds, limit },
    );

    const items = data.boards[0]?.items_page.items ?? [];
    return items.map((item) => ({
      id: item.id,
      columnValues: Object.fromEntries(
        item.column_values.map((column) => [
          column.id,
          { text: column.text, value: column.value },
        ]),
      ),
    }));
  }

  /** Deletes an item. Used by tests to clean up after themselves. */
  async deleteItem(itemId: string): Promise<void> {
    await this.request(`mutation($item:ID!){ delete_item(item_id:$item){ id } }`, {
      item: itemId,
    });
  }
}

/**
 * Builds a client from configuration, or `undefined` when no token is set.
 *
 * Absence is supported: the app runs without Monday, and the outbox simply holds
 * events until a token appears. Nothing is lost — that is what the outbox is for.
 */
export function createMondayClient(): MondayClient | undefined {
  const config = getConfig();
  if (!config.mondayApiToken) return undefined;
  return new MondayClient({
    apiToken: config.mondayApiToken,
    apiVersion: config.mondayApiVersion,
  });
}
