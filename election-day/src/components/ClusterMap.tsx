"use client";

import { useEffect } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import type { ClusterView } from "./ClusterTable";
import "leaflet/dist/leaflet.css";

function FitBounds({ clusters }: { clusters: ClusterView[] }) {
  const map = useMap();
  useEffect(() => {
    const pts = clusters.filter((c) => c.map_lat != null && c.map_lng != null);
    if (pts.length === 0) {
      map.setView([31.5, 34.75], 8);
      return;
    }
    const lats = pts.map((c) => c.map_lat!);
    const lngs = pts.map((c) => c.map_lng!);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)],
      ],
      { padding: [30, 30], maxZoom: 12 },
    );
  }, [clusters, map]);
  return null;
}

export function ClusterMap({ clusters }: { clusters: ClusterView[] }) {
  return (
    <div className="map-shell">
      <MapContainer
        center={[31.5, 34.75]}
        zoom={8}
        scrollWheelZoom
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds clusters={clusters} />
        {clusters
          .filter((c) => c.map_lat != null && c.map_lng != null)
          .map((c) => (
            <CircleMarker
              key={c.ashkol}
              center={[c.map_lat!, c.map_lng!]}
              radius={7}
              pathOptions={{
                color: "#1d4ed8",
                fillColor: "#3b82f6",
                fillOpacity: 0.85,
                weight: 1,
              }}
            >
              <Popup>
                <div className="popup" dir="rtl">
                  <strong>{c.settlement_name}</strong>
                  <div>אשכול {c.ashkol}</div>
                  <div>בז״ב: {c.bzb.toLocaleString("he-IL")}</div>
                  <div>מצביעים: {c.voters.toLocaleString("he-IL")}</div>
                  <div>כשרים: {c.valid.toLocaleString("he-IL")}</div>
                  <div>% הצבעה: {c.turnout_pct.toFixed(1)}%</div>
                  <div>קולות ימין: {c.right_votes.toLocaleString("he-IL")}</div>
                  <div>% ימין: {c.right_pct.toFixed(1)}%</div>
                </div>
              </Popup>
            </CircleMarker>
          ))}
      </MapContainer>
    </div>
  );
}
