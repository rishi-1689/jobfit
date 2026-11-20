# JobFit Copilot — architecture & interview prep

A study reference for talking about this project in an interview: what it
is, why each piece was chosen, and the questions an interviewer is likely
to ask about a serverless AWS app like this — with answers written the way
you'd actually say them out loud.

---

## 1. What the app does (so far)

JobFit Copilot is a serverless job-application tracker, built in phases:

- **Phase 1** — a user can sign up, verify their email, log in, and land on
  an authenticated dashboard.
- **Phase 2** — from that dashboard, a user can upload a resume, submit a
  job description, and see it appear in their history with status
  `PENDING`. No actual resume/JD processing happens yet — that's a later
  phase (SQS → a processing Lambda → SNS notification, not yet built).

Everything is infrastructure-as-code (CloudFormation, four stacks) and
100% serverless: no server to patch, no idle compute to pay for, and the
whole thing scales to zero when nobody's using it.

## 2. Architecture diagram

```
Browser (React SPA)
  │
  ├─ HTTPS ───────────▶ CloudFront ──OAC──▶ S3 (private, static assets)
  │
  ├─ SRP auth ─────────▶ Cognito User Pool (sign up / verify / log in)
  │                       issues ID token + ACCESS token + refresh token
  │
  ├─ Bearer <access token> ──▶ API Gateway (HTTP API)
  │                              │
  │                              ├─ JWT authorizer (validates token,
  │                              │   BEFORE any Lambda runs)
  │                              │
  │                              ├─ POST /resumes/presigned-url ─▶ Lambda ─▶ S3 presign
  │                              │                                      └─▶ DynamoDB UserProfiles (UpdateItem)
  │                              ├─ POST /applications ───────────▶ Lambda ─▶ DynamoDB JobApplications (PutItem)
  │                              └─ GET  /applications ───────────▶ Lambda ─▶ DynamoDB JobApplications (Query)
  │
  └─ PUT (presigned URL) ─────▶ S3 uploads bucket (private, direct-from-browser)
```

Four independent CloudFormation stacks, deployed in dependency order and
wired together with **cross-stack exports/imports** (`Fn::ImportValue`),
not hardcoded values:

| Stack | Owns |
|---|---|
| `auth-stack.yaml` | Cognito User Pool + public SPA client |
| `hosting-stack.yaml` | CloudFront + private S3 site bucket (OAC) |
| `storage-stack.yaml` | Uploads bucket, `JobApplications` + `UserProfiles` tables |
| `api-stack.yaml` | HTTP API, JWT authorizer, 3 Lambdas, their IAM roles |

`storage-stack` depends on `hosting-stack` (imports the CloudFront domain
for S3 CORS); `api-stack` depends on `auth-stack` (User Pool for the
authorizer) and `storage-stack` (table/bucket ARNs for IAM policies and
Lambda env vars). That dependency order is exactly the order
`scripts/deploy-infra.sh` deploys them in.

## 3. Key design decisions (the "why", not just the "what")

**Cognito for auth, not a hand-rolled system.** Password hashing, email
verification, token issuance/rotation, and brute-force protection are all
solved problems with real security consequences for getting wrong. Cognito
is a managed user directory *and* login server — sign-up, sign-in, and
token issuance happen without a line of backend auth code.

**Public SPA client (no client secret).** A browser can't keep a secret —
all its JS is downloadable. `GenerateSecret: false` plus SRP (Secure Remote
Password) auth lets the frontend prove password knowledge without ever
sending the password or needing a secret.

**Access token for API calls, ID token for identity.** These are two
different JWTs from the same login, serving different jobs: the ID token
says *who the user is* (for the UI to display); the access token
*authorizes calling an API* — the literal purpose of an OAuth access
token. The Lambda authorizer's `Audience` is checked against the access
token's `client_id` claim (API Gateway special-cases this for Cognito,
since access tokens don't carry a standard `aud` claim).

**CloudFront + OAC instead of S3 static website hosting.** S3's own
"static website hosting" feature requires the bucket to be public and only
serves plain HTTP. We want the bucket fully private and HTTPS-only, so
CloudFront does the "website" job (HTTPS, default root object, SPA
routing) and reads the bucket over its private REST endpoint. **Origin
Access Control (OAC)** is how: CloudFront signs every origin request with
SigV4 as a service principal, and the bucket policy trusts only that
signature, scoped to this one distribution's ARN. Nothing else — not even
your own IAM user — can read the bucket directly.

**HTTP API, not REST API.** API Gateway's newer HTTP API product covers
the common case (route → Lambda, authorize with a JWT) at ~70% lower cost
and lower latency than the older REST API. REST API's extras (request/
response transformation, usage plans, WAF integration, private VPC
endpoints) aren't needed here.

**A JWT authorizer in front of every route.** Authorization happens at the
API Gateway edge, before a Lambda ever runs: a bad/expired/wrong-audience
token gets a 401 with zero compute spent. Least privilege isn't just an
IAM concept — it's enforced at the network boundary too.

**Presigned URLs for uploads, not a Lambda proxy.** A presigned URL is a
normal S3 URL with a temporary signature in the query string, minted using
the Lambda's own IAM credentials. Whoever holds it can perform exactly one
action (PUT one exact key) until it expires (300s here) — no AWS
credentials of their own needed. This lets the browser PUT file bytes
*directly* to S3, sidestepping HTTP API's 10 MB request-body limit and
never burning Lambda runtime proxying bytes it doesn't need to touch.

**DynamoDB, on-demand billing.** `PAY_PER_REQUEST` scales read/write
throughput automatically and bills per request — no capacity planning, no
cost when idle, no throttling from under-provisioning. The alternative,
provisioned capacity, is cheaper *only* at steady, predictable, high
volume; a low-traffic portfolio app would just be paying for idle
capacity. Partition key `userId` + sort key `applicationId` on
`JobApplications` means "all of this user's applications" is a single
efficient `Query` (reads one partition) instead of a `Scan` (reads the
whole table) — that's also what makes "you only see your own data" true
at the data layer, not just enforced in application code.

**Least-privilege IAM per Lambda**, not one shared execution role. Each of
the three Lambdas gets its own role scoped to exactly the actions and
resource ARNs it needs:

| Lambda | Can do | Cannot do |
|---|---|---|
| `presigned-url` | `s3:PutObject` on `uploads/resumes/*` only; `dynamodb:UpdateItem` on `UserProfiles` only | Read any object, touch `JobApplications`, `Scan` anything |
| `create-application` | `dynamodb:PutItem` on `JobApplications` only | Read, query, or delete anything |
| `list-applications` | `dynamodb:Query` on `JobApplications` only | Write anything, touch `UserProfiles` or S3 |

A compromised or buggy Lambda's blast radius is bounded by its own policy,
not by "whatever the app's service account can do."

**Cross-stack exports over hardcoded values or one giant template.**
Splitting into 4 stacks keeps each one focused and independently
updatable (e.g. redeploy `api-stack` without touching Cognito), while
`Fn::ImportValue` keeps IDs/ARNs flowing between them as real CloudFormation
dependencies instead of copy-pasted strings. Trade-off: CloudFormation
refuses to delete a stack while another stack still imports its exports —
a real gotcha worth knowing (see the Q&A below).

## 4. A real bug worth telling as a story

The three Lambdas use CloudFormation's inline `ZipFile` property — the
function's source code lives directly in the YAML template, no separate
build/zip/upload step. First pass used ES module syntax
(`import`/`export`). Every Lambda failed at cold start with:

```
Runtime.UserCodeSyntaxError: SyntaxError: Cannot use import statement outside a module
```

**Root cause:** Node.js decides CommonJS vs ESM per-file: a `.js` file is
CommonJS unless a `package.json` alongside it declares `"type": "module"`,
or the file itself is named `.mjs`. Inline `ZipFile` code is packaged as
`index.js` with **no `package.json` at all** — so there's no way to opt
into ESM syntax. Fix: rewrite every handler to `require(...)` /
`exports.handler = ...`.

This is a good story for an interview because it demonstrates: reading a
Lambda stack trace correctly, understanding a genuinely subtle Node.js
module-resolution rule (not just "I copy-pasted a fix"), and the trade-off
of inline `ZipFile` (fast to iterate, no build tooling) vs a real build
pipeline (`aws cloudformation package`/SAM/CDK, which *would* let you use
ESM, TypeScript, and npm dependencies beyond what's pre-bundled in the
Lambda runtime).

---

## 5. Interview questions & answers

### Authentication (Cognito)

**Q: Walk me through what happens, step by step, when a user logs in.**
A: The browser calls Amplify's `signIn`, which runs the SRP (Secure Remote
Password) protocol against the Cognito User Pool: the client proves it
knows the password via a cryptographic challenge/response, without the
password ever crossing the network. Cognito returns three JWTs — ID,
access, and refresh — which Amplify stores. The ID token identifies the
user to the app; the access token is attached as a bearer token on API
calls; the refresh token lets Amplify silently get new tokens without the
user re-entering credentials.

**Q: Why SRP instead of just sending the password over HTTPS?**
A: HTTPS protects the password in transit, but SRP means the password
itself is never transmitted or reconstructable from what *is* sent — it
proves the client knows the password via a challenge/response derived from
it. Defense in depth: even a misconfigured TLS terminator or logging
proxy never sees a plaintext password.

**Q: What's the difference between the ID token and the access token, and
why does this app use the access token for API calls?**
A: Same login, two JWTs, two jobs. The ID token is an OIDC concept —
"here's who this user is" (email, name, sub) — meant for the client to
read, not for authorizing calls to *other* services. The access token is
the OAuth concept for exactly that: "this bearer may call APIs on this
user's behalf," scoped by the client it was issued to. Since API Gateway
is authorizing an API call, the access token is the semantically correct
one — and it's also what API Gateway's Cognito-aware JWT authorizer
expects when validating audience against `client_id`.

**Q: Why does the User Pool Client have no secret?**
A: It's a public client — a browser SPA. All of its JavaScript is
downloadable, so any secret embedded in it isn't a secret. `GenerateSecret:
false` is the CloudFormation way of declaring that; the app relies on SRP
plus short-lived tokens instead.

**Q: Your Cognito email sender is `COGNITO_DEFAULT`. What's the
limitation, and how would you fix it for production?**
A: `COGNITO_DEFAULT` is Cognito's built-in sender — no setup required, but
rate-limited (roughly 50 emails/day) and the "from" address is AWS-owned,
not your domain. For production you'd switch `EmailConfiguration` to
`DEVELOPER` and hand Cognito a verified SES identity, which also lets you
brand the "from" address and control deliverability/bounce handling.

### Storage & CDN (S3, CloudFront, OAC)

**Q: The site bucket is private. How does anyone see the website, then?**
A: Through CloudFront, using an **Origin Access Control (OAC)**. CloudFront
signs its requests to the bucket with SigV4 as the
`cloudfront.amazonaws.com` service principal; the bucket policy grants
`s3:GetObject` only to that principal, scoped by an `AWS:SourceArn`
condition to this one distribution's ARN. So the bucket has zero public
access, yet CloudFront — and only this CloudFront distribution — can read
it.

**Q: Why not just use S3's own static website hosting feature?**
A: Because that feature *requires* the bucket to allow public reads and
only serves plain HTTP — the opposite of what we want. CloudFront in front
of a private bucket gets us both HTTPS and privacy; S3 website hosting
gets neither privacy nor (natively) HTTPS.

**Q: This is a single-page app with client-side routing
(`/dashboard`, `/login`). What happens if a user refreshes on
`/dashboard`, and how did you make that work?**
A: S3 has no object at that path, so a request for it 403s (private
bucket via OAC) or would 404 on a public one. CloudFront's
`CustomErrorResponses` rewrites both 403 and 404 to `/index.html` with a
200, so the SPA's JS loads and React Router takes over from there,
resolving `/dashboard` client-side.

**Q: Why does the uploads bucket need its own CORS configuration, when
the API already has CORS configured?**
A: Two different cross-origin calls. API Gateway's `CorsConfiguration`
covers preflight for calls *to the API* (e.g. `POST /applications`). The
resume upload's actual file bytes go straight from the browser to S3 via
the presigned URL — a *different* origin (the S3 bucket's own domain) —
which needs its own `CorsConfiguration` on the bucket to allow a
cross-origin `PUT`.

**Q: Why a 90-day lifecycle rule on the uploads bucket?**
A: Cost hygiene for a project that's still iterating — resumes uploaded
during testing/demos don't need to live forever, and unbounded growth in a
bucket nobody's cleaning up is a classic "surprise AWS bill" source. In a
real product you'd tie retention to actual data-retention requirements
rather than a flat 90 days.

### API design (HTTP API, Lambda, presigned URLs)

**Q: HTTP API vs REST API in API Gateway — how do you choose?**
A: HTTP API is newer, cheaper (~70% less), and lower-latency, covering the
common pattern: route requests, authorize with a JWT or Lambda authorizer,
proxy to a backend. REST API is the original, more feature-rich product —
request/response transformation without touching the backend, usage
plans and API keys, WAF integration, private VPC endpoints. Default to
HTTP API unless you specifically need one of those REST-only features.

**Q: What is a presigned URL, and why use one instead of uploading
through your API?**
A: It's a normal S3 URL with a temporary cryptographic signature in the
query string, generated using the signer's (here, the Lambda's) IAM
credentials — it grants the holder one specific action (e.g. PUT this
exact key) for a short window, no AWS credentials of their own required.
Uploading through the API instead would mean the file bytes transit API
Gateway and Lambda — burning Lambda runtime and hitting HTTP API's 10 MB
payload ceiling — for no benefit, since the Lambda never needs to inspect
the bytes, only decide *whether* and *where* the user may write.

**Q: Your presigned-url Lambda both signs a URL and writes to DynamoDB
*before* the upload actually happens. Is that a race condition or a bug?**
A: It's a deliberate simplification, and worth naming as a real trade-off
in an interview: `UserProfiles.currentResumeS3Key` is set optimistically,
so if the presigned PUT never happens (user abandons the upload) the
profile points at an object that doesn't exist. Phase 2's scope is "prove
the upload plumbing works end to end"; a production version would confirm
the object actually landed — e.g. an S3 `ObjectCreated` event or a
follow-up "confirm upload" call — before treating the resume as current.

**Q: How does the Lambda know which user is calling, without you passing
a userId in the request body?**
A: It comes from the verified JWT, not the request body — API Gateway's
JWT authorizer decodes and validates the token *before* invoking the
Lambda, and hands the claims through at
`event.requestContext.authorizer.jwt.claims.sub`. Trusting a client-supplied
userId in the body would let any authenticated user claim to be any other
user; the `sub` claim is the one thing here that's cryptographically
guaranteed to be accurate.

**Q: Where does CORS actually get enforced — client or server?**
A: Server (well, browser-enforced against server-declared policy). CORS
headers are a signal the *browser* enforces on behalf of the user for
cross-origin requests — a non-browser client (curl, another server) is
never blocked by CORS, since CORS isn't a security boundary against
non-browser callers at all. Real access control here is the JWT
authorizer plus IAM, not CORS; CORS just decides whether *this specific
browser page* may see the response.

### Database (DynamoDB)

**Q: Why on-demand billing instead of provisioned?**
A: On-demand (`PAY_PER_REQUEST`) means DynamoDB scales read/write capacity
automatically and you're billed per request — zero cost when idle, no
throttling from guessing capacity wrong, no capacity planning at all.
Provisioned capacity is cheaper *only* at steady, predictable, high
volume, where you're confident enough in the traffic shape to commit to a
number. A low-traffic portfolio app would just be paying for capacity
that sits idle most of the time.

**Q: Why is `applicationId` a sort key instead of, say, the partition
key on its own table?**
A: Because the dominant access pattern is "give me all of this user's
applications" — that's a `Query` on partition key `userId`, which reads
only that user's partition, versus a `Scan` that would read the entire
table (every user's data) to filter client-side. Sort key
`applicationId` (a UUID) then lets one user have many applications while
keeping that query cheap and, critically, means a user's IAM-authorized
query *can't* see another user's rows even by accident — the access
pattern and the security boundary are the same operation.

**Q: What would you change about the schema to support, say, "get
application #X directly" or "list applications by status"?**
A: `GetItem` on `{userId, applicationId}` already answers "get application
#X" cheaply if you know the owning userId (which you do, from the JWT).
"List by status across users" isn't supported by the current key schema
at all — that would need a Global Secondary Index (GSI) with `status` as
its partition key (or a composite like `status#createdAt` for sorting),
since the base table's key schema optimizes for "per-user" access, not
"per-status."

### Security & IAM

**Q: Explain the phrase "least privilege" using this project as an
example.**
A: Each of the three Lambdas has its *own* IAM role, not a shared one, and
each role lists only the exact actions and resource ARNs that Lambda
needs — e.g. `list-applications` can `dynamodb:Query` on `JobApplications`
and nothing else: not `Scan`, not `PutItem`, not touch `UserProfiles` or
S3 at all. If that function had a bug or got compromised, the damage it
could do is bounded by that narrow policy, not by whatever the "app"
could theoretically do.

**Q: How is one user prevented from reading another user's applications?**
A: Two layers. First, the JWT authorizer ensures every request carries a
cryptographically verified `sub` claim — it can't be spoofed by the
client. Second, `list-applications`'s DynamoDB `Query` is hardcoded to
`KeyConditionExpression: "userId = :u"` using that verified `sub`, never
a value the client controls — so even a malicious request body can't ask
for someone else's partition.

**Q: What's a `Fn::ImportValue` gotcha you should know before using
cross-stack references like this project does?**
A: CloudFormation refuses to delete (or update in a way that removes) an
export while another stack still imports it — you'd have to delete the
importing stack (`api-stack`, `storage-stack`) first, in reverse
dependency order, before you could delete `auth-stack` or `hosting-stack`.
It's a real operational trap if you don't know it's coming, and it's part
of why the deploy script deploys stacks in a specific dependency order —
teardown has to reverse it.

### Cost & scalability

**Q: What does this architecture cost at zero traffic? At high traffic?**
A: At zero traffic: essentially nothing beyond pennies of S3 storage and
Route 53-adjacent DNS if any — Lambda, API Gateway HTTP API, DynamoDB
on-demand, and Cognito's free tier all bill per-use, not per-hour-running.
At high traffic: it scales automatically at every layer (CloudFront edge
caching, Lambda concurrency, DynamoDB on-demand throughput) with no
capacity planning from you — the trade-off is per-request pricing can get
more expensive than a well-utilized provisioned/reserved setup at very
high, very predictable volume, which is the point at which you'd
reconsider some of these on-demand choices.

**Q: Where's the ceiling on this specific design before something needs
to change?**
A: A few real ones: HTTP API request bodies cap at 10 MB (irrelevant here
since resumes bypass it via presigned URLs, but relevant to
`POST /applications` if job descriptions got huge — currently truncated to
20,000 characters server-side); Lambda's default concurrency limits (a
soft account-level cap, raisable); and DynamoDB's per-partition throughput
ceiling on a single very "hot" `userId` (unlikely for a per-user access
pattern like this one, since traffic naturally spreads across partitions).

### System design extension

**Q: The next phase adds SQS, a processing Lambda, and SNS. Sketch how
you'd wire that up.**
A: `POST /applications` already writes a `PENDING` row — that Lambda would
also publish a message (applicationId, userId, jobDescription key) to an
SQS queue instead of (or in addition to) just returning. A separate
processing Lambda, triggered by that queue, does the actual work (resume
parsing / JD matching), then updates the DynamoDB row's `status` (e.g. to
`DONE` or `FAILED`) and publishes to an SNS topic for notification (email,
or a future WebSocket/push channel). SQS decouples "accept the request
fast" from "do the slow work," and gives you retries/DLQ for free instead
of holding an HTTP request open during a slow LLM call.

**Q: How would the frontend find out that a PENDING application finished
processing, without you having built any real-time channel yet?**
A: Simplest: poll `GET /applications` on an interval while any row is
`PENDING` (cheap given on-demand DynamoDB Query pricing). The "correct"
long-term answer is push-based — API Gateway WebSocket API, AppSync
subscriptions, or SNS → a mobile/web push service — but polling is a
perfectly reasonable v1 given how infrequent status changes are here.
