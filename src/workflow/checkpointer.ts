import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { getConfig } from '../config.js';

/**
 * The conversation workflow's durable execution state lives in LangGraph
 * checkpoints, backed by the same PostgreSQL the rest of the system uses.
 *
 * Two rules from the plan (§5.2) are enforced structurally here:
 *
 *  1. Checkpoints hold workflow-execution state only — never a business fact.
 *     Stage, qualification, and extracted fields are written to the business
 *     tables inside `persistTurn`; nothing outside the workflow reads a
 *     checkpoint to answer a business question.
 *  2. Checkpoints are disposable. A conversation must be rebuildable from
 *     `messages` + `conversations` after the checkpoint tables are dropped.
 *
 * Keeping the checkpoint tables in their own schema makes that boundary visible
 * in the database itself, so a `DROP SCHEMA langgraph CASCADE` is obviously a
 * recoverable operation rather than data loss.
 */
export const LANGGRAPH_SCHEMA = 'langgraph';

/**
 * Builds the Postgres-backed checkpointer.
 *
 * The saver owns its own connection pool, independent of the Drizzle pool in
 * `db/client.ts`: LangGraph uses `pg` and its own serialization, and mixing the
 * two pools would couple their lifecycles for no benefit. Call {@link
 * PostgresSaver.end} to release it.
 *
 * `connectionString` is injectable so integration tests can point at the test
 * database; production reads it from validated config.
 *
 * @remarks
 * {@link PostgresSaver.setup} must be called exactly once before first use — it
 * creates the schema and tables with `IF NOT EXISTS`, so it is safe to call on
 * every boot but callers, not this factory, decide when.
 */
export function createCheckpointer(connectionString?: string): PostgresSaver {
  const url = connectionString ?? getConfig().databaseUrl;
  return PostgresSaver.fromConnString(url, { schema: LANGGRAPH_SCHEMA });
}
