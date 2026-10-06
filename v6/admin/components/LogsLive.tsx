"use client";

import { useEffect, useState } from "react";
import type { LogRow } from "@/lib/logs";

function stamp(value: string) {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

export function LogsLive({ initial, query }: { initial: LogRow[]; query: string }) {
  const [rows, setRows] = useState(initial);
  const [auto, setAuto] = useState(true);
  const [pulse, setPulse] = useState("");

  useEffect(() => {
    setRows(initial);
  }, [initial]);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/logs${query}`, { cache: "no-store" });
      if (!response.ok) return;
      setRows((await response.json()) as LogRow[]);
      setPulse(new Date().toISOString());
    }, 5000);
    return () => clearInterval(timer);
  }, [auto, query]);

  return (
    <div className="stack">
      <label>
        <span>
          <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} /> רענון אוטומטי כל 5 שניות
        </span>
      </label>
      {pulse ? <p className="sub">עודכן {stamp(pulse)}</p> : null}
      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>זמן</th>
              <th>רמה</th>
              <th>אירוע</th>
              <th>טלפון</th>
              <th>פנייה</th>
              <th>הודעה</th>
              <th>פרטים</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>אין רשומות בטווח הזה</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>{stamp(row.ts)}</td>
                  <td>
                    <span className={row.level === "error" ? "tag error" : row.level === "warn" ? "tag warn" : "tag"}>
                      {row.level}
                    </span>
                  </td>
                  <td>{row.event}</td>
                  <td>
                    {row.phone ? <a href={`/?phone=${row.phone}`}>{row.phone}</a> : "—"}
                    {row.conversation_id ? (
                      <>
                        <br />
                        <a href={`/logs?conversation=${row.conversation_id}`}>ציר זמן</a>
                      </>
                    ) : null}
                  </td>
                  <td>{row.request_id ? <a href="/#database">פנייה</a> : "—"}</td>
                  <td dir="ltr">{row.waha_message_id ?? "—"}</td>
                  <td>
                    <pre>{JSON.stringify(row.details, null, 2)}</pre>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
