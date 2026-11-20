#!/usr/bin/env bash
#
# Add a user to the "Admins" Cognito group, which is what unlocks /admin.
#
# Deliberately NOT something CloudFormation does (see AdminsGroup in
# auth-stack.yaml): who counts as an admin is a decision about people, not
# infrastructure, and it shouldn't live in a template that gets reviewed,
# copied, and redeployed.
#
# Usage:
#   bash scripts/make-admin.sh you@example.com [cognito-username]
#
# The user must already have signed up (or signed in with Google once).
# They need to sign out and back in afterwards - group membership is baked
# into the tokens at sign-in time, so a token issued before this ran won't
# carry the "Admins" claim yet.
set -euo pipefail

EMAIL="${1:-}"
if [[ -z "$EMAIL" ]]; then
  echo "Usage: bash scripts/make-admin.sh <email>" >&2
  exit 1
fi

PROJECT_NAME="${PROJECT_NAME:-jobfit-copilot}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
AWS_REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"

USER_POOL_ID="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "${PROJECT_NAME}-${ENVIRONMENT}-auth" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text)"

# Look the Cognito username up by email rather than assuming it: an
# email/password user's username is their internal ID, and a Google user's
# is "Google_<id>" - neither is the email address itself.
#
# The same email can legitimately map to MORE than one account here - e.g.
# one created by email/password signup and a separate one created by "Continue
# with Google" - and admin rights belong to exactly one of them. So this
# refuses to guess: with several matches it lists them and asks you to name
# the one you actually sign in with (second argument).
MATCHES="$(aws cognito-idp list-users \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --filter "email = \"${EMAIL}\"" \
  --query "Users[].Username" \
  --output text)"
read -r -a MATCH_ARRAY <<< "$MATCHES"

if [[ -n "${2:-}" ]]; then
  USERNAME="$2"
elif [[ "${#MATCH_ARRAY[@]}" -eq 1 ]]; then
  USERNAME="${MATCH_ARRAY[0]}"
elif [[ "${#MATCH_ARRAY[@]}" -eq 0 ]]; then
  echo "ERROR: no user with email ${EMAIL} in pool ${USER_POOL_ID}." >&2
  echo "       Sign up (or sign in with Google) once first, then re-run this." >&2
  exit 1
else
  echo "ERROR: ${#MATCH_ARRAY[@]} accounts share the email ${EMAIL}:" >&2
  printf '         %s\n' "${MATCH_ARRAY[@]}" >&2
  echo "       Re-run naming the one you sign in with (\"Google_...\" is the" >&2
  echo "       Google sign-in account):" >&2
  echo "         bash scripts/make-admin.sh ${EMAIL} <username>" >&2
  exit 1
fi

aws cognito-idp admin-add-user-to-group \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --group-name Admins

echo "==> ${EMAIL} (${USERNAME}) is now in the Admins group."
echo "==> Sign out and back in, then open /admin."
