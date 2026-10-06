import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const links = [
  ["/", "לוח"],
  ["/#database", "מסד"],
  ["/#logs", "יומן"],
  ["/logs", "סינון יומן"],
];

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return (
    <>
      <header className="top">
        <div>
          <h1>חיים יחד · מרכז ניהול</h1>
          <div className="sub">V6 · תפעול, הובלות וסימולציות</div>
        </div>
        <nav>
          {links.map(([href, label]) => (
            <a key={href} href={href}>{label}</a>
          ))}
        </nav>
        <div className="badge">מצב: V6</div>
        <form action="/api/logout" method="post">
          <button className="secondary" type="submit">יציאה</button>
        </form>
      </header>
      <main>{children}</main>
    </>
  );
}
