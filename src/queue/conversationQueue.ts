import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * The conversation-turn queue.
 *
 * A webhook must return in milliseconds, but generating a reply means an LLM
 * round trip and a send — far too slow to do inline (see `whatsapp/routes.ts`).
 * So the webhook only persists the message and drops a job here; a worker
 * (`conversationWorker.ts`) drains the queue and runs the conversation workflow.
 *
 * Redis is a transport, never authoritative state: a job carries only the
 * `conversationId`, and the worker reloads everything it needs from Postgres
 * (the source of truth). A lost job costs a reply, not data.
 */

/** BullMQ queue name. Shared by the producer here and the worker. */
export const CONVERSATION_QUEUE_NAME = 'conversation-turns';

/** The only thing a job needs: which conversation to advance. */
export interface ConversationJobData {
  conversationId: string;
}

/**
 * The producer seam the webhook depends on.
 *
 * An interface rather than the concrete `Queue` so the route can be tested with
 * a trivial fake — asserting a non-duplicate inbound enqueues exactly once —
 * without a live Redis.
 */
export interface TurnProducer {
  enqueueTurn(conversationId: string): Promise<void>;
}

/** A producer plus the resources it owns, for graceful shutdown. */
export interface ConversationQueue extends TurnProducer {
  readonly queue: Queue<ConversationJobData>;
  /** Closes the queue and its Redis connection. */
  close(): Promise<void>;
}

/**
 * Builds an ioredis connection configured the way BullMQ requires.
 *
 * `maxRetriesPerRequest: null` is mandatory for a connection BullMQ blocks on:
 * the worker parks on a blocking command waiting for the next job, and ioredis'
 * default retry limit would abort that wait. The queue and the worker each own a
 * separate connection so the worker's blocking reads never stall the producer.
 */
function createConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

/**
 * Builds the conversation-turn producer.
 *
 * ## Concurrency (plan §13): no interleaved turns for one conversation
 *
 * The job id is set to the `conversationId`. BullMQ ignores an `add` whose job
 * id already exists, so while a conversation's turn is still queued or running,
 * a second inbound for that same conversation does not create a second job —
 * the two are coalesced. Combined with the worker loading the *full* recent
 * transcript and replying to the latest inbound, rapid-fire messages collapse
 * into one consolidated reply rather than two interleaved turns racing on the
 * same LangGraph `thread_id`.
 *
 * `removeOnComplete: true` is what makes coalescing self-clearing: once a turn
 * finishes, its job is removed and the id frees up, so the conversation's *next*
 * inbound enqueues normally.
 *
 * ### Honest limitation
 *
 * The coalescing window is "job exists", which includes the *active* state. If a
 * new inbound arrives in the brief window after a turn starts running but before
 * it completes, that inbound is coalesced away and gets no turn of its own. The
 * customer's message is still durably stored (it was persisted by ingestion);
 * it simply will not, on its own, trigger a reply. At this product's volume
 * (one agent's inbound leads) that window is small and the failure mode is a
 * missed follow-up, not lost data. A per-conversation "re-check for newer
 * inbound after finishing" sweep would close it and is deliberately left out to
 * avoid over-engineering.
 */
export function createConversationQueue(redisUrl: string): ConversationQueue {
  const connection = createConnection(redisUrl);
  const queue = new Queue<ConversationJobData>(CONVERSATION_QUEUE_NAME, { connection });

  return {
    queue,

    async enqueueTurn(conversationId: string): Promise<void> {
      await queue.add(
        'turn',
        { conversationId },
        {
          // Coalesce concurrent turns for one conversation (see doc comment).
          jobId: conversationId,
          // Free the job id when the turn finishes — on success OR once its
          // retries are exhausted — so the conversation's next inbound can
          // always enqueue a fresh turn. A *retained* failed job would keep the
          // id occupied and, through the dedup above, silently swallow every
          // later message for that conversation: a transient blip (an expired
          // token, a momentary outage) would permanently mute the lead. The
          // failure is still captured by the worker's `failed` handler
          // (conversationWorker.ts), so nothing is lost by not retaining it.
          removeOnComplete: true,
          removeOnFail: true,
          // A turn is checkpointed durable execution: a retry resumes from the
          // last checkpoint rather than re-sending, so bounded retries are safe
          // for a transient LLM/Meta/Redis blip.
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );
    },

    async close(): Promise<void> {
      await queue.close();
      await connection.quit();
    },
  };
}
