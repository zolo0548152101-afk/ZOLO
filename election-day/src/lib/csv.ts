import type { ClusterView } from "@/components/ClusterTable";

const HEADERS = [
  "יישוב",
  "אשכול",
  "בזב",
  "מצביעים",
  "כשרים",
  "קולות_ימין",
  "אחוז_הצבעה",
  "אחוז_ימין",
  "קלפיות",
] as const;

function escapeCell(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function clustersToCsv(clusters: ClusterView[]): string {
  const lines = [
    HEADERS.join(","),
    ...clusters.map((c) =>
      [
        c.settlement_name,
        c.ashkol,
        c.bzb,
        c.voters,
        c.valid,
        c.right_votes,
        c.turnout_pct,
        c.right_pct,
        c.ballot_count,
      ]
        .map(escapeCell)
        .join(","),
    ),
  ];
  // BOM so Excel opens Hebrew correctly
  return `\uFEFF${lines.join("\n")}`;
}

export function downloadClustersCsv(clusters: ClusterView[], filename: string) {
  const blob = new Blob([clustersToCsv(clusters)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
