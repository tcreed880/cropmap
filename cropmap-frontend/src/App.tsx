import {useEffect, useRef, useState} from "react";
import {Deck, Layer, PickingInfo} from "@deck.gl/core";
import {H3HexagonLayer} from "@deck.gl/geo-layers";
import maplibregl from "maplibre-gl";
import {CSVLoader} from "@loaders.gl/csv";
import {load} from "@loaders.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";

import {scaleLinear, scaleLog} from "d3-scale";
import {min, max, quantile, extent} from "d3-array";
import {interpolateViridis} from "d3-scale-chromatic";
import {rgb} from "d3-color";

// Recharts imports for mini line chart
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as ReTooltip,
  ResponsiveContainer,
  CartesianGrid
} from "recharts";

type CropDatum = {
  crop_id: number;
  area_ha: number;
  h3_id: string;
  mean_confidence: number;
  year: number;
};

type CropTotal = {
  crop_id: number;
  year: number;
  total_ha: number;
};

const CROP_MAP: Record<number, string> = {
  42: "Dry Beans",
  51: "Chickpeas",
  52: "Lentils",
  53: "Peas"
};

const MAP_STYLE = "assets/map_style_dark.json"; // loaded from /public
const hexPath = "data/pulses_conus_2008_2023_ha.csv";
const totalsPath = "data/crop_totals.csv";

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const deckCanvas = useRef<HTMLCanvasElement | null>(null);
  const deckRef = useRef<Deck | null>(null);

  const [data, setData] = useState<CropDatum[]>([]);
  const [filteredData, setFilteredData] = useState<CropDatum[]>([]);
  const [totals, setTotals] = useState<CropTotal[]>([]);
  const [colorScale, setColorScale] = useState<(v: number) => [number, number, number, number]>(
    () => (v: number) => [0, 0, 0, 255] as [number, number, number, number]
  );

  const [tooltip, setTooltip] = useState<{x: number; y: number; html: string} | null>(null);

  const [selectedCrop, setSelectedCrop] = useState<number>(42);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [yearRange, setYearRange] = useState<[number, number]>([2008, 2023]);
  const [isPlaying, setIsPlaying] = useState(false);
  const playInterval = useRef<NodeJS.Timeout | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [showPrecip, setShowPrecip] = useState(false);

  // ---- Load hex data ----
  useEffect(() => {
    async function fetchData() {
      const csv: any = await load(hexPath, CSVLoader);
      const parsed: CropDatum[] = csv.data.map((d: any) => ({
        crop_id: parseInt(d.crop_id),
        area_ha: parseFloat(d.area_ha || 0),
        h3_id: d.h3_id,
        mean_confidence: parseFloat(d.mean_confidence || 0),
        year: parseInt(d.year)
      }));

      const years = extent(parsed.map(d => d.year)) as [number, number];
      setYearRange(years);
      setSelectedYear(years[0]);

      const vals = parsed.map(d => d.area_ha).filter(v => v > 0);
      const minVal = min(vals) ?? 0;
      const maxVal = max(vals) ?? 1;
      const logVals = vals.map(v => Math.log10(v));
      const qLow = quantile(logVals, 0.2) ?? Math.log10(minVal || 1);
      const qHigh = quantile(logVals, 0.9999) ?? Math.log10(maxVal);
      const domainLow = 10 ** qLow;
      const domainHigh = 10 ** qHigh;
      const spread = Math.log10(maxVal) - Math.log10(minVal || 1);

      const baseScale =
        spread > 2
          ? scaleLog().domain([domainLow, domainHigh]).range([0, 1]).clamp(true)
          : scaleLinear().domain([domainLow, domainHigh]).range([0, 1]).clamp(true);

      const gamma = 1.1;
      const colorFn = (v: number): [number, number, number, number] => {
        const t = Math.pow(baseScale(v), gamma);
        const c = rgb(interpolateViridis(t));
        return [c.r, c.g, c.b, 255];
      };

      setColorScale(() => colorFn);
      setData(parsed);
    }
    fetchData();
  }, []);

  // ---- Load crop totals ----
  useEffect(() => {
    async function fetchTotals() {
      try {
        const csv: any = await load(totalsPath, CSVLoader);
        const parsed: CropTotal[] = csv.data.map((d: any) => ({
          crop_id: parseInt(d.crop_id),
          year: parseInt(d.year),
          total_ha: parseFloat(d.total_ha)
        }));
        setTotals(parsed);
      } catch (err) {
        console.warn("⚠️ No crop_totals.csv found, line chart will be hidden.");
      }
    }
    fetchTotals();
  }, []);

  // ---- Filter by crop + year ----
  useEffect(() => {
    if (data.length === 0 || selectedYear === null) return;
    const filtered = data.filter(d => d.crop_id === selectedCrop && d.year === selectedYear);
    setFilteredData(filtered);
  }, [data, selectedCrop, selectedYear]);

  // ---- Initialize MapLibre + DeckGL ----
  useEffect(() => {
    if (!mapContainer.current || !deckCanvas.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLE,
      center: [-100.5, 39],
      zoom: 4.1,
      pitch: 25,
      bearing: 0,
      attributionControl: false,
      maxBounds: [[-136, 22], [-58, 52]],
      minZoom: 3,
      maxZoom: 8
    });
    mapRef.current = map;

    const deck = new Deck({
      canvas: deckCanvas.current,
      controller: true,
      viewState: { longitude: -100.5, latitude: 39, zoom: 4.1, pitch: 25, bearing: 0 },
      onViewStateChange: ({viewState}) => {
        map.jumpTo({
          center: [viewState.longitude, viewState.latitude],
          zoom: viewState.zoom,
          pitch: viewState.pitch,
          bearing: viewState.bearing
        });
      }
    });
    deckRef.current = deck;

    // ✅ Add precip layer after map loads
    map.on("load", () => {
      if (!map.getSource("precip-static")) {
        map.addSource("precip-static", {
          type: "image",
          url: "data/precip.png",
          coordinates: [
            [-128.25, 49.34], // top-left
            [-63.94, 49.34],  // top-right
            [-63.94, 24.1],  // bottom-right
            [-128.25, 24.1]  // bottom-left
          ]

        });

        map.addLayer({
          id: "precip-layer",
          type: "raster",
          source: "precip-static",
          paint: { "raster-opacity": 0.40 },
          layout: { visibility: "none" }
        });
      }
    });

    // Keep DeckGL view synced with map
    map.on("move", () => {
      const center = map.getCenter();
      deck.setProps({
        viewState: {
          longitude: center.lng,
          latitude: center.lat,
          zoom: map.getZoom(),
          pitch: map.getPitch(),
          bearing: map.getBearing()
        }
      });
    });

    map.on("remove", () => deck.finalize());

    return () => {
      map.remove();
      deck.finalize();
    };
  }, []);


  // ---- Toggle precipitation layer visibility ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("precip-layer")) return;
    map.setLayoutProperty("precip-layer", "visibility", showPrecip ? "visible" : "none");
  }, [showPrecip]);


  // ---- Update DeckGL layers ----
  useEffect(() => {
    if (!deckRef.current) return;

    const hexLayer =
      filteredData.length > 0
        ? new H3HexagonLayer<CropDatum>({
            id: "pulses-layer",
            data: filteredData,
            getHexagon: d => d.h3_id,
            getFillColor: (d: CropDatum) => colorScale(d.area_ha),
            getElevation: d => d.area_ha / 0.05, // 🔧 scaled up for hectares
            elevationScale: 1,
            extruded: true,
            filled: true,
            stroked: false,
            pickable: true,
            coverage: 0.75,
            material: {
              ambient: 0.4,
              diffuse: 0.7,
              shininess: 25,
              specularColor: [50, 50, 50]
            },
            onHover: (info: PickingInfo) => {
              if (info.object) {
                const d = info.object as CropDatum;
                setTooltip({
                  x: info.x,
                  y: info.y,
                  html: `
                    <b>${CROP_MAP[d.crop_id]}</b><br/>
                    Year: ${d.year}<br/>
                    Area: ${d.area_ha.toLocaleString()} ha<br/>
                    Confidence: ${d.mean_confidence.toFixed(2)}
                  `
                });
              } else {
                setTooltip(null);
              }
            }
          })
        : null;

    deckRef.current.setProps({layers: hexLayer ? [hexLayer] : []});
  }, [filteredData, colorScale]);

  // ---- Play / Pause logic ----
  useEffect(() => {
    if (!isPlaying || selectedYear === null) return;

    playInterval.current = setInterval(() => {
      setSelectedYear(prev => {
        if (prev === null) return yearRange[0];
        return prev >= yearRange[1] ? yearRange[0] : prev + 1;
      });
    }, 1000);

    return () => {
      if (playInterval.current) clearInterval(playInterval.current);
    };
  }, [isPlaying, yearRange]);

  const togglePlay = () => setIsPlaying(prev => !prev);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        position: "relative",
        overflow: "hidden"
      }}
    >
      {/* Map */}
      <div ref={mapContainer} style={{width: "100%", height: "100%"}} />
      <canvas
        ref={deckCanvas}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%"
        }}
      />

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "absolute",
            pointerEvents: "none",
            left: tooltip.x + 10,
            top: tooltip.y + 10,
            background: "rgba(0,0,0,0.75)",
            color: "white",
            padding: "6px 10px",
            borderRadius: "6px",
            fontSize: "13px",
            lineHeight: "1.4",
            whiteSpace: "nowrap"
          }}
          dangerouslySetInnerHTML={{__html: tooltip.html}}
        />
      )}

      {/* Controls */}
      <div
        style={{
          position: "absolute",
          top: 15,
          left: 15,
          background: "rgba(0,0,0,0.7)",
          color: "white",
          padding: "10px 14px",
          borderRadius: "8px",
          fontSize: "14px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          width: "220px",
        }}
      >
        {/* Title */}
        <div
          style={{
            fontSize: "16px",
            fontWeight: 600,
            textAlign: "center",
            marginBottom: "-8px",
            letterSpacing: "0.3px",
          }}
        >
          US Pulse Crop Area
        </div>

        <label>
          Crop:
          <select
            value={selectedCrop}
            onChange={e => setSelectedCrop(parseInt(e.target.value))}
            style={{
              width: "100%",
              marginTop: "4px",
              background: "#222",
              color: "white",
              border: "1px solid #444",
              borderRadius: "4px",
              padding: "4px 6px",
            }}
          >
            {Object.entries(CROP_MAP).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>

        {/* Year slider + play/pause */}
        {yearRange && (
          <label>
            Year: <strong>{selectedYear}</strong>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "6px" }}>
              <input
                type="range"
                min={yearRange[0]}
                max={yearRange[1]}
                step={1}
                value={selectedYear ?? yearRange[0]}
                onChange={e => setSelectedYear(parseInt(e.target.value))}
                style={{ flexGrow: 1 }}
              />
              <button
                onClick={togglePlay}
                style={{
                  background: isPlaying ? "#c0392b" : "#27ae60",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  padding: "4px 8px",
                  cursor: "pointer"
                }}
              >
                {isPlaying ? "❚❚" : "▶"}
              </button>
            </div>
          </label>
        )}

        {/* Precip toggle */}
        <label style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
          <input
            type="checkbox"
            checked={showPrecip}
            onChange={() => setShowPrecip(prev => !prev)}
          />
          Mean Annual Precip
        </label>

        {/* Collapsible Data Sources */}
        <details
          style={{
            marginTop: "6px",
            background: "rgba(20,20,20,0.8)",
            borderRadius: "6px",
            padding: "8px 10px",
            fontSize: "10px",
            lineHeight: "1.45",
            color: "#ddd",
            cursor: "pointer"
          }}
        >
          <summary
            style={{
              color: "#f5f5f5",
              fontWeight: 600,
              fontSize: "12px",
              marginBottom: "4px",
              cursor: "pointer"
            }}
          >
            Data sources
          </summary>

          Crop area data sourced from USDA NASS Cropland Data Layer. CDL is produced from satellite imagery and extensive ground
          truth data. While CDL data align with harvest year, the map is more representative of what was planted. <br/><br/>
          *Chickpea CDL map data partially missing pre-2019, total hectares data is valid<br/><br/>
          <em>Area</em> = Total area (in hectares) classified as the given crop within the hex area. <br/><br/>
          <em>Confidence</em> = Mean per-pixel predicted confidence of the given classification over the hex area. <br/><br/>
          Precipitation data sourced from USFS Historical Annual Precipitation (1975-2005) image layer. <br/><br/>
          Total hectares harvested (line plot) data sourced from USDA NASS Quick Stats.
        </details>
      </div>


      

      {/* Mini line chart */}
      {totals.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 15,
            left: 15,
            background: "rgba(0,0,0,0.65)",
            padding: "10px 12px 14px 12px",
            borderRadius: "8px",
            width: "310px",
            height: "180px",
            color: "white",
            fontFamily: "sans-serif"
          }}
        >
          <div
            style={{
              fontSize: "12px",
              fontWeight: 600,
              textAlign: "center",
              marginBottom: "4px",
              color: "#dcdcdc",
              letterSpacing: "0.3px"
            }}
          >
            Total Hectares Harvested
          </div>

          <ResponsiveContainer width="100%" height="90%">
            <LineChart
              data={totals.filter(t => t.crop_id === selectedCrop)}
              margin={{ top: 5, right: 10, left: -30, bottom: 0 }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.1)" vertical={false} />
              <XAxis
                dataKey="year"
                stroke="#aaa"
                tick={{ fill: "#ccc", fontSize: 10 }}
                axisLine={false}
              />
              <YAxis
                stroke="#aaa"
                tick={{ fill: "#ccc", fontSize: 10 }}
                tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
              />
              <ReTooltip
                contentStyle={{
                  background: "rgba(0,0,0,0.8)",
                  border: "none",
                  color: "white",
                  fontSize: "12px"
                }}
                formatter={(value: number) => [`${value.toLocaleString()} ha`, "Area"]}
              />
              <Line
                type="monotone"
                dataKey="total_ha"
                stroke="#42f5e6"
                strokeWidth={2}
                isAnimationActive={false}  // 👈 add this line
                dot={({ cx, cy, payload }) => {
                  const isActive = payload.year === selectedYear;
                  return (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={isActive ? 5 : 3}
                      fill={isActive ? "#f5e642" : "#42f5e6"}
                      stroke={isActive ? "#fff" : "none"}
                      strokeWidth={isActive ? 1 : 0}
                    />
                  );
                }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Precip legend */}
      {showPrecip && (
        <div
          style={{
            position: "absolute",
            bottom: 15,
            right: 15,
            background: "rgba(0,0,0,0.7)",
            color: "white",
            padding: "10px 12px",
            borderRadius: "8px",
            fontSize: "11px",
            textAlign: "center",
            width: "200px",
            fontFamily: "sans-serif",
            boxShadow: "0 1px 6px rgba(0,0,0,0.45)"
          }}
        >
          <div
            style={{
              fontSize: "12px",
              fontWeight: 700,
              marginBottom: "6px"
            }}
          >
            Mean Annual Precipitation (mm)
          </div>

          {/* corrected color gradient */}
          <div
            style={{
              height: "14px",
              borderRadius: "3px",
              background:
                "linear-gradient(to right, #583125, #6A6B13, #4F6C11, #095B24, #0A1C42)"
            }}
          />

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: "4px",
              fontSize: "10px",
              color: "#ddd"
            }}
          >
            <span>{"<100"}</span>
            <span>350</span>
            <span>750</span>
            <span>950</span>
            <span>1500+</span>
          </div>
        </div>
      )}


    </div>
  );
}
