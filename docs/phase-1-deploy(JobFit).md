# Phase 1 deploy walkthrough

## Prerequisites

- AWS CLI v2, authenticated (`aws sts get-caller-identity` works).
- Node 18+ and npm.
- A region picked (`us-east-1` is the default in the scripts). CloudFront is
  global; the bucket and Cognito pool live in your chosen region.

## 1. Deploy infrastructure

```bash
./scripts/deploy-infra.sh
```

This runs `aws cloudformation deploy` for both templates:

- `jobfit-copilot-dev-auth` – Cognito User Pool + SPA client
- `jobfit-copilot-dev-hosting` – S3 bucket + CloudFront + OAC

It prints the stack outputs at the end. Note `CloudFrontDomainName`,
`UserPoolId`, `UserPoolClientId`.

> The CloudFront distribution takes ~5–15 minutes to finish deploying the
> first time. `deploy-infra.sh` waits for CloudFormation to report
> `CREATE_COMPLETE`.

## 2. Run the frontend locally (optional)

```bash
cd frontend
cp .env.example .env.local
# edit .env.local with UserPoolId / UserPoolClientId from step 1
npm install
npm run dev        # http://localhost:5173
```

Sign up with a real email address you can receive mail at — Cognito's default
email sender will send the 6-digit verification code.

## 3. Deploy the frontend to CloudFront

```bash
./scripts/deploy-frontend.sh
```

This regenerates `frontend/.env.production` from the auth-stack outputs,
builds, syncs `dist/` to S3, and invalidates the CloudFront cache. It prints
the final URL.

## 4. Verify the acceptance criteria

1. Open `https://<CloudFrontDomainName>` → redirected to `/login`.
2. Go to `/signup`, create an account, receive the code by email.
3. Enter the code → redirected to `/login`.
4. Log in → land on `/dashboard`.
5. Refresh `/dashboard` directly → still works (SPA error routing).
6. Sign out → redirected to `/login`; `/dashboard` no longer accessible.

## Teardown

```bash
# empty the bucket first (CloudFormation won't delete a non-empty bucket)
aws s3 rm "s3://$(aws cloudformation describe-stacks \
  --stack-name jobfit-copilot-dev-hosting \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" \
  --output text)" --recursive

aws cloudformation delete-stack --stack-name jobfit-copilot-dev-hosting
aws cloudformation delete-stack --stack-name jobfit-copilot-dev-auth
```
