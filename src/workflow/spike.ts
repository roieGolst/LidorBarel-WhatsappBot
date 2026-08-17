import { entrypoint, interrupt, task } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

/**
 * LangGraph de-risking spike — build-order step 4.
 *
 * This is **not** the conversation workflow. It exists only to prove, on Node 24
 * against a Postgres-backed checkpointer, the three execution guarantees the
 * real M3 workflow will be built on. LangGraph's JS API has churned across
 * versions, so the plan calls for verifying these before committing to the full
 * `conversationTurn` entrypoint:
 *
 *  1. **No re-execution.** A `task()` before an `interrupt()` is checkpointed,
 *     so resuming the thread does not run it again — the guarantee that stops a
 *     crash-resume from double-sending a WhatsApp message or re-billing an LLM
 *     call.
 *  2. **Durable park/resume.** `interrupt()` pauses the thread and it resumes via
 *     `Command({ resume })` — the mechanism M6's appointment approval uses.
 *  3. **Survives a restart.** Because the checkpoint is in Postgres, a fresh
 *     saver instance (a new process) can resume a thread parked by another.
 *
 * When the real entrypoint lands, these properties are covered by tests over
 * real conversations and this harness can be removed.
 */

/**
 * Observable side effects of the pre-interrupt task.
 *
 * The test asserts on this to prove the task runs exactly once per thread even
 * though the entrypoint body is replayed on resume. Module-level rather than
 * injected because a checkpointed `task` must be a stable top-level reference.
 */
export const spikeSideEffects: string[] = [];

const prepare = task('spikePrepare', (token: string): string => {
  // Stands in for an expensive, non-idempotent step — an LLM generation, or an
  // outbound send. If checkpointing holds, this executes once; on resume its
  // result is restored from the checkpoint rather than recomputed. `task` wraps
  // the return in a Promise, so it need not be async itself.
  spikeSideEffects.push(token);
  return token.toUpperCase();
});

/** Payload surfaced to the operator while the thread is parked. */
export interface SpikeApprovalRequest {
  kind: 'spike_approval';
  prepared: string;
}

/** The operator's decision, delivered when the parked thread is resumed. */
export interface SpikeApproval {
  approved: boolean;
}

export interface SpikeResult {
  prepared: string;
  approved: boolean;
}

/**
 * Builds the spike entrypoint bound to a checkpointer.
 *
 * Mirrors the real workflow's shape: a checkpointed step, a human-in-the-loop
 * interrupt, then a step that consumes the resumed decision.
 */
export function createSpikeWorkflow(checkpointer: BaseCheckpointSaver) {
  return entrypoint(
    { name: 'spikeApproval', checkpointer },
    async (token: string): Promise<SpikeResult> => {
      const prepared = await prepare(token);

      // Execution stops here and the thread is checkpointed. It resumes at this
      // line when invoked again with `Command({ resume })`, with `decision` set
      // to the resumed value.
      const decision = interrupt<SpikeApprovalRequest, SpikeApproval>({
        kind: 'spike_approval',
        prepared,
      });

      return { prepared, approved: decision.approved };
    },
  );
}
