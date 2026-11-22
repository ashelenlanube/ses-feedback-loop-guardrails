#!/usr/bin/env bash
# Sends one bounce and one complaint to the SES mailbox simulator,
# then shows what landed in the suppression table.
# Mailbox simulator emails do not count toward your account's bounce or complaint rate.
set -euo pipefail

STACK_NAME="${STACK_NAME:-SesFeedbackLoopStack}"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

CONFIG_SET="$(output ConfigurationSetName)"
TABLE="$(output SuppressionTableName)"
SENDER="$(output SenderEmail)"

for recipient in bounce@simulator.amazonses.com complaint@simulator.amazonses.com; do
  echo "Sending to $recipient..."
  aws sesv2 send-email \
    --from-email-address "$SENDER" \
    --destination "ToAddresses=$recipient" \
    --configuration-set-name "$CONFIG_SET" \
    --content '{"Simple":{"Subject":{"Data":"Feedback loop test"},"Body":{"Text":{"Data":"Hello from the SES feedback loop demo."}}}}' \
    --query MessageId --output text
done

echo "Waiting 30 seconds for SES -> SNS -> SQS -> Lambda..."
sleep 30

aws dynamodb scan --table-name "$TABLE" \
  --query 'Items[].{email:email.S,reason:reason.S,type:bounceType.S,subType:bounceSubType.S,expiresAt:expiresAt.N}' \
  --output table
