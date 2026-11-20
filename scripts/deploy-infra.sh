#!/usr/bin/env bash
#
# Deploy (create or update) all JobFit Copilot CloudFormation stacks.
#
# Order matters: storage-stack's bucket CORS imports hosting-stack's
# CloudFront domain; processing-stack imports storage-stack's bucket/table
# ARNs (and needs storage-stack's DeploymentArtifactsBucket to already
# exist, to `cloudformation package` into); api-stack imports exports from
# auth-stack, storage-stack, AND processing-stack (create-application
# publishes to its queue). So: auth -> hosting -> storage -> processing -> api.
# processing and api are both deployed via `aws cloudformation package` (real
# Lambda source under backend/lambdas/), so storage must come first.
#
# Usage:
#   ./scripts/deploy-infra.sh
#
# Env overrides:
#   PROJECT_NAME, ENVIRONMENT, AWS_REGION
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  - see docs/google-sign-in.md.
#     Leave BOTH unset to redeploy without touching whatever Google sign-in
#     config is already live (see the UsePreviousValue note below) - this is
#     what makes it safe to run this script for unrelated infra changes
#     without silently disabling Google sign-in. Set both to change/rotate
#     them. auth-stack.yaml's Default for both is "" (Google disabled), so
#     on a stack's very first-ever deploy, "unset" really does mean
#     disabled - there's no previous value yet to fall back to.
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-jobfit-copilot}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
AWS_REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFN_DIR="${REPO_ROOT}/infrastructure/cloudformation"
FRONTEND_DIR="${REPO_ROOT}/frontend"

deploy() {
  # deploy <stack-suffix> <template-file> [extra ParamKey=Value ...]
  local stack_name="${PROJECT_NAME}-${ENVIRONMENT}-$1"
  local template="$2"
  shift 2
  echo "==> Deploying ${stack_name}"
  aws cloudformation deploy \
    --region "$AWS_REGION" \
    --stack-name "$stack_name" \
    --template-file "${CFN_DIR}/${template}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      "ProjectName=${PROJECT_NAME}" \
      "Environment=${ENVIRONMENT}" \
      "$@" \
    --no-fail-on-empty-changeset
}

print_outputs() {
  # print_outputs <stack-suffix> <label>
  echo ""
  echo "==> $2 outputs"
  aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "${PROJECT_NAME}-${ENVIRONMENT}-$1" \
    --query "Stacks[0].Outputs" --output table
}

get_output() {
  # get_output <stack-suffix> <OutputKey>
  aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "${PROJECT_NAME}-${ENVIRONMENT}-$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
    --output text
}

stack_exists() {
  # stack_exists <stack-suffix> - UsePreviousValue only means something on
  # an UPDATE; a brand-new stack has no previous value to reuse. Verified
  # (this session) that UsePreviousValue works correctly on an update - NOT
  # re-verified for a from-scratch create, so this guard just avoids ever
  # relying on that untested case: a first-ever deploy always gets an
  # explicit value (falling back to the template's own Default) instead.
  aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "${PROJECT_NAME}-${ENVIRONMENT}-$1" \
    >/dev/null 2>&1
}

# CRITICAL: never pass GoogleClientId=/GoogleClientSecret= as plain,
# possibly-empty overrides here. A CloudFormation parameter with a Default
# (both are "" in auth-stack.yaml) that's explicitly overridden with an
# empty string DOES take that empty value - it does NOT fall back to
# whatever's currently deployed. This bit us once already: running this
# script from a shell that simply didn't have the Google env vars set
# silently reset a working Google sign-in setup back to disabled.
# UsePreviousValue=true is CloudFormation's real, unambiguous mechanism for
# "leave this parameter exactly as it is" - use it whenever we're not
# intentionally supplying a new value.
if [[ -n "$GOOGLE_CLIENT_ID" && -n "$GOOGLE_CLIENT_SECRET" ]]; then
  echo "==> Setting/updating Google sign-in credentials."
  GOOGLE_PARAMS=(
    "GoogleClientId=${GOOGLE_CLIENT_ID}"
    "GoogleClientSecret=${GOOGLE_CLIENT_SECRET}"
  )
elif stack_exists auth; then
  echo "==> GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set - leaving Google sign-in config as-is (not disabling it)."
  GOOGLE_PARAMS=(
    "ParameterKey=GoogleClientId,UsePreviousValue=true"
    "ParameterKey=GoogleClientSecret,UsePreviousValue=true"
  )
else
  echo "==> GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set and this is a first-ever deploy - Google sign-in starts disabled."
  GOOGLE_PARAMS=()
fi

deploy auth auth-stack.yaml "${GOOGLE_PARAMS[@]}"
deploy hosting hosting-stack.yaml
deploy storage storage-stack.yaml

# Runtime settings that live in SSM Parameter Store but are deliberately NOT
# CloudFormation resources (see the long comment in processing-stack.yaml):
# an admin changes both from /admin without a deploy, so CloudFormation must
# never own - or be able to overwrite - their values. This only CREATES them
# if they're missing; if they already exist (even if an admin has since
# changed them), it leaves them completely alone.
bootstrap_ssm_parameter() {
  # bootstrap_ssm_parameter <name> <initial-value>
  #
  # MSYS_NO_PATHCONV=1 is scoped to just these two calls on purpose: Git Bash
  # on Windows rewrites any argument that looks like a POSIX path (like
  # /jobfit/ai-api-key) into a Windows path before aws.exe sees it, which
  # would turn the parameter name into garbage - but turning that off
  # script-wide breaks the opposite case, the /c/Users/... template paths
  # elsewhere in this script that DO need converting.
  if MSYS_NO_PATHCONV=1 aws ssm get-parameter --name "$1" --region "$AWS_REGION" >/dev/null 2>&1; then
    echo "==> SSM parameter $1 already exists - leaving its value alone."
  else
    MSYS_NO_PATHCONV=1 aws ssm put-parameter --name "$1" --type String --value "$2" \
      --region "$AWS_REGION" >/dev/null
    echo "==> Created SSM parameter $1 (initial value: $2)."
  fi
}
# processing-stack and api-stack each contain a Lambda whose source lives in
# backend/lambdas/ as real code - too large for CloudFormation's
# 4096-character inline ZipFile limit. `aws cloudformation package` zips the
# local source, uploads it to storage-stack's DeploymentArtifactsBucket, and
# writes a rewritten copy of the template pointing at that upload; THAT
# copy (not the original file) is what actually gets deployed.
ARTIFACTS_BUCKET="$(get_output storage DeploymentArtifactsBucketName)"

deploy_packaged() {
  # deploy_packaged <stack-suffix> <template-file>
  local packaged
  packaged="$(mktemp)"
  echo "==> Packaging $2"
  aws cloudformation package \
    --region "$AWS_REGION" \
    --template-file "${CFN_DIR}/$2" \
    --s3-bucket "$ARTIFACTS_BUCKET" \
    --output-template-file "$packaged"

  echo "==> Deploying ${PROJECT_NAME}-${ENVIRONMENT}-$1"
  aws cloudformation deploy \
    --region "$AWS_REGION" \
    --stack-name "${PROJECT_NAME}-${ENVIRONMENT}-$1" \
    --template-file "$packaged" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      "ProjectName=${PROJECT_NAME}" \
      "Environment=${ENVIRONMENT}" \
    --no-fail-on-empty-changeset
  rm -f "$packaged"
}

deploy_packaged processing processing-stack.yaml
deploy_packaged api api-stack.yaml

# AFTER the stacks, not before: nothing needs these two parameters at deploy
# time (the Lambdas only read them at runtime), and an older processing-stack
# revision declared /jobfit/ai-api-key as a CloudFormation resource - the
# deploy above is what removes it, and a parameter created before that point
# would be deleted along with it.
bootstrap_ssm_parameter /jobfit/use-live-ai "false"
bootstrap_ssm_parameter /jobfit/ai-api-key "not-yet-configured"

print_outputs auth "Auth stack"
print_outputs hosting "Hosting stack"
print_outputs storage "Storage stack"
print_outputs processing "Processing stack"
print_outputs api "API stack"

# Convenience: point local dev (`npm run dev`) at the deployed backend so
# you don't have to copy these values by hand.
echo ""
echo "==> Writing ${FRONTEND_DIR}/.env.local"
cat > "${FRONTEND_DIR}/.env.local" <<EOF
VITE_AWS_REGION=${AWS_REGION}
VITE_USER_POOL_ID=$(get_output auth UserPoolId)
VITE_USER_POOL_CLIENT_ID=$(get_output auth UserPoolClientId)
VITE_API_ENDPOINT=$(get_output api ApiEndpoint)
VITE_COGNITO_DOMAIN=$(get_output auth UserPoolDomain)
EOF
cat "${FRONTEND_DIR}/.env.local"
