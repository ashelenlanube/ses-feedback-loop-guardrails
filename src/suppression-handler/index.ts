import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { SesEvent, SuppressionRecord, toSuppressionRecords } from './rules';

// Injected by CDK from `table.tableName`. Never typed by hand per environment.
const TABLE_NAME = process.env.TABLE_NAME;
if (!TABLE_NAME) {
  throw new Error('TABLE_NAME is not set');
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const message of event.Records) {
    try {
      // SNS -> SQS uses raw message delivery, so the body is the SES event itself.
      const sesEvent = JSON.parse(message.body) as SesEvent;
      const records = toSuppressionRecords(sesEvent);

      for (const record of records) {
        await saveRecord(record);
      }

      console.log(JSON.stringify({ messageId: message.messageId, suppressed: records.length }));
    } catch (error) {
      // Only this message goes back to the queue. After maxReceiveCount it lands in the DLQ,
      // and the DLQ alarm makes sure somebody finds out.
      console.error(JSON.stringify({ messageId: message.messageId, error: String(error) }));
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }

  return { batchItemFailures };
}

async function saveRecord(record: SuppressionRecord): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: record,
        // Never downgrade a permanent entry (no expiresAt) to a temporary one.
        ConditionExpression: 'attribute_not_exists(email) OR attribute_exists(expiresAt)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return; // already suppressed forever
    throw error;
  }
}
