#!/usr/bin/env bash
#
# Build the React app and publish it to the CloudFront-fronted S3 bucket.
#
#   1. Read stack outputs (Cognito IDs, bucket name, distribution ID, API URL).
#   2. Write frontend/.env.production from the auth/hosting/api stack outputs.
#   3. npm ci && npm run build.
#   4. Sync dist/ to S3 (long-cache hashed assets, no-cache index.html).
#   5. Create a CloudFront invalidation so users get the new index.html now.
#
# Usage:
#   ./scripts/deploy-frontend.sh
#
# Env overrides:
#   PROJECT_NAME (default: jobfit-copilot)
#   ENVIRONMENT  (default: dev)
#   AWS_REGION   (default: current CLI region, else us-east-1)
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-jobfit-copilot}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
AWS_REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"

AUTH_STACK="${AUTH_STACK:-${PROJECT_NAME}-${ENVIRONMENT}-auth}"
HOSTING_STACK="${HOSTING_STACK:-${PROJECT_NAME}-${ENVIRONMENT}-hosting}"
API_STACK="${API_STACK:-${PROJECT_NAME}-${ENVIRONMENT}-api}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/frontend"

echo "==> Region: ${AWS_REGION}"
echo "==> Auth stack: ${AUTH_STACK}"
echo "==> Hosting stack: ${HOSTING_STACK}"
echo "==> API stack: ${API_STACK}"

get_output() {
  # get_output <stack-name> <OutputKey>
  aws cloudformation describe-stacks \
    --stack-name "$1" \
    --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
    --output text
}

USER_POOL_ID="$(get_output "$AUTH_STACK" UserPoolId)"
USER_POOL_CLIENT_ID="$(get_output "$AUTH_STACK" UserPoolClientId)"
BUCKET="$(get_output "$HOSTING_STACK" SiteBucketName)"
DISTRIBUTION_ID="$(get_output "$HOSTING_STACK" DistributionId)"
API_ENDPOINT="$(get_output "$API_STACK" ApiEndpoint)"
COGNITO_DOMAIN="$(get_output "$AUTH_STACK" UserPoolDomain)"

for pair in \
  "USER_POOL_ID=$USER_POOL_ID" \
  "USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID" \
  "BUCKET=$BUCKET" \
  "DISTRIBUTION_ID=$DISTRIBUTION_ID" \
  "API_ENDPOINT=$API_ENDPOINT" \
  "COGNITO_DOMAIN=$COGNITO_DOMAIN"; do
  if [[ -z "${pair#*=}" || "${pair#*=}" == "None" ]]; then
    echo "ERROR: missing stack output for ${pair%%=*}. Are all stacks deployed (run deploy-infra.sh first)?" >&2
    exit 1
  fi
done

echo "==> Writing ${FRONTEND_DIR}/.env.production"
cat > "${FRONTEND_DIR}/.env.production" <<EOF
VITE_AWS_REGION=${AWS_REGION}
VITE_USER_POOL_ID=${USER_POOL_ID}
VITE_USER_POOL_CLIENT_ID=${USER_POOL_CLIENT_ID}
VITE_API_ENDPOINT=${API_ENDPOINT}
VITE_COGNITO_DOMAIN=${COGNITO_DOMAIN}
EOF

echo "==> Building frontend"
cd "$FRONTEND_DIR"
npm ci
npm run build

echo "==> Syncing hashed assets to s3://${BUCKET}"
# Everything except index.html: content-hashed by Vite, cache forever.
aws s3 sync dist/ "s3://${BUCKET}/" \
  --region "$AWS_REGION" \
  --delete \
  --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable"

echo "==> Uploading index.html (no-cache)"
aws s3 cp dist/index.html "s3://${BUCKET}/index.html" \
  --region "$AWS_REGION" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html"

echo "==> Invalidating CloudFront distribution ${DISTRIBUTION_ID}"
aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*" \
  --query "Invalidation.{Id:Id,Status:Status}" \
  --output table

CF_DOMAIN="$(get_output "$HOSTING_STACK" CloudFrontDomainName)"
echo ""
echo "==> Done. App: https://${CF_DOMAIN}"
