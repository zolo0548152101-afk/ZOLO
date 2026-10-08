"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { ClusterTable, type ClusterView } from "./ClusterTable";

const ClusterMap = dynamic(
  () => import("./ClusterMap").then((m) => m.ClusterMap),
  { ssr: false, loading: () => <div className="map-shell map-loading">טוען מפה…</div> },
);

type SortKey =
  | "settlement_name"
  | "ashkol"
  | "bzb"
  | "voters"
  | "turnout_pct"
  | "right_pct"
  | "right_votes";

export function Dashboard() {
  const [minRight, setMinRight] = useState(70);
  const [maxTurnout, setMaxTurnout] = useState(60);
  const [sort, setSort] = useState<SortKey>("right_pct");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [clusters, setClusters] = useState<ClusterView[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({
        minRight: String(minRight),
        maxTurnout: String(maxTurnout),
        sort,
        dir,
      });
      const res = await fetch(`/api/clusters?${q}`);
      if (!res.ok) throw new Error(`שגיאת שרת ${res.status}`);
      const data = await res.json();
      setClusters(data.clusters);
      setCount(data.count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאה בטעינה");
    } finally {
      setLoading(false);
    }
  }, [minRight, maxTurnout, sort, dir]);

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  function onSort(key: SortKey) {
    if (key === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(key === "settlement_name" || key === "ashkol" ? "asc" : "desc");
    }
  }

  const withMap = clusters.filter((c) => c.map_lat != null).length;

  return (
    <div className="dash">
      <header className="hero">
        <div>
          <p className="eyebrow">ניהול יום בחירות</p>
          <h1>אשכולות לפי הצבעה וימין</h1>
          <p className="lede">
            סינון קיבוצי קלפיות: ימין (ט + מחל + שס + ג) ומדד הצבעה. הטבלה והמפה מסוננים יחד.
          </p>
        </div>
        <div className="stats">
          <div>
            <span className="stat-n">{loading ? "…" : count}</span>
            <span className="stat-l">אשכולות</span>
          </div>
          <div>
            <span className="stat-n">{loading ? "…" : withMap}</span>
            <span className="stat-l">על המפה</span>
          </div>
        </div>
      </header>

      <section className="filters">
        <label>
          מינימום % ימין
          <input
            type="range"
            min={0}
            max={100}
            value={minRight}
            onChange={(e) => setMinRight(Number(e.target.value))}
          />
          <input
            type="number"
            min={0}
            max={100}
            value={minRight}
            onChange={(e) => setMinRight(Number(e.target.value))}
          />
        </label>
        <label>
          מקסימום % הצבעה
          <input
            type="range"
            min={0}
            max={100}
            value={maxTurnout}
            onChange={(e) => setMaxTurnout(Number(e.target.value))}
          />
          <input
            type="number"
            min={0}
            max={100}
            value={maxTurnout}
            onChange={(e) => setMaxTurnout(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="reset"
          onClick={() => {
            setMinRight(70);
            setMaxTurnout(60);
          }}
        >
          ברירת מחדל 70 / 60
        </button>
      </section>

      {error && <p className="error">{error}</p>}

      <div className="split">
        <ClusterMap clusters={clusters} />
        <ClusterTable clusters={clusters} sort={sort} dir={dir} onSort={onSort} />
      </div>
    </div>
  );
}
