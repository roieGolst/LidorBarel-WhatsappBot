import Anthropic from '@anthropic-ai/sdk';

/**
 * The conversation workflow's single dependency on the LLM.
 *
 * An interface rather than a bare SDK call, for one reason that matters: the
 * workflow must be testable and simulatable (§13) against a deterministic,
 * unbilled double. {@link FakeLlmClient} implements this for tests and the
 * simulation harness; {@link AnthropicLlmClient} is the production adapter.
 *
 * The client is deliberately dumb — it sends messages and returns text. It does
 * not know about intents, stages, or the spec. Turning a reply into a decision
 * is the workflow's job; a client that understood conversations would be the
 * wrong seam to fake.
 */
export interface LlmClient {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Models, per the plan's tiering (§7).
 *
 * Haiku handles classification, extraction, and straightforward replies — most
 * turns. The workflow escalates to Sonnet only when confidence is low, an
 * objection is detected, or the validator has already rejected one attempt.
 */
export const CLASSIFIER_MODEL = 'claude-haiku-4-5';
export const ESCALATION_MODEL = 'claude-sonnet-5';

export type LlmModel = typeof CLASSIFIER_MODEL | typeof ESCALATION_MODEL;

/** One turn of conversation as the model sees it. */
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  model: LlmModel;
  /**
   * Stable system content — the spec's voice rules, screening definitions, and
   * banned words. Marked with `cache_control` so it costs roughly a tenth of a
   * fresh read per turn rather than being re-billed every message (§7).
   */
  system: string;
  /** The conversation so far, oldest first, ending with the turn to act on. */
  messages: LlmMessage[];
  maxTokens: number;
}

/**
 * Per-call token accounting, recorded on the `messages` row so cost per
 * conversation is visible from day one and escalation-rate drift shows up
 * immediately rather than in a bill (§7).
 */
export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: LlmUsage;
}

/** Production adapter over the Anthropic Messages API. */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const message = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: [
        { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
      ],
      messages: request.messages,
    });

    // The response is a list of content blocks; only text blocks carry the reply.
    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');

    return {
      text,
      usage: {
        model: message.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
