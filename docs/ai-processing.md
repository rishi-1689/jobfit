# Async processing & the AI toggle (Phase 3)

## What happens when you submit a job description

```
POST /applications
  │
  ├─ writes a JobApplications row: status = PENDING
  │
  └─ publishes {userId, applicationId, jobDescription} to SQS
        │
        ▼
  ApplicationProcessingQueue ──(3 failed attempts)──▶ ApplicationProcessingDLQ
        │
        ▼ (batch size 1)
  process-application Lambda
    1. status = PROCESSING
    2. look up UserProfiles.currentResumeS3Key
    3. extract resume text (PDF via Amazon Textract; anything else
       degrades gracefully - see below)
    4. live-AI toggle off (default): deterministic keyword-overlap matcher
       toggle on: live AI call, auto-falls-back to the deterministic
       matcher if that call throws
    5. write the cover letter to S3 (cover-letters/{userId}/{applicationId}.txt)
    6. status = DONE, matchScore, gapAnalysis, coverLetterS3Key
```

The frontend (`ApplicationsHistory.tsx`) polls `GET /applications` every 5s
while anything is PENDING/PROCESSING and stops once everything's settled -
no code changes needed there for Phase 3, it already anticipated this.

## Managing the AI toggle, the API key, and quotas: `/admin`

Both the on/off switch and the API key are **runtime settings**, changed
from the `/admin` page with no redeploy. They live in SSM Parameter Store
(`/jobfit/use-live-ai`, `/jobfit/ai-api-key`), and the processing Lambda
reads them fresh on every invocation. Per-user submission quotas are
managed on the same page.

One-time setup - grant yourself access (admin rights are a decision about
people, so they're deliberately not in CloudFormation):

```bash
bash scripts/make-admin.sh you@example.com [cognito-username]
```

If the same email maps to more than one Cognito account (e.g. one
email/password account and one Google sign-in account), the script lists
them and asks you to name the one you actually sign in with. Then sign out
and back in - group membership is baked into the token at sign-in, so an
old session won't have it - and open `/admin` (reachable by URL only;
there's no nav link).

**Access control.** The API Gateway JWT authorizer only proves *who* you
are; it can't check what you're entitled to do. So every `/admin/*` request
is authenticated by the authorizer like any other route, and then the admin
Lambda itself checks the token's `cognito:groups` claim for `Admins` and
returns 403 otherwise. The page just reflects that 403 ("Admins only").

**The API key is write-only.** `PUT /admin/api-key` stores it as an SSM
SecureString (the SSM API supports that directly - it was only
CloudFormation's resource type that couldn't) and no route ever reads it
back; the page can only replace it. "Configured" is detected from the
parameter's version number, without decrypting anything.

**Why these two settings aren't CloudFormation resources.** Anything an
admin changes at runtime shouldn't be owned by a tool that reasserts its
own idea of the value on a later deploy - the same class of bug that once
wiped out the live Google sign-in config. `deploy-infra.sh` just *creates*
the two parameters if they're missing (after the stacks deploy) and never
touches them again; CloudFormation only grants IAM permission to those fixed
names. `scripts/set-ai-key.sh` still works as a terminal alternative to the
admin page.

**Quotas.** `create-application` does an atomic conditional `UpdateItem` on
the caller's `UserProfiles` row (`applicationCount < applicationQuota`), so
there's no read-then-write race; over-limit submissions get a 429. A user
with no explicit quota uses the `DefaultApplicationQuota` stack parameter
(10). Known trade-offs: a user's very first submission always passes (the
count/quota attributes don't exist yet to compare), and the counter is
all-time, not per-month.

**`callAIProvider()` in `backend/lambdas/process-application/index.js` is
currently a stub** - it always throws, which is intentional: turning the
toggle on today just exercises the SSM/IAM path and then falls back to the
deterministic matcher, rather than failing every submitted application.
Wiring in a real Gemini call there is future work.

## Why PDF works and DOCX doesn't (yet)

PDF text extraction uses Amazon Textract's `DetectDocumentText` - an AWS
SDK call, consistent with every other Lambda in this project (no bundled
npm dependency, no build step). A `.docx` file is a ZIP archive containing
XML; there's no equivalent SDK-only way to read one, and a from-scratch
ZIP+XML parser is real binary-format code that's easy to get subtly wrong
in ways that only show up on some real-world files - not something to ship
untested in a Lambda handling actual user uploads.

So today: PDF resumes get real text extraction and a real match score;
anything else (DOCX, images, whatever) gets a **graceful, visible-to-the-
user degradation** - `matchScore: 0` with a `gapAnalysis` entry explaining
why, status still `DONE` (never a crash, never a stuck PENDING row). A
follow-up phase could add a Lambda Layer with a real DOCX library
(`mammoth`, for example) if that's worth the added build step.

## Error handling & the DLQ

SQS redelivers a message up to `maxReceiveCount: 3` (`RedrivePolicy` on
`ApplicationProcessingQueue`) before routing it to
`ApplicationProcessingDLQ`. The Lambda only writes `status: FAILED` on the
**last** allowed attempt (checked via SQS's own `ApproximateReceiveCount`
message attribute) - not on attempt 1, so a transient error followed by a
successful retry doesn't show the user a false "FAILED" that the frontend's
polling would then stop refreshing on. All verified by direct invocation
with synthetic receive counts - see the Phase 3 build notes in project
memory for the exact test transcripts.

A message reaching the DLQ means all 3 attempts genuinely failed - nothing
currently alerts on this automatically; check
`aws sqs get-queue-attributes --queue-url <DLQ URL> --attribute-names ApproximateNumberOfMessages`
periodically, or wire up a CloudWatch alarm on it as a future improvement.
