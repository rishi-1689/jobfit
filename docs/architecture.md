# Phase 1 architecture

```
                       ┌─────────────────────────┐
   Browser  ──HTTPS──▶ │  CloudFront distribution │
   (SPA)               │  - TLS termination      │
     │                 │  - edge cache           │
     │                 │  - SPA error routing    │
     │                 └───────────┬─────────────┘
     │                    OAC (SigV4, signed)
     │                             ▼
     │                 ┌─────────────────────────┐
     │                 │  S3 bucket (PRIVATE)    │
     │                 │  index.html + JS/CSS    │
     │                 │  Block Public Access ON │
     │                 └─────────────────────────┘
     │
     │  signUp / confirmSignUp / signIn (SRP)
     └───────────────▶ ┌─────────────────────────┐
       aws-amplify v6  │  Cognito User Pool      │
                       │  - user directory       │
                       │  - email verification   │
                       │  - issues JWTs          │
                       │  User Pool Client       │
                       │  (public, no secret)    │
                       └─────────────────────────┘
```

## auth-stack.yaml

| Resource | Role |
|---|---|
| `AWS::Cognito::UserPool` | Managed user directory + login server. Stores email/name/password, runs sign-up and email verification, issues ID/access/refresh JWTs. |
| `AWS::Cognito::UserPoolClient` | The frontend's registration with the pool. `GenerateSecret: false` = **public client** (a browser can't hide a secret). Auth flow is SRP, so the password never leaves the browser in the clear. |

**Key terms**

- **User Pool** – the directory + auth service. Not to be confused with an
  *Identity Pool* (which hands out temporary AWS IAM credentials; not used in
  Phase 1).
- **User Pool Client** – per-application settings on the pool: allowed auth
  flows, token lifetimes, whether a client secret is issued.
- **SRP (Secure Remote Password)** – a challenge/response protocol that proves
  password knowledge without transmitting the password or needing a secret.
- **Auto-verified attribute** – Cognito emails a code and won't treat the
  address as verified until the user enters it (`confirmSignUp`).

## hosting-stack.yaml

| Resource | Role |
|---|---|
| `AWS::S3::Bucket` | Stores the built frontend. Fully private – all four Block Public Access switches on. |
| `AWS::CloudFront::OriginAccessControl` | CloudFront's signed identity for reading the private bucket. |
| `AWS::CloudFront::Distribution` | Public HTTPS front door + CDN cache. Also does `DefaultRootObject` (serve index.html at `/`) and rewrites 403/404 → `/index.html` so client-side routes survive a refresh. |
| `AWS::S3::BucketPolicy` | Grants `s3:GetObject` **only** to the CloudFront service principal for **this** distribution (`AWS:SourceArn` condition). |

**Key terms**

- **Origin** – where CloudFront fetches content on a cache miss (here, the S3
  bucket's REST endpoint).
- **Origin Access Control (OAC)** – the current AWS-recommended way to keep an
  S3 origin private. CloudFront signs each origin request with SigV4 as the
  `cloudfront.amazonaws.com` principal; the bucket policy trusts exactly that.
  Replaces the older Origin Access Identity (OAI).
- **Why not S3 "static website hosting"?** That feature requires public read
  access and serves plain HTTP only. We want private + HTTPS, so CloudFront
  provides the "website" behavior instead and reads S3 over the authenticated
  REST endpoint (`*.s3.<region>.amazonaws.com`), not the website endpoint
  (`*.s3-website-<region>.amazonaws.com`).
- **Invalidation** – tells edge caches to drop a path so the next request
  re-fetches from the origin. The deploy script invalidates `/*` after upload.

## Frontend

- `src/amplifyConfig.ts` – `Amplify.configure({ Auth: { Cognito: {...} } })`
  from Vite env vars. Imported once in `main.tsx`.
- `src/context/AuthContext.tsx` – `AuthProvider` + `useAuth()`. Owns the
  current-user state, wraps the Amplify v6 auth calls, refreshes after each
  change. Mirrors the SocialGen pattern.
- `src/components/ProtectedRoute.tsx` – waits for the session check, then
  redirects unauthenticated users to `/login`.
- Pages: `Login`, `Signup` (details → email-code confirm), `Dashboard`
  (protected placeholder).
