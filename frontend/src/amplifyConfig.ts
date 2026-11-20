import { Amplify } from "aws-amplify";

/**
 * Wire AWS Amplify v6 to the Cognito User Pool created by
 * infrastructure/cloudformation/auth-stack.yaml.
 *
 * Values come from Vite env vars (see .env.example). Because this is a
 * public SPA client, there is no client secret to configure - Amplify
 * authenticates with SRP for email/password, and via the OAuth
 * "authorization code" flow (through the Cognito Hosted UI domain) for
 * Google sign-in.
 *
 * Import this module once, for its side effect, before rendering the app
 * (see main.tsx).
 */
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
      loginWith: {
        email: true,
        oauth: {
          domain: import.meta.env.VITE_COGNITO_DOMAIN,
          scopes: ["openid", "email", "profile"],
          // Must exactly match a CallbackURLs/LogoutURLs entry in
          // auth-stack.yaml's UserPoolClient - Cognito rejects a redirect
          // to anything not on that allowlist. window.location.origin
          // covers both localhost dev and the deployed CloudFront domain
          // without hardcoding either.
          redirectSignIn: [window.location.origin],
          redirectSignOut: [window.location.origin],
          responseType: "code",
        },
      },
    },
  },
});
