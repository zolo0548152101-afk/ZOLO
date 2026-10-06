"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setPending(false);
    if (!response.ok) {
      setError("הסיסמה שגויה");
      return;
    }
    window.location.href = "/";
  }

  return (
    <main className="login-wrap">
      <form className="card stack" onSubmit={onSubmit}>
        <div>
          <h1>חיים יחד · מרכז ניהול</h1>
          <p className="sub">סיסמת ניהול. אחרי ההתחברות היא נשמרת בעוגייה חתומה בשרת, לא בדפדפן.</p>
        </div>
        <label>
          סיסמת ניהול
          <input
            type="password"
            autoComplete="current-password"
            placeholder="הזן את סיסמת הניהול"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error ? <div className="notice error">{error}</div> : null}
        <button type="submit" disabled={pending}>
          {pending ? "בודק…" : "התחבר"}
        </button>
      </form>
    </main>
  );
}
