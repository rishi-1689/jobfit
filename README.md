# JobFit Copilot

A serverless AWS portfolio app, built in phases.

- **Phase 1** - Cognito auth + CloudFront/S3 hosting.
- **Phase 2** - resume upload (S3, presigned URLs), job-description
  submission and history (API Gateway HTTP API + Lambda + DynamoDB).
- **Phase 3** - async processing: SQS decouples submission from matching;
  a Lambda extracts resume text (Amazon Textract), scores it against the
  JD, drafts a cover letter, and writes the result back - all behind a
  global `USE_LIVE_AI` toggle with a safe deterministic fallback.
- Google sign-in (Cognito Hosted UI federation) alongside email/password.

A user can: sign up (or sign in with Google), verify their email, log in,
upload a resume, submit a job description, and watch it move from
`PENDING` → `PROCESSING` → `DONE` with a match score, a gap analysis, and
a generated cover letter.

## Monorepo layout

```
infrastructure/cloudformation/   CloudFormation templates (IaC), deployed in this order:
  auth-stack.yaml                Cognito User Pool + SPA client + Google federation
  hosting-stack.yaml             Private S3 bucket + CloudFront (OAC)
  storage-stack.yaml             Uploads bucket, JobApplications/UserProfiles tables,
                                  deployment-artifacts bucket
  processing-stack.yaml          SQS + DLQ, the async processing Lambda, AI toggle
  api-stack.yaml                 HTTP API + Cognito JWT authorizer + 3 Lambdas
backend/lambdas/                 Lambda source too large for inline template code
  process-application/           deployed via `aws cloudformation package`
frontend/                        React 18 + Vite + TS + Tailwind + Amplify v6
scripts/                         deploy-infra.sh, deploy-frontend.sh, set-ai-key.sh
docs/                            Architecture notes, setup walkthroughs
```

## Quick start

```bash
# 1. Deploy all five CloudFormation stacks
./scripts/deploy-infra.sh

# 2. Local dev against the deployed backend
cd frontend
npm install
npm run dev        # .env.local was written for you by deploy-infra.sh

# 3. Deploy the built frontend to CloudFront
./scripts/deploy-frontend.sh
```

Google sign-in and the live-AI path are both off by default and opt-in -
see [docs/google-sign-in.md](docs/google-sign-in.md) and
[docs/ai-processing.md](docs/ai-processing.md).

See [docs/phase-1-deploy.md](docs/phase-1-deploy.md) for the original deploy
walkthrough, [docs/architecture.md](docs/architecture.md) for how Phase 1-2
fit together, and [docs/interview.md](docs/interview.md) for a fuller
architecture writeup with the reasoning behind each decision.

## License

[MIT](LICENSE)
