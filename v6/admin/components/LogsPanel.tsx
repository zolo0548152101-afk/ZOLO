"use client";

import { useEffect, useState } from "react";
import { LogsLive } from "./LogsLive";
import type { LogRow } from "@/lib/logs";

const levels = ["", "debug", "info", "warn", "error"];
const events = ["", "inbound", "outbound", "db_update", "rejected_update", "escalation", "error", "agent_note"];

export function LogsPanel({ conversation = "" }: { conversation?: string }) {
  const [phone, setPhone] = useState("");
  const [level, setLevel] = useState("");
  const [event, setEvent] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [query, setQuery] = useState(conversation ? `?conversation=${encodeURIComponent(conversation)}` : "");

  async function load(next?: { phone: string; level: string; event: string; from: string; to: string; conversation: string }) {
    const filters = next ?? { phone, level, event, from, to, conversation };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    setQuery(suffix);
    const response = await fetch(`/api/logs${suffix}`, { cache: "no-store" });
    if (response.ok) setRows((await response.json()) as LogRow[]);
  }

  useEffect(() => {
    void load();
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="stack">
      <form
        className="filters"
        onSubmit={(eventObject) => {
          eventObject.preventDefault();
          void load();
        }}
      >
        <label>
          טלפון
          <input value={phone} onChange={(eventObject) => setPhone(eventObject.target.value)} inputMode="tel" placeholder="052…" />
        </label>
        <label>
          רמה
          <select value={level} onChange={(eventObject) => setLevel(eventObject.target.value)}>
            {levels.map((item) => <option key={item || "all"} value={item}>{item || "הכול"}</option>)}
          </select>
        </label>
        <label>
          אירוע
          <select value={event} onChange={(eventObject) => setEvent(eventObject.target.value)}>
            {events.map((item) => <option key={item || "all"} value={item}>{item || "הכול"}</option>)}
          </select>
        </label>
        <label>
          מ־
          <input type="datetime-local" value={from} onChange={(eventObject) => setFrom(eventObject.target.value)} />
        </label>
        <label>
          עד
          <input type="datetime-local" value={to} onChange={(eventObject) => setTo(eventObject.target.value)} />
        </label>
        <button type="submit">סנן</button>
      </form>
      <LogsLive initial={rows} query={query} />
    </div>
  );
}
