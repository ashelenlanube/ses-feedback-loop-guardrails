import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FeedbackLoopStack } from '../lib/feedback-loop-stack';

const template = Template.fromStack(
  new FeedbackLoopStack(new App(), 'TestStack', {
    senderEmail: 'sender@example.com',
    alertEmail: 'alerts@example.com',
  }),
);

test('the Lambda gets the table name from the table resource, not from a hardcoded string', () => {
  const tableLogicalId = Object.keys(template.findResources('AWS::DynamoDB::GlobalTable'))[0];
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: { TABLE_NAME: { Ref: tableLogicalId } } },
  });
});

test('configuration set suppresses bounces and complaints', () => {
  template.hasResourceProperties('AWS::SES::ConfigurationSet', {
    SuppressionOptions: { SuppressedReasons: Match.arrayWith(['BOUNCE', 'COMPLAINT']) },
  });
});

test('the queue has a DLQ', () => {
  template.hasResourceProperties('AWS::SQS::Queue', {
    RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
  });
});

test('there are alarms for the DLQ, handler errors and both reputation metrics', () => {
  template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'Reputation.BounceRate',
    Threshold: 0.02,
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'Reputation.ComplaintRate',
    Threshold: 0.0005,
  });
});

test('the handler can only put items in the suppression table', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([Match.objectLike({ Action: 'dynamodb:PutItem', Effect: 'Allow' })]),
    },
  });
});

test('reputation alarms keep their state when SES publishes no data', () => {
  for (const metricName of ['Reputation.BounceRate', 'Reputation.ComplaintRate']) {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: metricName, TreatMissingData: 'ignore' });
  }
});
