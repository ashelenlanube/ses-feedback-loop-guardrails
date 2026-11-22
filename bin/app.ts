#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { FeedbackLoopStack } from '../lib/feedback-loop-stack';

const app = new App();

// Pass your own values with: npx cdk deploy -c senderEmail=you@example.com -c alertEmail=you@example.com
const senderEmail = app.node.tryGetContext('senderEmail') ?? 'sender@example.com';
const alertEmail = app.node.tryGetContext('alertEmail');

new FeedbackLoopStack(app, 'SesFeedbackLoopStack', {
  senderEmail,
  alertEmail,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
