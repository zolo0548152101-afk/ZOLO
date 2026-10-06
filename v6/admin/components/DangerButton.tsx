"use client";

import { useState } from "react";
import type { ActionResult } from "@/lib/actions";

export function DangerButton({
  label,
  phrase,
  phone,
  danger = true,
  description,
  action,
}: {
  label: string;
  phrase?: string;
  phone?: string;
  danger?: boolean;
  description: string;
  action: (phone: string, confirm: string) => Promise<ActionResult>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function run() {
    if (phrase && typed !== phrase) {
      setError(`יש להקליד במדויק: ${phrase}`);
      return;
    }
    setPending(true);
    setError("");
    const result = await action(phone ?? "", phrase ? typed : "ok");
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    setTyped("");
    window.location.reload();
  }

  return (
    <>
      <button type="button" className={danger ? "danger" : "secondary"} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <div className="modal-back" role="dialog" aria-modal="true">
          <div className="card modal stack">
            <h2>{label}</h2>
            <p>{description}</p>
            {phrase ? (
              <label>
                אישור
                <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={phrase} />
              </label>
            ) : null}
            {error ? <div className="notice error">{error}</div> : null}
            <div className="actions">
              <button type="button" className={danger ? "danger" : ""} onClick={run} disabled={pending}>
                {pending ? "מבצע…" : "אישור"}
              </button>
              <button type="button" className="secondary" onClick={() => setOpen(false)}>
                ביטול
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
