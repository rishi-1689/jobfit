# Setting up "Continue with Google"

The code and infrastructure are already built (see `infrastructure/cloudformation/auth-stack.yaml`
and `frontend/src/pages/Login.tsx`). What's left is creating a Google OAuth
client — that has to happen in *your* Google account, so it's the one part
of this I can't do for you.

## 1. Create the Google OAuth client

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create
   a project (or pick an existing one).
2. **APIs & Services → OAuth consent screen** → configure it: User type
   "External", app name "JobFit Copilot", your support email. You don't
   need to submit it for verification — an unverified app works fine for
   personal/demo use, it just shows a "Google hasn't verified this app"
   warning, and (while the app is in "Testing" publishing status) only
   lets in Google accounts you've explicitly added under **Test users**.
   Add your own Google account there.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Name: anything, e.g. "JobFit Copilot"
   - **Authorized JavaScript origins:**
     ```
     http://localhost:5173
     https://d2qcosxdgdec5d.cloudfront.net
     ```
   - **Authorized redirect URIs** — this is the one fixed value Cognito
     always expects, computed from your account/region (`auth-stack.yaml`'s
     `UserPoolDomain` resource):
     ```
     https://jobfit-copilot-dev-290657649071.auth.ap-south-1.amazoncognito.com/oauth2/idpresponse
     ```
4. Click Create. Google shows you a **Client ID** and **Client secret** —
   copy both.

## 2. Deploy with those credentials

The `EnableGoogleSignIn` condition in `auth-stack.yaml` only turns on when
`GoogleClientId`/`GoogleClientSecret` are non-empty, so nothing changes
until you run this:

```bash
GOOGLE_CLIENT_ID="<paste client ID>" \
GOOGLE_CLIENT_SECRET="<paste client secret>" \
bash scripts/deploy-infra.sh
```

Then redeploy the frontend so it picks up `VITE_COGNITO_DOMAIN`:

```bash
bash scripts/deploy-frontend.sh
```

**On the client secret:** it's a real secret — treat it like a password.
It's never written to any file in this repo (the deploy script only reads
it from your shell environment for that one `aws cloudformation deploy`
call, where it's stored as a `NoEcho` CloudFormation parameter — hidden
from the console/CLI output, though still visible to anyone with IAM
permission to read the stack). If you'd rather not paste it into a chat
with me at all, run the two commands above yourself in your own terminal —
I never need to see the value.

## 3. Verify

Open https://d2qcosxdgdec5d.cloudfront.net/login, click **Continue with
Google**, sign in with a test-user Google account, and you should land on
`/dashboard` — Cognito auto-creates a federated user on first Google
sign-in (mapped from Google's `email`/`name` claims, same attributes an
email/password signup fills in).

## If you ever change the CloudFront domain or add a custom domain

Update the `CallbackUrls` parameter (and add the new origin in Google
Cloud Console's Authorized JavaScript origins) — Cognito rejects a
redirect to any URL not on that list.
