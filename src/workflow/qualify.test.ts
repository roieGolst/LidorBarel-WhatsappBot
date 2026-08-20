import { describe, expect, it } from 'vitest';
import type { LeadQuality, StoredFacts } from './classify.js';
import { assessQualification, QUALIFY_THRESHOLD } from './qualify.js';

const completeFacts: StoredFacts = { neighborhood: 'רמות', currentlyMarketed: 'no' };

function quality(overrides: Partial<LeadQuality> = {}): LeadQuality {
  return { seriousness: 0.9, genuineIntent: true, spam: false, reason: '', ...overrides };
}

describe('assessQualification', () => {
  it('qualifies a serious, complete, genuine lead', () => {
    const result = assessQualification({
      facts: completeFacts,
      quality: quality(),
      screenAll: false,
      irrelevantResponseCount: 0,
      invalidAnswerCount: 0,
    });
    expect(result.status).toBe('qualified');
    expect(result.score).toBeGreaterThanOrEqual(QUALIFY_THRESHOLD);
  });

  it('disqualifies spam regardless of the answers', () => {
    const result = assessQualification({
      facts: completeFacts,
      quality: quality({ spam: true, seriousness: 0.9 }),
      screenAll: false,
      irrelevantResponseCount: 0,
      invalidAnswerCount: 0,
    });
    expect(result.status).toBe('disqualified');
  });

  it('holds a low-seriousness lead for review rather than qualifying', () => {
    const result = assessQualification({
      facts: completeFacts,
      quality: quality({ seriousness: 0.2, genuineIntent: false }),
      screenAll: false,
      irrelevantResponseCount: 0,
      invalidAnswerCount: 0,
    });
    expect(result.status).toBe('needs_review');
  });

  it('does not qualify when required information is missing', () => {
    const result = assessQualification({
      facts: { neighborhood: 'רמות' }, // currentlyMarketed missing
      quality: quality(),
      screenAll: false,
      irrelevantResponseCount: 0,
      invalidAnswerCount: 0,
    });
    expect(result.status).toBe('needs_review');
    expect(result.reasons.join(' ')).toContain('Missing');
  });

  it('penalizes invalid and irrelevant detours', () => {
    const clean = assessQualification({
      facts: completeFacts,
      quality: quality(),
      screenAll: false,
      irrelevantResponseCount: 0,
      invalidAnswerCount: 0,
    });
    const messy = assessQualification({
      facts: completeFacts,
      quality: quality(),
      screenAll: false,
      irrelevantResponseCount: 2,
      invalidAnswerCount: 2,
    });
    expect(messy.score).toBeLessThan(clean.score);
  });
});
