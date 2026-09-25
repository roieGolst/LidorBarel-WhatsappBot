import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';

/**
 * The privacy policy, rendered from `public/privacy.html` with the numbers the
 * system actually runs on: the follow-up caps, the retention period, and the
 * contact e-mail when one is configured. A promise printed on the page and a
 * value in the code cannot then drift apart — the page reads the code.
 */

const TEMPLATE = readFileSync(
  new URL('../../public/privacy.html', import.meta.url),
  'utf8',
);

export type PrivacyPageConfig = Pick<
  Config,
  'followUpMaxCount' | 'followUpMaxDays' | 'dataRetentionMonths' | 'privacyContactEmail'
>;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderPrivacyPage(config: PrivacyPageConfig): string {
  const email = config.privacyContactEmail
    ? escapeHtml(config.privacyContactEmail)
    : undefined;
  const values: Record<string, string> = {
    followUpMaxCount: String(config.followUpMaxCount),
    followUpMaxDays: String(config.followUpMaxDays),
    retentionMonths: String(config.dataRetentionMonths),
    contactEmailHe: email
      ? ` או בדוא״ל לכתובת <a href="mailto:${email}">${email}</a>`
      : '',
    contactEmailEn: email ? ` or e-mail <a href="mailto:${email}">${email}</a>` : '',
  };
  const rendered = TEMPLATE.replace(/\{\{(\w+)\}\}/g, (token, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`privacy page: unknown token ${token}`);
    return value;
  });
  if (rendered.includes('{{')) throw new Error('privacy page: unrendered token');
  return rendered;
}
