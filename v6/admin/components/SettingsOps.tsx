"use client";

import { useState } from "react";
import { DangerButton } from "@/components/DangerButton";
import { cancelPhone, clearAll, resetPhone } from "@/lib/actions";

export function SettingsOps() {
  const [phone, setPhone] = useState("");
  return (
    <>
      <section className="card stack">
        <h2>איפוס שיחה</h2>
        <p className="sub">השיחה חוזרת למצב בוט. הפניות וההיסטוריה נשמרות.</p>
        <label>
          טלפון
          <input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="052…" />
        </label>
        <div className="actions">
          <DangerButton
            label="אפס שיחה למספר"
            phone={phone}
            danger={false}
            description="לאפס את השיחה של המספר? רשומות הפניות נשמרות."
            action={resetPhone}
          />
          <DangerButton
            label="בטל פניות"
            phone={phone}
            phrase="בטל פניות"
            description="מוחק רק את הפניות וההודעות של המספר שהוקלד. הקלד את אישור הביטול."
            action={cancelPhone}
          />
        </div>
      </section>
      <section className="card stack">
        <h2>מחיקת כל הרשומות התפעוליות</h2>
        <p className="sub">מוחק פניות, הודעות, שיחות, אנשי קשר, שליחות ויומן. יישובים, רחובות והגדרות נשארים.</p>
        <DangerButton
          label="מחק הכל"
          phrase="מחק הכל"
          description="הפעולה מוחקת את כל נתוני התפעול. הקלד את אישור המחיקה."
          action={async (_phone, confirm) => clearAll(confirm)}
        />
      </section>
    </>
  );
}
