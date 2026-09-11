import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * The producer side of the conversation-turn queue.
 *
 * The webhook enqueues a turn per inbound message; the worker
 * (conversationWorker.ts) runs it. Redis carries only *that a turn is due* —
 * every fact the turn needs is re-read from Postgres, so a lost or duplicated
 * job can never lose or duplicate a customer's message.
 *
 * ### One turn per burst, and never a dropped message
 *
 * People type in bursts. A turn is therefore **delayed** by
 * {@link INBOUND_DEBOUNCE_MS} and **deduplicated per conversation**: while it
 * waits, each further message replaces it and restarts the delay, so the turn
 * runs once, after the last line; and a message that arrives while a turn is
 * already *running* schedules exactly one more turn for when it finishes. The
 * turn answers every unanswered message it finds (`loadContext`), so a surplus
 * turn is a no-op.
 *
 * The previous shape — a fixed `jobId` per conversation — silently discarded
 * any message that arrived while that conversation's job existed, which is
 * every message a person sends while the bot is composing its reply. In one
 * live conversation "תקבע לי פגישה" was among them. The semantics relied on
 * here were verified against the installed BullMQ; `conversationQueue.test.ts`
 * pins them.
 */

export const CONVERSATION_QUEUE_NAME = 'conversation-turns';

/**
 * How long a turn waits after an inbound message before running, so a person
 * who types several short messages is answered once, for all of them. Three
 * seconds is well under a human reply time and long enough to catch the "ו…"
 * that follows a sentence.
 */
export const INBOUND_DEBOUNCE_MS = 3000;

export interface ConversationJobData {
  conversationId: string;
}

export interface TurnProducer {
  enqueueTurn(conversationId: string): Promise<void>;
}

export interface ConversationQueue extends TurnProducer {
  readonly queue: Queue<ConversationJobData>;
  /** Closes the queue and its Redis connection. */
  close(): Promise<void>;
}

function createConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createConversationQueue(
  redisUrl: string,
  options: { debounceMs?: number; queueName?: string } = {},
): ConversationQueue {
  const connection = createConnection(redisUrl);
  const queue = new Queue<ConversationJobData>(
    options.queueName ?? CONVERSATION_QUEUE_NAME,
    {
      connection,
    },
  );
  const debounceMs = options.debounceMs ?? INBOUND_DEBOUNCE_MS;

  return {
    queue,

    async enqueueTurn(conversationId: string): Promise<void> {
      await queue.add(
        'turn',
        { conversationId },
        {
          delay: debounceMs,
          deduplication: {
            id: conversationId,
            // While delayed: later adds extend the delay and replace the job.
            ttl: debounceMs,
            extend: true,
            replace: true,
            // While active: one more job is queued for afterwards — never none.
            keepLastIfActive: true,
          },
          // Free the job when the turn finishes — on success OR once its
          // retries are exhausted — so a retained failure can never keep a
          // conversation's later messages waiting. The failure is still
          // captured by the worker's `failed` handler.
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
