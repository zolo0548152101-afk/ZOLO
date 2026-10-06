"use client";

import { useState } from "react";
import { setAccess } from "@/lib/actions";

export function AccessForm({ mode, phones }: { mode: string; phones: string }) {
  const [current, setCurrent] = useState(mode === "allowlist" ? "allowlist" : "open");
  const [list, setList] = useState(phones);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    const result = await setAccess(current, list);
    if (!result.ok) setError(result.error);
    else setMessage("הגדרת הגישה נשמרה");
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="actions">
        <label>
          <span>
            <input
              type="radio"
              name="mode"
              checked={current === "open"}
              onChange={() => setCurrent("open")}
            />{" "}
            פתוח לכולם
          </span>
        </label>
        <label>
          <span>
            <input
              type="radio"
              name="mode"
              checked={current === "allowlist"}
              onChange={() => setCurrent("allowlist")}
            />{" "}
            פתוח רק למספרים שאגדיר
          </span>
        </label>
      </div>
      <label>
        מספרים מורשים
        <textarea rows={4} value={list} onChange={(event) => setList(event.target.value)} placeholder="מספר בכל שורה" />
      </label>
      <p className="sub">מספר שאינו ברשימה, כשהמצב הוא רשימה סגורה, לא מקבל תשובה מהבוט.</p>
      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice">{message}</div> : null}
      <button type="submit">שמור הגדרת גישה</button>
    </form>
  );
}
