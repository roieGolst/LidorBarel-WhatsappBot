import { randomUUID } from 'node:crypto';
import { Command, entrypoint, interrupt, task } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testDatabaseUrl } from '../db/testing.js';
import { createCheckpointer } from './checkpointer.js';

/**
 * Crash-resume guarantees for the Postgres-backed checkpointer the conversation
 * workflow runs on (§5.2 / §13). These prove, against a real Postgres on Node 24,
 * the three execution properties every checkpointed turn depends on:
 *
 *  1. A `task` before an `interrupt` is not re-executed when the thread resumes —
 *     the guarantee that a resumed turn does not re-bill an LLM call or re-send a
 *     WhatsApp message.
 *  2. `interrupt()` parks the thread durably and it resumes via `Command` — the
 *     mechanism M6's appointment approval uses.
 *  3. A parked thread resumes on a *fresh* saver instance, proving the state lives
 *     in Postgres, not memory — i.e. it survives a process restart.
 *
 * These live here rather than in a workflow test because the conversation
 * workflow has no `interrupt()` of its own until M6; the property being verified
 * belongs to the checkpointer, which every turn is built on.
 */

const url = testDatabaseUrl();

/** Records each execution so a test can prove a step ran exactly once. */
const executions: string[] = [];

const prepare = task('checkpointerProbePrepare', (token: string): string => {
  executions.push(token);
  return token.toUpperCase();
});

interface ApprovalRequest {
  kind: 'approval';
  prepared: string;
}
interface Approval {
  approved: boolean;
}

function buildProbe(checkpointer: PostgresSaver) {
  return entrypoint(
    { name: 'checkpointerProbe', checkpointer },
    async (token: string): Promise<{ prepared: string; approved: boolean }> => {
      const prepared = await prepare(token);
      const decision = interrupt<ApprovalRequest, Approval>({
        kind: 'approval',
        prepared,
      });
      return { prepared, approved: decision.approved };
    },
  );
}

let saver: PostgresSaver;

beforeAll(async () => {
  saver = createCheckpointer(url);
  await saver.setup();
});

afterAll(async () => {
  await saver.end();
});

test('a task before an interrupt is not re-executed when the thread resumes', async () => {
  const probe = buildProbe(saver);
  const config = { configurable: { thread_id: randomUUID() } };

  executions.length = 0;

  // First run parks at the interrupt, having run `prepare` exactly once.
  await probe.invoke('hello', config);
  expect(executions).toEqual(['hello']);

  // Resuming returns the final value and does not run `prepare` again — its
  // result is restored from the checkpoint.
  const result = await probe.invoke(new Command({ resume: { approved: true } }), config);

  expect(result).toEqual({ prepared: 'HELLO', approved: true });
  expect(executions).toEqual(['hello']);
});

test('a parked thread resumes on a fresh saver instance (survives a restart)', async () => {
  const config = { configurable: { thread_id: randomUUID() } };

  executions.length = 0;

  await buildProbe(saver).invoke('restart', config);
  expect(executions).toEqual(['restart']);

  // A brand-new saver with its own pool stands in for a process restart: the
  // only way it can resume this thread is by reading the checkpoint from Postgres.
  const fresh = createCheckpointer(url);
  try {
    const result = await buildProbe(fresh).invoke(
      new Command({ resume: { approved: false } }),
      config,
    );

    expect(result).toEqual({ prepared: 'RESTART', approved: false });
    expect(executions).toEqual(['restart']); // still ran exactly once
  } finally {
    await fresh.end();
  }
});
