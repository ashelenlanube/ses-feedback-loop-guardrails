/**
 * Pure suppression rules: SES event in, suppression records out.
 * No AWS calls here, so this file is easy to unit test and to read.
 *
 * SES bounce types (event publishing docs):
 *   - Permanent    -> hard bounce. Subtypes: General, NoEmail, Suppressed, OnAccountSuppressionList, ...
 *   - Transient    -> soft bounce SES stopped retrying. Subtypes: General, MailboxFull, MessageTooLarge, ...
 *   - Undetermined -> SES could not tell.
 *
 * Note that "General" exists under BOTH Permanent and Transient,
 * so the rule is decided by bounceType, never by bounceSubType alone.
 */

export const ONE_DAY_IN_SECONDS = 24 * 60 * 60;

export type SuppressionRecord = {
  email: string;
  reason: 'BOUNCE' | 'COMPLAINT';
  bounceType?: string;
  bounceSubType?: string;
  complaintFeedbackType?: string;
  feedbackId: string;
  suppressedAt: string;
  /** Epoch seconds for DynamoDB TTL. Undefined means "suppress forever". */
  expiresAt?: number;
};

type Recipient = { emailAddress: string };

export type SesEvent = {
  /** Present when the event comes from a configuration set (event publishing). */
  eventType?: string;
  /** Present when the event comes from identity feedback notifications. */
  notificationType?: string;
  bounce?: {
    bounceType: string;
    bounceSubType: string;
    bouncedRecipients: Recipient[];
    feedbackId: string;
    timestamp: string;
  };
  complaint?: {
    complainedRecipients: Recipient[];
    complaintFeedbackType?: string;
    feedbackId: string;
    timestamp: string;
  };
};

/** Permanent bounces and complaints never expire. Everything else is suppressed for one day. */
export function expiresAtFor(bounceType: string, nowInSeconds: number): number | undefined {
  if (bounceType === 'Permanent') return undefined;
  return nowInSeconds + ONE_DAY_IN_SECONDS;
}

export function toSuppressionRecords(event: SesEvent, now: Date = new Date()): SuppressionRecord[] {
  const type = event.eventType ?? event.notificationType;
  const nowInSeconds = Math.floor(now.getTime() / 1000);
  const suppressedAt = now.toISOString();

  if (type === 'Bounce' && event.bounce) {
    const { bounceType, bounceSubType, bouncedRecipients, feedbackId } = event.bounce;
    return bouncedRecipients.map((recipient) => ({
      email: normalize(recipient.emailAddress),
      reason: 'BOUNCE',
      bounceType,
      bounceSubType,
      feedbackId,
      suppressedAt,
      expiresAt: expiresAtFor(bounceType, nowInSeconds),
    }));
  }

  if (type === 'Complaint' && event.complaint) {
    const { complainedRecipients, complaintFeedbackType, feedbackId } = event.complaint;
    return complainedRecipients.map((recipient) => ({
      email: normalize(recipient.emailAddress),
      reason: 'COMPLAINT',
      complaintFeedbackType,
      feedbackId,
      suppressedAt,
      expiresAt: undefined,
    }));
  }

  // Delivery, Send, Open... are not relevant for suppression.
  return [];
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}
