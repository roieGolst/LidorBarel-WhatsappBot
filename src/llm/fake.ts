import type { CompletionRequest, CompletionResult, LlmClient } from './client.js';

/**
 * Scriptable LLM double for tests and the simulation harness (§13).
 *
 * Returns queued responses in order and records every request it received, so a
 * test can assert both what the workflow did with a reply and what it asked the
 * model. It never touches the network, so the conversation suite is fast and
 * deterministic — the whole point of the {@link LlmClient} seam.
 */
export class FakeLlmClient implements LlmClient {
  /** Every request received, in order — for assertions on prompt construction. */
  readonly requests: CompletionRequest[] = [];
  private readonly responses: string[];

  constructor(responses: string[] = []) {
    this.responses = [...responses];
  }

  /** Queues another response to be returned by a later `complete` call. */
  push(response: string): void {
    this.responses.push(response);
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);

    const text = this.responses.shift();
    if (text === undefined) {
      // A test queued fewer responses than the workflow made calls. Failing
      // loudly beats returning empty text the parser would silently reject.
      return Promise.reject(
        new Error('FakeLlmClient: no queued response for this request'),
      );
    }

    return Promise.resolve({
      text,
      usage: {
        model: request.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      },
    });
  }
}
