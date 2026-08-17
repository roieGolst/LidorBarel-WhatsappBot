import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { getLogger } from '../logger.js';
import {
  createConversationWorkflow,
  type ConversationDeps,
  type TurnResult,
} from '../workflow/conversationTurn.js';
import {
  CONVERSATION_QUEUE_NAME,
  type ConversationJobData,
} from './conversationQueue.js';

/**
 * The BullMQ worker that drains the conversation-turn queue.
 *
 * The BullMQ machinery is deliberately kept to the thin shell at the bottom of
 * this file. The actual per-job work is {@link processTurn} — a plain function
 * with no queue types in its signature — so it can be unit-tested by calling it
 * directly with the fakes and a real Postgres, exactly like
 * `workflow/conversationTurn.test.ts`, without standing up Redis or BullMQ.
 */

/**
 * Runs one conversation turn.
 *
 * A new workflow is built per call rather than cached: `createConversationWorkflow`
 * only wires tasks around the injected deps, so it is cheap, and building fresh
 * keeps the function free of hidden state. `thread_id` is the conversation id, so
 * every turn of a conversation shares one durable, checkpointed execution thread
 * — that is what guarantees a retry resumes rather than re-sending.
 */
export async function processTurn(
  deps: ConversationDeps,
  checkpointer: BaseCheckpointSaver,
  conversationId: string,
): Promise<TurnResult> {
  const workflow = createConversationWorkflow(deps, checkpointer);
  return workflow.invoke(conversationId, {
    configurable: { thread_id: conversationId },
  });
}

/** A running worker plus a clean way to stop it and release its connection. */
export interface ConversationWorker {
  readonly worker: Worker<ConversationJobData>;
  /**
   * Stops accepting new jobs and waits for the in-flight turn to finish before
   * releasing the Redis connection. Called on graceful shutdown.
   */
  close(): Promise<void>;
}

/**
 * Starts the conversation worker.
 *
 * `concurrency: 1` keeps this process handling one turn at a time. Interleaving
 * of a *single* conversation is already prevented by the producer's job-id
 * coalescing (see `conversationQueue.ts`); serial processing here is a
 * deliberately conservative throughput choice for a single-agent inbound volume,
 * not a correctness requirement, and can be raised later without weakening the
 * no-interleave guarantee.
 *
 * The worker owns its own Redis connection because it blocks on it waiting for
 * jobs; sharing the producer's connection would let those blocking reads stall
 * enqueues.
 */
export function createConversationWorker(
  redisUrl: string,
  deps: ConversationDeps,
  checkpointer: BaseCheckpointSaver,
): ConversationWorker {
  const logger = getLogger();
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<ConversationJobData>(
    CONVERSATION_QUEUE_NAME,
    async (job: Job<ConversationJobData>) => {
      const { conversationId } = job.data;
      logger.info({ conversationId }, 'processing conversation turn');
      // Success is otherwise silent — with no log a working turn looks identical
      // to nothing happening. The conversation id, stage, action, and whether a
      // message was sent are safe to log; the transcript never is.
      const result = await processTurn(deps, checkpointer, conversationId);
      logger.info(
        {
          conversationId,
          stage: result.stage,
          action: result.action,
          sent: result.sent,
        },
        'conversation turn processed',
      );
    },
    { connection, concurrency: 1 },
  );

  // A failed turn must be visible: the customer is waiting on a reply. The
  // conversation id is safe to log; the transcript is not and never reaches
  // here.
  worker.on('failed', (job: Job<ConversationJobData> | undefined, err: Error) => {
    logger.error(
      { conversationId: job?.data.conversationId, attempts: job?.attemptsMade, err },
      'conversation turn failed',
    );
  });

  return {
    worker,
    async close(): Promise<void> {
      await worker.close();
      await connection.quit();
    },
  };
}
