import { and, asc, eq, lt, notExists, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { contacts, conversations } from '../db/schema.js';
import { getLogger } from '../logger.js';
import { eraseContact } from './erase.js';

/**
 * The retention purge (NN-9): a lead silent for longer than the configured
 * period is erased from the bot's own store — contact, conversations, messages,
 * checkpoints. Runs once shortly after start and then daily; the CRM record is
 * untouched (it is Lidor's business record and goes only on request).
 *
 * "Silent" means no activity on any of the person's conversations: nothing
 * received, nothing sent, nothing changed. A lead with a meeting in the diary
 * has by definition been active more recently than two years ago.
 */

export interface RetentionSweeperOptions {
  db: Database;
  /** How long after the last contact a lead is kept. */
  retentionMs: number;
  /** How often to look. */
  intervalMs: number;
  /** How long after start the first pass runs. */
  initialDelayMs?: number;
  /** Most people erased per pass. */
  batchSize?: number;
  /** Deletes each erased conversation's checkpoint thread. */
  checkpointer?: { deleteThread(threadId: string): Promise<void> } | undefined;
}

export interface RetentionSweeper {
  runOnce(now?: Date): Promise<{ erased: number }>;
  stop(): void;
}

/** The people whose every conversation has been silent since `cutoff`. */
export async function findStaleContacts(
  db: Database,
  cutoff: Date,
  limit: number,
): Promise<{ id: string; phone: string }[]> {
  const lastActivity = sql`greatest(
    ${conversations.createdAt},
    ${conversations.updatedAt},
    coalesce(${conversations.lastInboundAt}, ${conversations.createdAt}),
    coalesce(${conversations.lastOutboundAt}, ${conversations.createdAt})
  )`;
  return db
    .select({ id: contacts.id, phone: contacts.phone })
    .from(contacts)
    .where(
      and(
        lt(contacts.updatedAt, cutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(conversations)
            .where(
              and(
                eq(conversations.contactId, contacts.id),
                // A raw expression has no column to type the parameter: pass text, cast.
                sql`${lastActivity} >= ${cutoff.toISOString()}::timestamptz`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(contacts.updatedAt))
    .limit(limit);
}

export function startRetentionSweeper(
  options: RetentionSweeperOptions,
): RetentionSweeper {
  const logger = getLogger();
  const batchSize = options.batchSize ?? 100;
  let running = false;
  let stopped = false;

  async function runOnce(now: Date = new Date()): Promise<{ erased: number }> {
    if (running) return { erased: 0 };
    running = true;
    let erased = 0;
    try {
      const cutoff = new Date(now.getTime() - options.retentionMs);
      const stale = await findStaleContacts(options.db, cutoff, batchSize);
      for (const contact of stale) {
        const report = await eraseContact(
          { db: options.db },
          { contactId: contact.id, phone: contact.phone },
          'retention',
        );
        for (const conversationId of report.conversationIds) {
          await options.checkpointer?.deleteThread(conversationId);
        }
        erased += 1;
      }
      if (erased > 0) logger.info({ erased }, 'retention purge');
    } catch (error) {
      logger.error({ error }, 'retention purge failed');
    } finally {
      running = false;
    }
    return { erased };
  }

  const first = setTimeout(() => {
    void runOnce();
  }, options.initialDelayMs ?? 60_000);
  const timer = setInterval(() => {
    if (!stopped) void runOnce();
  }, options.intervalMs);
  first.unref();
  timer.unref();

  return {
    runOnce,
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
