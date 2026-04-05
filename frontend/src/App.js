import React, { useState, useEffect, useRef } from "react";
import axios from "axios";

const BACKEND_URL = "https://accident-alert-app.onrender.com";

function speakAlert(message) {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.lang = "en-IN";
  utterance.rate = 0.9;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlambda = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dphi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlambda/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function dbscanCluster(points, eps, minPts) {
  const clusters = [];
  const visited = new Set();
  let clusterIdx = 0;
  const pointClusters = new Array(points.length).fill(-1);
  function getNeighbors(idx) {
    return points.reduce((acc, p, i) => {
      if (haversine(points[idx].latitude, points[idx].longitude, p.latitude, p.longitude) <= eps) acc.push(i);
      return acc;
    }, []);
  }
  for (let i = 0; i < points.length; i++) {
    if (visited.has(i)) continue;
    visited.add(i);
    const neighbors = getNeighbors(i);
    if (neighbors.length < minPts) continue;
    const cluster = new Set(neighbors);
    pointClusters[i] = clusterIdx;
    const queue = [...neighbors];
    while (queue.length > 0) {
      const q = queue.shift();
      if (!visited.has(q)) {
        visited.add(q);
        const qn = getNeighbors(q);
        if (qn.length >= minPts) qn.forEach(n => { if (!cluster.has(n)) { cluster.add(n); queue.push(n); } });
      }
      if (pointClusters[q] === -1) pointClusters[q] = clusterIdx;
    }
    clusters.push({ id: clusterIdx, points: [...cluster].map(idx => points[idx]), center: { latitude: points[i].latitude, longitude: points[i].longitude } });
    clusterIdx++;
  }
  return clusters;
}

function getRiskColor(count) {
  if (count >= 20) return { color: "#e74c3c", level: "HIGH", bg: "#fde8e8" };
  if (count >= 10) return { color: "#f39c12", level: "MEDIUM", bg: "#fef9e7" };
  if (count >= 5) return { color: "#e67e22", level: "LOW", bg: "#fef5ec" };
  return { color: "#3498db", level: "SAFE", bg: "#eaf4fb" };
}

const VEHICLE_ICONS = { car: "🚗", bike: "🏍️", dot: "🔵" };
const TABS = [
  { id: "map", label: "🗺️ Map" },
  { id: "heatmap", label: "🌡️ Heatmap" },
  { id: "analytics", label: "📊 Analytics" },
  { id: "hotspots", label: "⚠️ Hotspots" },
];

const btnStyle = {
  background: "rgba(0,0,0,0.6)", color: "white", border: "none",
  borderRadius: "8px", cursor: "pointer", fontSize: "16px",
  width: "40px", height: "40px", display: "flex",
  alignItems: "center", justifyContent: "center",
};
export default function App() {
  const [activeTab, setActiveTab] = useState("map");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [accidents, setAccidents] = useState([]);
  const [alert, setAlert] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [status, setStatus] = useState("Enter source and destination");
  const [vehicle, setVehicle] = useState("car");
  const [routePoints, setRoutePoints] = useState([]);
  const [clusters, setClusters] = useState([]);

  const mapRef = useRef(null);
  const heatmapRef = useRef(null);
  const leafletMap = useRef(null);
  const heatLeaflet = useRef(null);
  const routeLayerRef = useRef(null);
  const accidentLayersRef = useRef([]);
  const heatLayersRef = useRef([]);
  const userMarkerRef = useRef(null);
  const heatUserMarker = useRef(null);
  const simInterval = useRef(null);
  const simIndex = useRef(0);
  const alertedZonesRef = useRef(new Set());
  const currentPosRef = useRef({ lat: 12.9875, lng: 77.7400 });

  useEffect(() => {
    axios.get(`${BACKEND_URL}/accidents`)
      .then((res) => {
        const data = res.data.accidents || [];
        setAccidents(data);
        setStatus(`✅ Loaded ${res.data.count} accident records`);
        if (data.length > 0) {
          const sample = data.slice(0, 300);
          const clust = dbscanCluster(sample, 200, 3);
          setClusters(clust);
        }
      })
      .catch(() => setStatus("❌ Backend not connected!"));
  }, []);

  useEffect(() => {
    if (mapRef.current && !leafletMap.current && activeTab === "map") {
      setTimeout(() => {
        const L = window.L;
        if (!L || leafletMap.current) return;
        leafletMap.current = L.map(mapRef.current).setView([12.9875, 77.7400], 14);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap", maxZoom: 19,
        }).addTo(leafletMap.current);
      }, 100);
    }
  }, [activeTab]);

  useEffect(() => {
    if (heatmapRef.current && !heatLeaflet.current && activeTab === "heatmap") {
      setTimeout(() => {
        const L = window.L;
        if (!L || heatLeaflet.current) return;
        heatLeaflet.current = L.map(heatmapRef.current).setView([12.9875, 77.7400], 13);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap", maxZoom: 19,
        }).addTo(heatLeaflet.current);
        if (accidents.length > 0) drawHeatmap();
      }, 100);
    }
  }, [activeTab]);

  function drawHeatmap() {
    const L = window.L;
    if (!L || !heatLeaflet.current || accidents.length === 0) return;
    heatLayersRef.current.forEach(l => l.remove());
    heatLayersRef.current = [];
    const grid = {};
    accidents.forEach(acc => {
      const key = `${Math.round(acc.latitude * 100)}_${Math.round(acc.longitude * 100)}`;
      if (!grid[key]) grid[key] = { lat: acc.latitude, lng: acc.longitude, count: 0 };
      grid[key].count++;
    });
    Object.values(grid).forEach(cell => {
      const risk = getRiskColor(cell.count);
      const circle = L.circle([cell.lat, cell.lng], {
        color: risk.color, fillColor: risk.color,
        fillOpacity: 0.5, radius: 120, weight: 1,
      }).addTo(heatLeaflet.current)
        .bindPopup(`<b style="color:${risk.color}">⚠️ ${risk.level} RISK</b><br/>Incidents: ${cell.count}`);
      heatLayersRef.current.push(circle);
    });
  }

  useEffect(() => {
    if (heatLeaflet.current && accidents.length > 0) drawHeatmap();
  }, [accidents]);
  function updateUserOnMap(lat, lng, map, markerRef) {
    const L = window.L;
    if (!L || !map) return;
    if (markerRef.current) markerRef.current.remove();
    markerRef.current = L.marker([lat, lng], {
      icon: L.divIcon({
        html: `<div style="font-size:32px;filter:drop-shadow(2px 2px 3px rgba(0,0,0,0.5))">${VEHICLE_ICONS[vehicle]}</div>`,
        iconSize: [36, 36], iconAnchor: [18, 18], className: "",
      }), zIndexOffset: 1000,
    }).addTo(map).bindPopup("You are here");
    map.setView([lat, lng], 16);
  }

  async function checkNearby(lat, lon) {
    try {
      const res = await axios.post(`${BACKEND_URL}/check-nearby`, { lat, lon, radius: 500 });
      const hotspots = res.data.hotspots || [];
      if (hotspots.length > 0) {
        const nearest = hotspots[0];
        const zoneKey = `${Math.round(nearest.latitude * 1000)}_${Math.round(nearest.longitude * 1000)}`;
        if (!alertedZonesRef.current.has(zoneKey)) {
          alertedZonesRef.current.add(zoneKey);
          const risk = getRiskColor(hotspots.length);
          const alarmType = nearest.alarm_type || "";
          let message = "Caution! Accident prone area ahead in 500 meters. ";
          if (alarmType === "PCW") message += "Pedestrian crossing danger!";
          else if (alarmType === "Overspeed") message += "Overspeed zone. Reduce speed!";
          else if (alarmType === "FCW" || alarmType === "UFCW") message += "Collision zone. Be careful!";
          else if (alarmType === "HMW") message += "Maintain safe distance!";
          else if (alarmType === "LDWL" || alarmType === "LDWR") message += "Lane departure zone!";
          else message += "Drive carefully!";
          setAlert({ message, ward: nearest.ward_name, type: nearest.alarm_type, distance: nearest.distance, count: hotspots.length, risk });
          speakAlert(message);
          setTimeout(() => setAlert(null), 8000);
        }
      }
    } catch (e) { console.error(e); }
  }

  async function getRoute() {
    if (!source || !destination) { setStatus("⚠️ Enter source and destination!"); return; }
    setStatus("🔍 Finding route...");
    const L = window.L;
    try {
      const srcRes = await axios.get(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(source + ", Bangalore")}&format=json&limit=1`);
      const dstRes = await axios.get(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(destination + ", Bangalore")}&format=json&limit=1`);
      if (!srcRes.data.length || !dstRes.data.length) { setStatus("❌ Location not found!"); return; }
      const s = srcRes.data[0];
      const d = dstRes.data[0];
      const routeRes = await axios.get(`https://router.project-osrm.org/route/v1/driving/${s.lon},${s.lat};${d.lon},${d.lat}?overview=full&geometries=geojson`);
      const coords = routeRes.data.routes[0].geometry.coordinates;
      const points = coords.map(c => ({ lat: c[1], lng: c[0] }));
      setRoutePoints(points);
      if (routeLayerRef.current) routeLayerRef.current.remove();
      routeLayerRef.current = L.polyline(points.map(p => [p.lat, p.lng]), {
        color: "#4285F4", weight: 7, opacity: 0.9,
      }).addTo(leafletMap.current);
      leafletMap.current.fitBounds(routeLayerRef.current.getBounds(), { padding: [40, 40] });
      accidentLayersRef.current.forEach(m => m.remove());
      accidentLayersRef.current = [];
      const routeAcc = accidents.filter(acc =>
        points.some(p => haversine(p.lat, p.lng, acc.latitude, acc.longitude) <= 500)
      );
      routeAcc.forEach(acc => {
        const risk = getRiskColor(5);
        const c = L.circle([acc.latitude, acc.longitude], {
          color: risk.color, fillColor: risk.color, fillOpacity: 0.4, radius: 150, weight: 2,
        }).addTo(leafletMap.current)
          .bindPopup(`<b>⚠️ ${acc.alarm_type}</b><br/>Ward: ${acc.ward_name}`);
        accidentLayersRef.current.push(c);
      });
      setStatus(`✅ Route ready! ${routeAcc.length} accident zones on route.`);
    } catch (e) { setStatus("❌ Route error!"); }
  }

  function moveVehicle(dlat, dlng) {
    const newPos = { lat: currentPosRef.current.lat + dlat, lng: currentPosRef.current.lng + dlng };
    currentPosRef.current = newPos;
    if (leafletMap.current) updateUserOnMap(newPos.lat, newPos.lng, leafletMap.current, userMarkerRef);
    if (heatLeaflet.current) updateUserOnMap(newPos.lat, newPos.lng, heatLeaflet.current, heatUserMarker);
    checkNearby(newPos.lat, newPos.lng);
  }

  useEffect(() => {
    const step = 0.0005;
    const handleKey = (e) => {
      if (e.key === "ArrowUp") moveVehicle(step, 0);
      else if (e.key === "ArrowDown") moveVehicle(-step, 0);
      else if (e.key === "ArrowLeft") moveVehicle(0, -step);
      else if (e.key === "ArrowRight") moveVehicle(0, step);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [vehicle]);

  function startSimulation() {
    const points = routePoints.length > 0 ? routePoints : [
      { lat: 12.9845, lng: 77.7000 }, { lat: 12.9855, lng: 77.7100 },
      { lat: 12.9860, lng: 77.7200 }, { lat: 12.9865, lng: 77.7300 },
      { lat: 12.9870, lng: 77.7400 }, { lat: 12.9875, lng: 77.7441 },
      { lat: 12.9876, lng: 77.7440 }, { lat: 12.9880, lng: 77.7313 },
      { lat: 12.9882, lng: 77.7270 }, { lat: 12.9910, lng: 77.7270 },
    ];
    setSimulating(true);
    alertedZonesRef.current = new Set();
    simIndex.current = 0;
    setStatus("🎬 Demo running...");
    simInterval.current = setInterval(() => {
      if (simIndex.current >= points.length) {
        clearInterval(simInterval.current); setSimulating(false);
        setStatus("✅ Simulation complete!"); return;
      }
      const p = points[simIndex.current];
      currentPosRef.current = p;
      if (leafletMap.current) updateUserOnMap(p.lat, p.lng, leafletMap.current, userMarkerRef);
      if (heatLeaflet.current) updateUserOnMap(p.lat, p.lng, heatLeaflet.current, heatUserMarker);
      checkNearby(p.lat, p.lng);
      simIndex.current++;
    }, 1500);
  }

  function stopSimulation() {
    clearInterval(simInterval.current);
    setSimulating(false);
    setStatus("Stopped.");
  }

  function startTracking() {
    if (!navigator.geolocation) { setStatus("GPS not supported!"); return; }
    setTracking(true);
    alertedZonesRef.current = new Set();
    setStatus("🚗 GPS tracking...");
    navigator.geolocation.watchPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        currentPosRef.current = { lat: latitude, lng: longitude };
        if (leafletMap.current) updateUserOnMap(latitude, longitude, leafletMap.current, userMarkerRef);
        checkNearby(latitude, longitude);
      },
      err => setStatus("GPS error: " + err.message),
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
  }

  const wardCounts = accidents.reduce((acc, a) => { acc[a.ward_name] = (acc[a.ward_name] || 0) + 1; return acc; }, {});
  const alarmCounts = accidents.reduce((acc, a) => { acc[a.alarm_type] = (acc[a.alarm_type] || 0) + 1; return acc; }, {});
  const topWards = Object.entries(wardCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topAlarms = Object.entries(alarmCounts).sort((a, b) => b[1] - a[1]);
  const maxWard = topWards.length > 0 ? topWards[0][1] : 1;
  const maxAlarm = topAlarms.length > 0 ? topAlarms[0][1] : 1;
  return (
    <div style={{ fontFamily: "Arial, sans-serif", height: "100vh", display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ background: "#c0392b", color: "white", padding: "10px 16px", display: "flex", alignItems: "center", gap: "10px", boxShadow: "0 2px 6px rgba(0,0,0,0.3)" }}>
        <span style={{ fontSize: "26px" }}>🚨</span>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: "17px", fontWeight: "bold" }}>Accident Alert System</h2>
          <p style={{ margin: 0, fontSize: "11px", opacity: 0.85 }}>Urban Traffic Accident Hotspot Detection — Bangalore</p>
        </div>
        <div style={{ fontSize: "11px", opacity: 0.8, textAlign: "right" }}>
          <div>📊 {accidents.length} records</div>
          <div>🔴 {clusters.length} hotspots</div>
        </div>
      </div>                      

      {/* Tabs */}
      <div style={{ display: "flex", background: "white", borderBottom: "2px solid #e0e0e0" }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            style={{ flex: 1, padding: "10px 4px", border: "none", background: activeTab === tab.id ? "#c0392b" : "white", color: activeTab === tab.id ? "white" : "#555", fontWeight: activeTab === tab.id ? "bold" : "normal", cursor: "pointer", fontSize: "12px", borderBottom: activeTab === tab.id ? "3px solid #a93226" : "3px solid transparent" }}>
            {tab.label}
          </button>
        ))}
      </div>                                  

      {/* Alert */}
      {alert && (
        <div style={{ background: `linear-gradient(135deg, ${alert.risk.color}, #c0392b)`, color: "white", padding: "12px 16px", zIndex: 1000 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "32px" }}>⚠️</span>
            <div>
              <h3 style={{ margin: 0, fontSize: "14px" }}>🚨 {alert.risk.level} RISK — ACCIDENT ZONE AHEAD!</h3>
              <p style={{ margin: "3px 0 0", fontSize: "12px" }}>{alert.message}</p>
              <p style={{ margin: "2px 0 0", fontSize: "11px", opacity: 0.9 }}>
                📍 {alert.ward} | 🚨 {alert.type} | 📏 {alert.distance}m | ⚠️ {alert.count} incidents
              </p>
            </div>
          </div>
        </div>
      )}

      {/* TAB 1: MAP */}
      {activeTab === "map" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ background: "white", padding: "8px 12px", borderBottom: "1px solid #e0e0e0" }}>
            <div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}>
              <div style={{ flex: 1, position: "relative" }}>
                <span style={{ position: "absolute", left: "8px", top: "50%", transform: "translateY(-50%)" }}>📍</span>
                <input value={source} onChange={e => setSource(e.target.value)} placeholder="Source (e.g. Hudi)"
                  style={{ width: "100%", padding: "7px 7px 7px 26px", borderRadius: "6px", border: "1.5px solid #ccc", fontSize: "12px", boxSizing: "border-box" }} />
              </div>
              <div style={{ flex: 1, position: "relative" }}>
                <span style={{ position: "absolute", left: "8px", top: "50%", transform: "translateY(-50%)" }}>🎯</span>
                <input value={destination} onChange={e => setDestination(e.target.value)} placeholder="Destination (e.g. Kadugodi)"
                  style={{ width: "100%", padding: "7px 7px 7px 26px", borderRadius: "6px", border: "1.5px solid #ccc", fontSize: "12px", boxSizing: "border-box" }} />
              </div>
              <button onClick={getRoute} style={{ background: "#4285F4", color: "white", border: "none", padding: "7px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" }}>
                🗺️ Route
              </button>
            </div>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: "3px", background: "#f5f5f5", padding: "3px", borderRadius: "6px" }}>
                {[{ key: "car", label: "🚗" }, { key: "bike", label: "🏍️" }, { key: "dot", label: "🔵" }].map(v => (
                  <button key={v.key} onClick={() => setVehicle(v.key)}
                    style={{ background: vehicle === v.key ? "#c0392b" : "white", color: vehicle === v.key ? "white" : "#333", border: "1px solid #ddd", padding: "4px 10px", borderRadius: "5px", cursor: "pointer", fontSize: "14px" }}>
                    {v.label}
                  </button>
                ))}
              </div>
              <button onClick={startTracking} disabled={tracking}
                style={{ background: tracking ? "#95a5a6" : "#27ae60", color: "white", border: "none", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" }}>
                {tracking ? "🟢 Live" : "▶ Navigate"}
              </button>
              <button onClick={simulating ? stopSimulation : startSimulation}
                style={{ background: simulating ? "#e74c3c" : "#2980b9", color: "white", border: "none", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" }}>
                {simulating ? "⏹ Stop" : "🎬 Demo"}
              </button>
            </div>
            <p style={{ margin: "4px 0 0", fontSize: "10px", color: "#666" }}>📊 {status} | ⬆️⬇️⬅️➡️ arrow keys or buttons to move</p>
          </div>
          <div style={{ flex: 1, position: "relative" }}>
            <div ref={mapRef} style={{ width: "100%", height: "100%" }} />
            <div style={{ position: "absolute", bottom: "20px", right: "16px", zIndex: 999, display: "grid", gridTemplateColumns: "40px 40px 40px", gridTemplateRows: "40px 40px 40px", gap: "4px" }}>
              <div />
              <button onClick={() => moveVehicle(0.0005, 0)} style={btnStyle}>⬆️</button>
              <div />
              <button onClick={() => moveVehicle(0, -0.0005)} style={btnStyle}>⬅️</button>
              <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: "9px" }}>GO</div>
              <button onClick={() => moveVehicle(0, 0.0005)} style={btnStyle}>➡️</button>
              <div />
              <button onClick={() => moveVehicle(-0.0005, 0)} style={btnStyle}>⬇️</button>
              <div />
            </div>
          </div>
        </div>
      )} 

      {/* TAB 2: HEATMAP */}
      {activeTab === "heatmap" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ background: "white", padding: "8px 12px", borderBottom: "1px solid #e0e0e0", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
            <b style={{ fontSize: "12px" }}>🌡️ Risk:</b>
            {[{ color: "#e74c3c", label: "🔴 High (20+)" }, { color: "#f39c12", label: "🟡 Medium (10-19)" }, { color: "#e67e22", label: "🟠 Low (5-9)" }, { color: "#3498db", label: "🔵 Safe (1-4)" }].map(r => (
              <div key={r.label} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px" }}>
                <div style={{ width: "12px", height: "12px", borderRadius: "50%", background: r.color }} />{r.label}
              </div>
            ))}                              
          </div>
          <div ref={heatmapRef} style={{ flex: 1 }} />
        </div>
      )}                                               

      {/* TAB 3: ANALYTICS */}
      {activeTab === "analytics" && (
        <div style={{ flex: 1, overflow: "auto", padding: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ background: "white", borderRadius: "10px", padding: "14px", boxShadow: "0 1px 4px rgba(0,0,0,0.1)" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: "14px" }}>📊 Accidents by Ward</h3>
            {topWards.map(([ward, count]) => (
              <div key={ward} style={{ marginBottom: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "3px" }}>
                  <span>{ward}</span><span style={{ fontWeight: "bold", color: "#c0392b" }}>{count}</span>
                </div>
                <div style={{ background: "#f0f0f0", borderRadius: "4px", height: "18px" }}>
                  <div style={{ width: `${(count/maxWard)*100}%`, background: "linear-gradient(90deg,#c0392b,#e74c3c)", height: "100%", borderRadius: "4px" }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ background: "white", borderRadius: "10px", padding: "14px", boxShadow: "0 1px 4px rgba(0,0,0,0.1)" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: "14px" }}>🚨 Accidents by Alarm Type</h3>
            {topAlarms.map(([alarm, count]) => (
              <div key={alarm} style={{ marginBottom: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "3px" }}>
                  <span>{alarm}</span><span style={{ fontWeight: "bold", color: "#2980b9" }}>{count}</span>
                </div>
                <div style={{ background: "#f0f0f0", borderRadius: "4px", height: "18px" }}>
                  <div style={{ width: `${(count/maxAlarm)*100}%`, background: "linear-gradient(90deg,#2980b9,#3498db)", height: "100%", borderRadius: "4px" }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ background: "white", borderRadius: "10px", padding: "14px", boxShadow: "0 1px 4px rgba(0,0,0,0.1)" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: "14px" }}>🔵 Speed Distribution (Scatter)</h3>
            <div style={{ position: "relative", height: "160px", background: "#f9f9f9", borderRadius: "6px", border: "1px solid #e0e0e0", overflow: "hidden" }}>
              {accidents.slice(0, 200).map((acc, i) => {
                const colors = { PCW: "#e74c3c", Overspeed: "#f39c12", FCW: "#3498db", UFCW: "#2ecc71", HMW: "#9b59b6", LDWL: "#1abc9c", LDWR: "#e67e22" };
                const x = (i / 200) * 100;
                const y = 100 - ((acc.speed || 0) / 60) * 100;
                return (
                  <div key={i} title={`${acc.alarm_type} - ${acc.speed}km/h`}
                    style={{ position: "absolute", left: `${x}%`, top: `${y}%`, width: "6px", height: "6px", borderRadius: "50%", background: colors[acc.alarm_type] || "#95a5a6", opacity: 0.7 }} />
                );
              })}
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
              {[{ c: "#e74c3c", l: "PCW" }, { c: "#f39c12", l: "Overspeed" }, { c: "#3498db", l: "FCW" }, { c: "#2ecc71", l: "UFCW" }, { c: "#9b59b6", l: "HMW" }].map(x => (
                <div key={x.l} style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "11px" }}>
                  <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: x.c }} />{x.l}
                </div>
              ))}
            </div>
          </div>
          <div style={{ background: "white", borderRadius: "10px", padding: "14px", boxShadow: "0 1px 4px rgba(0,0,0,0.1)" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: "14px" }}>📈 Summary Statistics</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              {[
                { label: "Total Records", value: accidents.length, color: "#c0392b" },
                { label: "DBSCAN Hotspots", value: clusters.length, color: "#e74c3c" },
                { label: "Unique Wards", value: Object.keys(wardCounts).length, color: "#2980b9" },
                { label: "Alarm Types", value: Object.keys(alarmCounts).length, color: "#27ae60" },
                { label: "Avg Speed", value: accidents.length > 0 ? Math.round(accidents.reduce((a,b) => a+(b.speed||0),0)/accidents.length)+" km/h" : "N/A", color: "#f39c12" },
                { label: "Top Ward", value: topWards[0]?.[0] || "N/A", color: "#8e44ad" },
              ].map(s => (
                <div key={s.label} style={{ background: "#f9f9f9", borderRadius: "8px", padding: "10px", borderLeft: `4px solid ${s.color}` }}>
                  <div style={{ fontSize: "11px", color: "#888" }}>{s.label}</div>
                  <div style={{ fontSize: "15px", fontWeight: "bold", color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

       {/* TAB 4: HOTSPOTS */}
      {activeTab === "hotspots" && (
        <div style={{ flex: 1, overflow: "auto", padding: "12px" }}>
          <div style={{ background: "white", borderRadius: "10px", padding: "14px", boxShadow: "0 1px 4px rgba(0,0,0,0.1)" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: "14px" }}>🔴 DBSCAN Hotspot Clusters</h3>
            <p style={{ margin: "0 0 12px", fontSize: "11px", color: "#888" }}>Detected {clusters.length} accident hotspot zones</p>
            {clusters.slice(0, 20).map((cluster, i) => {
              const risk = getRiskColor(cluster.points.length);
              const alarmTypes = [...new Set(cluster.points.map(p => p.alarm_type))];
              const ward = cluster.points[0]?.ward_name || "Unknown";
              return (
                <div key={i} style={{ background: risk.bg, border: `1.5px solid ${risk.color}`, borderRadius: "8px", padding: "10px", marginBottom: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ background: risk.color, color: "white", borderRadius: "4px", padding: "2px 7px", fontSize: "11px", fontWeight: "bold" }}>{risk.level}</span>
                      <span style={{ marginLeft: "8px", fontSize: "13px", fontWeight: "bold" }}>Cluster #{i+1}</span>
                    </div>
                    <span style={{ fontSize: "13px", fontWeight: "bold", color: risk.color }}>{cluster.points.length} incidents</span>
                  </div>
                  <div style={{ marginTop: "6px", fontSize: "12px", color: "#555" }}>
                    <div>📍 Ward: {ward}</div>
                    <div>🚨 Types: {alarmTypes.join(", ")}</div>
                    <div>🗺️ {cluster.center.latitude.toFixed(4)}, {cluster.center.longitude.toFixed(4)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div> 
  );
}                                                             