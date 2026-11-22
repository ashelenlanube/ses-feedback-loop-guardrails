import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface FeedbackLoopStackProps extends StackProps {
  /** Address used as sender. SES sends a verification email to it on deploy. */
  senderEmail: string;
  /** Optional address that receives the CloudWatch alarms. */
  alertEmail?: string;
  /** Alarm when the bounce rate goes above this ratio. AWS reviews the account at 5%. */
  bounceRateThreshold?: number;
  /** Alarm when the complaint rate goes above this ratio. AWS reviews the account at 0.1%. */
  complaintRateThreshold?: number;
}

export class FeedbackLoopStack extends Stack {
  constructor(scope: Construct, id: string, props: FeedbackLoopStackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // 1. SES: sender identity + configuration set with its own suppression
    // ---------------------------------------------------------------------
    new ses.EmailIdentity(this, 'SenderIdentity', {
      identity: ses.Identity.email(props.senderEmail),
    });

    const configurationSet = new ses.ConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName: 'ses-feedback-loop-demo',
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });

    const sesEventsTopic = new sns.Topic(this, 'SesEventsTopic');

    configurationSet.addEventDestination('BouncesAndComplaints', {
      destination: ses.EventDestination.snsTopic(sesEventsTopic),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT],
    });

    // ---------------------------------------------------------------------
    // 2. SNS -> SQS (with DLQ) -> Lambda -> DynamoDB
    // ---------------------------------------------------------------------
    const deadLetterQueue = new sqs.Queue(this, 'SesEventsDlq', {
      retentionPeriod: Duration.days(14),
    });

    const queue = new sqs.Queue(this, 'SesEventsQueue', {
      visibilityTimeout: Duration.seconds(180), // 6x the Lambda timeout
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
    });

    sesEventsTopic.addSubscription(new subs.SqsSubscription(queue, { rawMessageDelivery: true }));

    const table = new dynamodb.TableV2(this, 'SuppressionTable', {
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt', // temporary entries disappear on their own
      removalPolicy: RemovalPolicy.DESTROY, // demo only
    });

    const handler = new NodejsFunction(this, 'SuppressionHandler', {
      entry: path.join(__dirname, '../src/suppression-handler/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(30),
      environment: {
        // The lesson of the incident: the table name comes from the resource itself,
        // so every environment points to the table that actually exists.
        TABLE_NAME: table.tableName,
      },
      logGroup: new logs.LogGroup(this, 'SuppressionHandlerLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    table.grantWriteData(handler);
    handler.addEventSource(new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }));

    // ---------------------------------------------------------------------
    // 3. Alarms: find out before AWS does
    // ---------------------------------------------------------------------
    const alertsTopic = new sns.Topic(this, 'AlertsTopic');
    if (props.alertEmail) {
      alertsTopic.addSubscription(new subs.EmailSubscription(props.alertEmail));
    }
    const notify = new cwActions.SnsAction(alertsTopic);

    const alarms = [
      // Having a DLQ is not enough: somebody has to know it is filling up.
      new cloudwatch.Alarm(this, 'DlqNotEmptyAlarm', {
        alarmDescription: 'SES events are failing to reach the suppression table.',
        metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5),
          statistic: 'Maximum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),

      new cloudwatch.Alarm(this, 'HandlerErrorsAlarm', {
        alarmDescription: 'The suppression handler is throwing errors.',
        metric: handler.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),

      // SES publishes these account-level metrics as ratios (0.02 = 2%).
      new cloudwatch.Alarm(this, 'BounceRateAlarm', {
        alarmDescription: 'Bounce rate is above the safe zone. AWS reviews the account at 5%.',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SES',
          metricName: 'Reputation.BounceRate',
          period: Duration.hours(1),
          statistic: 'Maximum',
        }),
        threshold: props.bounceRateThreshold ?? 0.02,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),

      new cloudwatch.Alarm(this, 'ComplaintRateAlarm', {
        alarmDescription: 'Complaint rate is above the safe zone. AWS reviews the account at 0.1%.',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SES',
          metricName: 'Reputation.ComplaintRate',
          period: Duration.hours(1),
          statistic: 'Maximum',
        }),
        threshold: props.complaintRateThreshold ?? 0.0005,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];

    alarms.forEach((alarm) => alarm.addAlarmAction(notify));

    // ---------------------------------------------------------------------
    // Outputs used by scripts/send-test-emails.sh
    // ---------------------------------------------------------------------
    new CfnOutput(this, 'ConfigurationSetName', { value: configurationSet.configurationSetName });
    new CfnOutput(this, 'SuppressionTableName', { value: table.tableName });
    new CfnOutput(this, 'SenderEmail', { value: props.senderEmail });
  }
}
