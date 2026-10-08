"use client";

export type ClusterView = {
  ashkol: string;
  settlement_name: string;
  bzb: number;
  voters: number;
  valid: number;
  right_votes: number;
  turnout_pct: number;
  right_pct: number;
  ballot_count: number;
  map_lat: number | null;
  map_lng: number | null;
};

type SortKey =
  | "settlement_name"
  | "ashkol"
  | "bzb"
  | "voters"
  | "turnout_pct"
  | "right_pct"
  | "right_votes";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "settlement_name", label: "יישוב" },
  { key: "ashkol", label: "אשכול" },
  { key: "bzb", label: "בז״ב" },
  { key: "voters", label: "מצביעים" },
  { key: "turnout_pct", label: "% הצבעה" },
  { key: "right_votes", label: "קולות ימין" },
  { key: "right_pct", label: "% ימין" },
];

export function ClusterTable({
  clusters,
  sort,
  dir,
  onSort,
}: {
  clusters: ClusterView[];
  sort: SortKey;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col.key}>
                <button type="button" className="th-btn" onClick={() => onSort(col.key)}>
                  {col.label}
                  {sort === col.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
                </button>
              </th>
            ))}
            <th>קלפיות</th>
            <th>מפה</th>
          </tr>
        </thead>
        <tbody>
          {clusters.map((c) => (
            <tr key={c.ashkol}>
              <td>{c.settlement_name}</td>
              <td className="mono">{c.ashkol}</td>
              <td>{c.bzb.toLocaleString("he-IL")}</td>
              <td>{c.voters.toLocaleString("he-IL")}</td>
              <td>{c.turnout_pct.toFixed(1)}%</td>
              <td>{c.right_votes.toLocaleString("he-IL")}</td>
              <td>{c.right_pct.toFixed(1)}%</td>
              <td>{c.ballot_count}</td>
              <td>{c.map_lat != null ? "כן" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {clusters.length === 0 && <p className="empty">אין אשכולות שעומדים בפילטרים.</p>}
    </div>
  );
}
