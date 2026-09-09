import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConversationQueue,
  type ConversationJobData,
  type ConversationQueue,
} from './conversationQueue.js';

/**
 * Pins the BullMQ semantics the debounce relies on, against the real Redis the
 * suite already needs. These were verified by experiment before being relied
 * on; if a BullMQ upgrade changes them, this is where it shows.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const redisUrl = (): string => process.env.REDIS_URL ?? 'redis://localhost:6379';
// A private queue name: the suite shares Redis with a developer's running app,
// whose worker would otherwise consume these jobs.
const QUEUE_NAME = `conversation-turns-test-${process.pid}`;

let queue: ConversationQueue | undefined;
let worker: Worker<ConversationJobData> | undefined;

afterEach(async () => {
  await worker?.close();
  await queue?.queue.obliterate({ force: true });
  await queue?.close();
  worker = undefined;
  queue = undefined;
});

/** A worker that records each run and holds the job for `holdMs`. */
async function startWorker(holdMs: number): Promise<{ runs: number[] }> {
  const runs: number[] = [];
  worker = new Worker<ConversationJobData>(
    QUEUE_NAME,
    async () => {
      runs.push(Date.now());
      await sleep(holdMs);
    },
    { connection: new Redis(redisUrl(), { maxRetriesPerRequest: null }), concurrency: 1 },
  );
  await worker.waitUntilReady();
  return { runs };
}

describe('enqueueTurn', () => {
  it('runs one turn for a burst, after the last message', async () => {
    queue = createConversationQueue(redisUrl(), {
      debounceMs: 300,
      queueName: QUEUE_NAME,
    });
    const { runs } = await startWorker(50);

    const started = Date.now();
    await queue.enqueueTurn('conv-1');
    await sleep(150);
    await queue.enqueueTurn('conv-1');
    await sleep(150);
    await queue.enqueueTurn('conv-1');
    const lastAdd = Date.now();
    await sleep(1500);

    expect(runs).toHaveLength(1);
    // Debounced from the LAST message, not the first.
    expect(runs[0]! - lastAdd).toBeGreaterThanOrEqual(250);
    expect(runs[0]! - started).toBeGreaterThanOrEqual(550);
  });

  it('schedules one more turn for a message that arrives while a turn is running', async () => {
    // The case the old fixed-jobId shape dropped on the floor.
    queue = createConversationQueue(redisUrl(), {
      debounceMs: 200,
      queueName: QUEUE_NAME,
    });
    const { runs } = await startWorker(1500);

    await queue.enqueueTurn('conv-2');
    await sleep(900); // delay elapsed; the first turn is now running
    await queue.enqueueTurn('conv-2');
    await queue.enqueueTurn('conv-2');
    await sleep(3500);

    expect(runs).toHaveLength(2);
    expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(1500);
  });

  it('keeps conversations apart', async () => {
    queue = createConversationQueue(redisUrl(), {
      debounceMs: 100,
      queueName: QUEUE_NAME,
    });
    const { runs } = await startWorker(10);

    await queue.enqueueTurn('conv-a');
    await queue.enqueueTurn('conv-b');
    await sleep(1000);

    expect(runs).toHaveLength(2);
  });
});
