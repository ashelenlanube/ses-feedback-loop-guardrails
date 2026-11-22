import { ONE_DAY_IN_SECONDS, SesEvent, toSuppressionRecords } from '../src/suppression-handler/rules';

const now = new Date('2026-01-01T00:00:00.000Z');
const nowInSeconds = Math.floor(now.getTime() / 1000);

function bounce(bounceType: string, bounceSubType: string): SesEvent {
  return {
    eventType: 'Bounce',
    bounce: {
      bounceType,
      bounceSubType,
      bouncedRecipients: [{ emailAddress: ' Bounce@Simulator.AmazonSES.com ' }],
      feedbackId: 'feedback-1',
      timestamp: now.toISOString(),
    },
  };
}

describe('toSuppressionRecords', () => {
  test('permanent bounce is suppressed forever', () => {
    const [record] = toSuppressionRecords(bounce('Permanent', 'General'), now);
    expect(record).toMatchObject({ email: 'bounce@simulator.amazonses.com', reason: 'BOUNCE' });
    expect(record.expiresAt).toBeUndefined();
  });

  test('transient "General" is suppressed for one day (same subtype, different rule)', () => {
    const [record] = toSuppressionRecords(bounce('Transient', 'General'), now);
    expect(record.expiresAt).toBe(nowInSeconds + ONE_DAY_IN_SECONDS);
  });

  test('transient MailboxFull is suppressed for one day', () => {
    const [record] = toSuppressionRecords(bounce('Transient', 'MailboxFull'), now);
    expect(record.expiresAt).toBe(nowInSeconds + ONE_DAY_IN_SECONDS);
  });

  test('undetermined bounce is suppressed for one day', () => {
    const [record] = toSuppressionRecords(bounce('Undetermined', 'Undetermined'), now);
    expect(record.expiresAt).toBe(nowInSeconds + ONE_DAY_IN_SECONDS);
  });

  test('complaint is suppressed forever', () => {
    const records = toSuppressionRecords(
      {
        eventType: 'Complaint',
        complaint: {
          complainedRecipients: [{ emailAddress: 'complaint@simulator.amazonses.com' }],
          complaintFeedbackType: 'abuse',
          feedbackId: 'feedback-2',
          timestamp: now.toISOString(),
        },
      },
      now,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ reason: 'COMPLAINT', complaintFeedbackType: 'abuse' });
    expect(records[0].expiresAt).toBeUndefined();
  });

  test('supports identity notifications (notificationType instead of eventType)', () => {
    const event = bounce('Permanent', 'NoEmail');
    const legacy: SesEvent = { notificationType: 'Bounce', bounce: event.bounce };
    expect(toSuppressionRecords(legacy, now)).toHaveLength(1);
  });

  test('ignores events that are not bounces or complaints', () => {
    expect(toSuppressionRecords({ eventType: 'Delivery' }, now)).toEqual([]);
  });
});
