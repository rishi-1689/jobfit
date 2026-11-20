import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import AuthLayout, {
  ErrorText,
  Field,
  SubmitButton,
} from "../components/AuthLayout";

/**
 * Two-step flow:
 *   1. "details"  - collect name/email/password, call signUp.
 *   2. "confirm"  - Cognito has emailed a 6-digit code; collect it and
 *                   call confirmSignUp, then send the user to /login.
 */
type Stage = "details" | "confirm";

export default function Signup() {
  const { signUp, confirmSignUp, resendCode } = useAuth();
  const navigate = useNavigate();

  const [stage, setStage] = useState<Stage>("details");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleDetails(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { needsConfirmation } = await signUp(email, password, name);
      if (needsConfirmation) {
        setNotice(`We emailed a verification code to ${email}.`);
        setStage("confirm");
      } else {
        navigate("/login");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await confirmSignUp(email, code);
      navigate("/login", {
        replace: true,
        state: { justConfirmed: true },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    setError(null);
    try {
      await resendCode(email);
      setNotice(`New code sent to ${email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend code");
    }
  }

  if (stage === "confirm") {
    return (
      <AuthLayout title="Verify your email">
        <form onSubmit={handleConfirm}>
          <ErrorText message={error} />
          {notice && <p className="mb-4 text-sm text-slate-500">{notice}</p>}
          <Field
            label="Verification code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <SubmitButton disabled={busy}>
            {busy ? "Verifying…" : "Verify"}
          </SubmitButton>
        </form>
        <button
          type="button"
          onClick={handleResend}
          className="mt-4 text-sm font-medium text-violet-600 hover:text-violet-800"
        >
          Resend code
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      footer={
        <>
          Already have an account?{" "}
          <Link className="font-medium text-violet-600 hover:text-violet-800" to="/login">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleDetails}>
        <ErrorText message={error} />
        <Field
          label="Name"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <SubmitButton disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}
