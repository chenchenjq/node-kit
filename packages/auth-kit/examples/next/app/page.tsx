import { AuthForms } from "auth-kit/react";

export default function SignInPage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "24px",
        background: "#f3f5f8",
      }}
    >
      <AuthForms />
    </main>
  );
}
