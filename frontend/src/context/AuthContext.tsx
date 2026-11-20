import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  signIn as amplifySignIn,
  signInWithRedirect,
  signUp as amplifySignUp,
  confirmSignUp as amplifyConfirmSignUp,
  resendSignUpCode,
  signOut as amplifySignOut,
  getCurrentUser,
  fetchUserAttributes,
  fetchAuthSession,
} from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";

/**
 * AuthContext mirrors the SocialGen pattern: a single provider owns the
 * "who is signed in" state, exposes thin wrappers around the Amplify v6
 * auth functions, and refreshes the current user after any state change.
 * Components read it through the useAuth() hook.
 */

export interface AuthUser {
  userId: string;
  username: string;
  email?: string;
  name?: string;
  /**
   * Whether this token lists the "Admins" Cognito group. Used ONLY to decide
   * whether to show the link to /admin - it's a UI convenience, not a
   * security check: anyone can edit client-side state, which is why the
   * real enforcement is the admin Lambda's own check of the verified token.
   */
  isAdmin: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  /** True until the initial "am I already signed in?" check resolves. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  /** Returns true if the account still needs email verification. */
  signUp: (
    email: string,
    password: string,
    name: string,
  ) => Promise<{ needsConfirmation: boolean }>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  resendCode: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const current = await getCurrentUser();
      let email: string | undefined;
      let name: string | undefined;
      try {
        const attrs = await fetchUserAttributes();
        email = attrs.email;
        name = attrs.name;
      } catch {
        // Attributes are best-effort; the session is still valid without them.
      }
      let isAdmin = false;
      try {
        // On the client the token payload is a real array (unlike what the
        // API Gateway authorizer hands the Lambda, which flattens it to a
        // string), so this is a proper membership check.
        const session = await fetchAuthSession();
        const groups =
          session.tokens?.idToken?.payload["cognito:groups"] ??
          session.tokens?.accessToken?.payload["cognito:groups"];
        isAdmin = Array.isArray(groups) && groups.includes("Admins");
      } catch {
        // Best-effort, like the attributes above: no link is the safe default.
      }
      setUser({
        userId: current.userId,
        username: current.username,
        email,
        name,
        isAdmin,
      });
    } catch {
      // getCurrentUser throws when there is no signed-in user.
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();

    // Google sign-in doesn't return through signIn() below - the browser
    // is redirected away to Cognito's Hosted UI, then Google, then back.
    // Amplify parses the ?code=... it lands with on page load and swaps it
    // for tokens *asynchronously*; Hub is how it tells the rest of the app
    // "that finished" (or failed), since there's no promise to await here.
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (
        payload.event === "signInWithRedirect" ||
        payload.event === "signInWithRedirect_failure"
      ) {
        void refresh();
      }
    });
    return unsubscribe;
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await amplifySignIn({ username: email, password });
      await refresh();
    },
    [refresh],
  );

  const signInWithGoogle = useCallback(async () => {
    // Navigates the whole page away to Cognito's Hosted UI - nothing after
    // this call runs until the browser comes back (see the Hub listener
    // above for what happens then).
    await signInWithRedirect({ provider: "Google" });
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, name: string) => {
      const { nextStep } = await amplifySignUp({
        username: email,
        password,
        options: { userAttributes: { email, name } },
      });
      return {
        needsConfirmation: nextStep.signUpStep === "CONFIRM_SIGN_UP",
      };
    },
    [],
  );

  const confirmSignUp = useCallback(async (email: string, code: string) => {
    await amplifyConfirmSignUp({ username: email, confirmationCode: code });
  }, []);

  const resendCode = useCallback(async (email: string) => {
    await resendSignUpCode({ username: email });
  }, []);

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      signIn,
      signInWithGoogle,
      signUp,
      confirmSignUp,
      resendCode,
      signOut,
    }),
    [
      user,
      loading,
      signIn,
      signInWithGoogle,
      signUp,
      confirmSignUp,
      resendCode,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return ctx;
}
