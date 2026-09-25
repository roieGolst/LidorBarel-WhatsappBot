import { describe, expect, it } from 'vitest';
import { renderPrivacyPage } from './privacyPage.js';

/** The formatter wraps lines freely; the promises are read as running text. */
const text = (html: string): string => html.replace(/\s+/g, ' ');

const base = {
  followUpMaxCount: 5,
  followUpMaxDays: 5,
  dataRetentionMonths: 24,
  privacyContactEmail: undefined,
};

describe('renderPrivacyPage — the page reads the code', () => {
  it('prints the business details and the caps the code enforces, with no token left', () => {
    const html = text(renderPrivacyPage(base));
    expect(html).toContain('בראל לידור');
    expect(html).toContain('211343660');
    expect(html).toContain('שרה לוי-תנאי 21');
    expect(html).toContain('עד 5 הודעות');
    expect(html).toContain('24 חודשים');
    expect(html).toContain('up to 5 reminders over at most 5');
    expect(html).not.toContain('{{');
    expect(html).not.toContain('placeholder">[');
  });

  it('follows the configuration rather than a fixed text', () => {
    const html = text(
      renderPrivacyPage({ ...base, followUpMaxCount: 3, dataRetentionMonths: 12 }),
    );
    expect(html).toContain('עד 3 הודעות');
    expect(html).toContain('12 חודשים');
  });

  it('offers e-mail only when one is configured, escaped', () => {
    expect(renderPrivacyPage(base)).not.toContain('mailto:');
    const withEmail = renderPrivacyPage({
      ...base,
      privacyContactEmail: 'privacy@example.com',
    });
    expect(withEmail).toContain('mailto:privacy@example.com');
    expect(withEmail).toContain('או בדוא״ל');
  });
});
