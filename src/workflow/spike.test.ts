import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testDatabaseUrl } from '../db/testing.js';
import { createCheckpointer } from './checkpointer.js';
import { createSpikeWorkflow, spikeSideEffects } from './spike.js';

/**
 * Integration test for the LangGraph de-risking spike.
 *
 * Runs against the real PostgreSQL started by `npm run db:up`. The point of the
 * spike is to prove behaviour that lives in LangGraph + Postgres, not in our
 * code, so a mock would verify nothing.
 *
 * The checkpointer's `langgraph` schema is created by `setup()`; unlike the
 * business tables it is never truncated between runs, so every test uses a fresh
 * random `thread_id` to stay isolated from leftover checkpoints.
 */

const url = testDatabaseUrl();

let saver: PostgresSaver;

beforeAll(async () => {
  saver = createCheckpointer(url);
  await saver.setup();
});

afterAll(async () => {
  await saver.end();
});

test('a task before an interrupt is not re-executed when the thread resumes', async () => {
  const app = createSpikeWorkflow(saver);
  const config = { configurable: { thread_id: randomUUID() } };

  spikeSideEffects.length = 0;

  // First run parks at the interrupt after running `prepare` once.
  await app.invoke('hello', config);
  expect(spikeSideEffects).toEqual(['hello']);

  // Resuming returns the final value and — crucially — does not run `prepare`
  // again. Its result is restored from the checkpoint.
  const result = await app.invoke(new Command({ resume: { approved: true } }), config);

  expect(result).toEqual({ prepared: 'HELLO', approved: true });
  expect(spikeSideEffects).toEqual(['hello']);
});

test('a parked thread resumes on a fresh saver instance (survives a restart)', async () => {
  const config = { configurable: { thread_id: randomUUID() } };

  spikeSideEffects.length = 0;

  // Park the thread using the shared saver.
  const app1 = createSpikeWorkflow(saver);
  await app1.invoke('restart', config);
  expect(spikeSideEffects).toEqual(['restart']);

  // A brand-new saver with its own pool stands in for a process restart: the
  // only way it can resume this thread is by reading the checkpoint from
  // Postgres.
  const saver2 = createCheckpointer(url);
  try {
    const app2 = createSpikeWorkflow(saver2);
    const result = await app2.invoke(
      new Command({ resume: { approved: false } }),
      config,
    );

    expect(result).toEqual({ prepared: 'RESTART', approved: false });
    // The pre-interrupt task still ran exactly once, on the original instance.
    expect(spikeSideEffects).toEqual(['restart']);
  } finally {
    await saver2.end();
  }
});
