import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsLeftRight,
  Atom,
  CheckCircle,
  Clock,
  Database,
  Factory,
  Flame,
  Gauge,
  Info,
  Lightning,
  MapPin,
  ShieldCheck,
  Sun,
  Wind,
  X,
} from "@phosphor-icons/react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { validateNormalizedEnergyData } from "./data/energy-schema.mjs";

const MIX_META = {
  Atom: { className: "nuclear", icon: Atom, short: "Atom" },
  Nap: { className: "solar", icon: Sun, short: "Nap" },
  Fosszilis: { className: "fossil", icon: Flame, short: "Fosszilis" },
  "Egyéb megújuló": { className: "renewable", icon: Wind, short: "Megújuló" },
  Egyéb: { className: "other", icon: Factory, short: "Egyéb" },
};

const FLOW_POSITIONS = {
  AT: { left: "4%", top: "31%" },
  SK: { left: "47%", top: "2%" },
  UA: { right: "4%", top: "14%" },
  RO: { right: "2%", top: "52%" },
  RS: { left: "59%", bottom: "3%" },
  HR: { left: "25%", bottom: "3%" },
  SI: { left: "4%", bottom: "23%" },
};

const FLOW_ENDPOINTS = {
  AT: { x: 0.285, y: 0.45, bendX: 0, bendY: -0.04 },
  SK: { x: 0.51, y: 0.265, bendX: 0.02, bendY: 0 },
  UA: { x: 0.745, y: 0.34, bendX: 0, bendY: -0.035 },
  RO: { x: 0.748, y: 0.59, bendX: 0.025, bendY: 0 },
  RS: { x: 0.61, y: 0.765, bendX: 0.025, bendY: 0 },
  HR: { x: 0.405, y: 0.735, bendX: -0.02, bendY: 0 },
  SI: { x: 0.29, y: 0.625, bendX: 0, bendY: 0.035 },
};

const FLOW_LABEL = {
  AT: "Ausztria",
  SK: "Szlovákia",
  UA: "Ukrajna",
  RO: "Románia",
  RS: "Szerbia",
  HR: "Horvátország",
  SI: "Szlovénia",
};

const numberFormatter = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat("hu-HU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const publicAsset = (path) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;

function formatMW(value) {
  return Number.isFinite(value) ? numberFormatter.format(value) : "—";
}

function formatLocalTime(value, withDate = false) {
  return new Intl.DateTimeFormat("hu-HU", {
    timeZone: "Europe/Budapest",
    ...(withDate
      ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" }),
  }).format(new Date(value));
}

function ageInMinutes(value) {
  return Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
}

function useEnergyData() {
  const [state, setState] = useState({ status: "loading", data: null, error: null });

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async (initial = false) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const separator = publicAsset("data/energy-latest.json").includes("?") ? "&" : "?";
        const response = await fetch(`${publicAsset("data/energy-latest.json")}${separator}v=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = validateNormalizedEnergyData(await response.json());
        if (active) setState({ status: "ready", data, error: null });
      } catch (error) {
        if (active && initial) setState({ status: "error", data: null, error });
      } finally {
        inFlight = false;
      }
    };

    load(true);
    const timer = window.setInterval(() => load(false), 2 * 60_000);
    const onVisibilityChange = () => document.visibilityState === "visible" && load(false);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return state;
}

function LoadingScreen() {
  return (
    <div className="state-screen" role="status" aria-live="polite">
      <div className="state-mark"><Lightning size={24} weight="fill" /></div>
      <p>Az ellenőrzött energiaadatok betöltése…</p>
    </div>
  );
}

function ErrorScreen({ error }) {
  return (
    <div className="state-screen error" role="alert">
      <ShieldCheck size={30} />
      <h1>Az adatok nem jeleníthetők meg biztonságosan</h1>
      <p>A dashboard nem helyettesíti a hiányzó adatokat becsléssel. {error?.message}</p>
    </div>
  );
}

function RangeControl({ range, onChange }) {
  return (
    <div className="range-control" aria-label="Időtáv">
      <button className={range === "now" ? "active" : ""} onClick={() => onChange("now")}>MOST</button>
      <button className={range === "24h" ? "active" : ""} onClick={() => onChange("24h")}>24 ÓRA</button>
      <button disabled title="A hét napos, közvetlen forrás még nincs bekötve">7 NAP</button>
    </div>
  );
}

function Header({ data, range, onRangeChange, onOpenSources }) {
  const [, forceMinuteTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => forceMinuteTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const age = ageInMinutes(data.measuredAt);
  const stale = age > 30;

  return (
    <header className="topbar">
      <div className="brand-block">
        <div className="brand"><span>ENERGIA</span>TÉRKÉP</div>
        <div className="brand-subtitle">Magyarország villamosenergia-rendszere</div>
      </div>

      <div className="live-metrics">
        <div className="frequency" title="A hálózati frekvencia MAVIR-adatból">
          <Gauge size={20} />
          <strong>{data.system.frequencyHz.toFixed(3)}</strong><span>Hz</span>
        </div>
        <div className="measurement-time">
          <Clock size={18} />
          <span>{formatLocalTime(data.measuredAt, true)}</span>
        </div>
        <button className={`freshness ${stale ? "stale" : ""}`} onClick={onOpenSources}>
          <span className="status-dot" />
          {stale ? `ELAVULT · ${age} PERCE` : `MÉRT ADAT · ${age} PERCE`}
        </button>
      </div>

      <RangeControl range={range} onChange={onRangeChange} />
    </header>
  );
}

function GenerationMix({ data, selected, onSelect }) {
  const selectedMix = data.mix.find((item) => item.key === selected) ?? data.mix[0];

  return (
    <section className="panel generation-panel" aria-labelledby="generation-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">HAZAI TERMELÉS · FORRÁSMIX</span>
          <h1 id="generation-title">Mi termel most?</h1>
        </div>
        <div className="source-chip"><Database size={15} /> MAVIR</div>
      </div>

      <div className="generation-content">
        <div className="total-generation">
          <span>Összesen</span>
          <strong>{formatMW(data.system.generationMW)}</strong>
          <small>MW</small>
        </div>

        <div className="mix-visual">
          <div className="stacked-bar" aria-label="Hazai villamosenergia-termelés forrásonként">
            {data.mix.map((item) => {
              const meta = MIX_META[item.key];
              const width = data.system.generationMW > 0 ? Math.max((item.mw / data.system.generationMW) * 100, item.mw > 0 ? 1.2 : 0) : 0;
              return (
                <button
                  key={item.key}
                  className={`mix-segment ${meta.className} ${selected === item.key ? "selected" : ""}`}
                  style={{ width: `${width}%` }}
                  onClick={() => onSelect(item.key)}
                  title={`${item.key}: ${formatMW(item.mw)} MW`}
                  aria-label={`${item.key}: ${formatMW(item.mw)} megawatt`}
                />
              );
            })}
          </div>

          <div className="mix-legend">
            {data.mix.map((item) => {
              const meta = MIX_META[item.key];
              const Icon = meta.icon;
              const share = data.system.generationMW ? (item.mw / data.system.generationMW) * 100 : 0;
              return (
                <button
                  key={item.key}
                  className={`mix-item ${meta.className} ${selected === item.key ? "selected" : ""}`}
                  onClick={() => onSelect(item.key)}
                >
                  <Icon size={22} weight="duotone" />
                  <span><b>{meta.short}</b><strong>{formatMW(item.mw)} <small>MW</small></strong><em>{decimalFormatter.format(share)}%</em></span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="selection-note" aria-live="polite">
        <span className={`legend-dot ${MIX_META[selectedMix.key].className}`} />
        <strong>{selectedMix.key}</strong>
        <span>{formatMW(selectedMix.mw)} MW az utolsó érvényes mérési időpontban.</span>
      </div>
    </section>
  );
}

function BalancePanel({ data }) {
  const coverage = data.system.domesticCoveragePct;
  return (
    <section className="panel balance-panel" aria-labelledby="balance-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">RENDSZERMÉRLEG</span>
          <h2 id="balance-title">Termelés + import = fogyasztás</h2>
        </div>
        <span className="verified"><CheckCircle size={16} weight="fill" /> {data.quality.checksPassed}/{data.quality.checksTotal} ellenőrzés</span>
      </div>

      <div className="balance-metrics">
        <div><span>Fogyasztás</span><strong>{formatMW(data.system.consumptionMW)}</strong><small>MW</small></div>
        <div className="cyan"><span>Nettó import</span><strong>{formatMW(data.system.netImportMW)}</strong><small>MW</small></div>
        <div className="green"><span>Hazai fedezet</span><strong>{decimalFormatter.format(coverage)}</strong><small>%</small></div>
        <div className="green"><span>Alacsony karbon</span><strong>{decimalFormatter.format(data.system.lowCarbonSharePct)}</strong><small>% a hazai mixből</small></div>
      </div>

      <div className="balance-track" aria-label={`Hazai fedezet ${coverage} százalék`}>
        <span style={{ width: `${Math.min(100, coverage)}%` }} />
      </div>
      <p className="balance-copy">A fogyasztás {decimalFormatter.format(coverage)}%-át fedezte hazai termelés. A fennmaradó rész nettó importból érkezett.</p>
    </section>
  );
}

function FlowMarker({ flow, selected, onSelect }) {
  const imported = flow.direction === "import";
  return (
    <button
      className={`flow-marker ${imported ? "import" : "export"} ${selected ? "selected" : ""}`}
      data-code={flow.code}
      style={FLOW_POSITIONS[flow.code]}
      onClick={() => onSelect(flow.code)}
      onMouseEnter={() => onSelect(flow.code)}
      onFocus={() => onSelect(flow.code)}
      aria-label={`${flow.country}: ${imported ? "import" : "export"} ${formatMW(Math.abs(flow.mw))} megawatt`}
    >
      <span>{FLOW_LABEL[flow.code]}</span>
      <em>{imported ? "import" : "export"}</em>
      <strong>{formatMW(Math.abs(flow.mw))} <small>MW</small></strong>
      <ArrowsLeftRight size={18} weight="bold" />
    </button>
  );
}

function pointOnQuadratic(start, control, end, t) {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  };
}

function tangentOnQuadratic(start, control, end, t) {
  return {
    x: 2 * (1 - t) * (control.x - start.x) + 2 * t * (end.x - control.x),
    y: 2 * (1 - t) * (control.y - start.y) + 2 * t * (end.y - control.y),
  };
}

function AnimatedFlowLayer({ flows, selectedCode, stageRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return undefined;

    const context = canvas.getContext("2d");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame;
    let width = 0;
    let height = 0;

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const drawChevron = (point, tangent, color, alpha, scale) => {
      const angle = Math.atan2(tangent.y, tangent.x);
      context.save();
      context.translate(point.x, point.y);
      context.rotate(angle);
      context.globalAlpha = alpha;
      context.strokeStyle = color;
      context.lineWidth = 2.1 * scale;
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(-7 * scale, -5 * scale);
      context.lineTo(0, 0);
      context.lineTo(-7 * scale, 5 * scale);
      context.stroke();
      context.restore();
    };

    const render = (time = 0) => {
      context.clearRect(0, 0, width, height);
      const stageRect = stage.getBoundingClientRect();

      flows.forEach((flow) => {
        const marker = stage.querySelector(`[data-code="${flow.code}"]`);
        const endpoint = FLOW_ENDPOINTS[flow.code];
        if (!marker || !endpoint) return;
        const markerRect = marker.getBoundingClientRect();
        const outer = {
          x: markerRect.left - stageRect.left + markerRect.width / 2,
          y: markerRect.top - stageRect.top + markerRect.height / 2,
        };
        const inner = { x: endpoint.x * width, y: endpoint.y * height };
        const imported = flow.direction === "import";
        const start = imported ? outer : inner;
        const end = imported ? inner : outer;
        const control = {
          x: (start.x + end.x) / 2 + endpoint.bendX * width,
          y: (start.y + end.y) / 2 + endpoint.bendY * height,
        };
        const selected = selectedCode === flow.code;
        const color = imported ? "#f49a43" : "#40d8dc";

        context.save();
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.quadraticCurveTo(control.x, control.y, end.x, end.y);
        context.strokeStyle = color;
        context.globalAlpha = selected ? 0.78 : 0.32;
        context.lineWidth = selected ? 3 : 1.5;
        context.shadowColor = color;
        context.shadowBlur = selected ? 14 : 5;
        context.stroke();
        context.restore();

        const duration = Math.max(1.7, 3.6 - Math.min(Math.abs(flow.mw) / 1400, 1.5));
        const particleCount = selected ? 6 : 4;
        for (let index = 0; index < particleCount; index += 1) {
          const progress = reducedMotion ? (index + 1) / (particleCount + 1) : ((time / 1000 / duration) + index / particleCount) % 1;
          const point = pointOnQuadratic(start, control, end, progress);
          const tangent = tangentOnQuadratic(start, control, end, progress);
          drawChevron(point, tangent, color, selected ? 1 : 0.72, selected ? 1.08 : 0.82);
        }
      });

      if (!reducedMotion) frame = window.requestAnimationFrame(render);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    frame = window.requestAnimationFrame(render);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [flows, selectedCode, stageRef]);

  return <canvas ref={canvasRef} className="flow-canvas" aria-hidden="true" />;
}

function PlantMarker({ plant, selected, onSelect }) {
  const left = 17 + plant.x * 0.66;
  const top = 3 + plant.y * 0.86;
  const Icon = plant.type === "nuclear" ? Atom : Factory;
  return (
    <button
      className={`plant-marker ${plant.type} ${selected ? "selected" : ""}`}
      data-plant={plant.key}
      style={{ left: `${left}%`, top: `${top}%` }}
      onClick={() => onSelect(plant.key)}
      aria-label={`${plant.name}${Number.isFinite(plant.mw) ? `: ${plant.mw} megawatt` : ": nincs külön élő adat"}`}
    >
      <span className="plant-icon"><Icon size={18} weight="fill" /></span>
      <b>{plant.name}</b>
      <small>{Number.isFinite(plant.mw) ? `${formatMW(plant.mw)} MW` : "létesítmény"}</small>
    </button>
  );
}

function EnergyMap({ data }) {
  const [selection, setSelection] = useState({ type: "flow", key: "SK" });
  const stageRef = useRef(null);
  const selectedFlow = data.flows.find((flow) => flow.code === selection.key);
  const selectedPlant = data.plants.find((plant) => plant.key === selection.key);
  const selectedLabel = selectedFlow
    ? `${selectedFlow.country}: ${selectedFlow.direction === "import" ? "behozatal" : "kivitel"} ${formatMW(Math.abs(selectedFlow.mw))} MW`
    : selectedPlant
      ? `${selectedPlant.name}: ${Number.isFinite(selectedPlant.mw) ? `${formatMW(selectedPlant.mw)} MW` : "nincs külön élő teljesítményadat"}`
      : "Válassz egy áramlást vagy erőművet";

  return (
    <section className="panel map-panel" aria-labelledby="map-title">
      <div className="map-heading">
        <div>
          <span className="eyebrow">AKTUÁLIS ENERGIATÉRKÉP</span>
          <h2 id="map-title">Erőművek és határkeresztező áramlások</h2>
        </div>
        <div className="map-legend">
          <span><i className="legend-dot renewable" /> erőmű</span>
          <span><i className="legend-line import" /> import</span>
          <span><i className="legend-line export" /> export</span>
        </div>
      </div>

      <div className="map-stage" ref={stageRef} data-testid="energy-map-stage">
        <div className="map-hint">Vidd rá az egeret egy országra vagy erőműre</div>
        <img src={publicAsset("assets/hungary-map-blank.png")} alt="Magyarország térképe a fő vízrajzi elemekkel" className="map-base" />
        <AnimatedFlowLayer flows={data.flows} selectedCode={selection.type === "flow" ? selection.key : null} stageRef={stageRef} />
        {data.flows.map((flow) => (
          <FlowMarker
            key={flow.code}
            flow={flow}
            selected={selection.type === "flow" && selection.key === flow.code}
            onSelect={(key) => setSelection({ type: "flow", key })}
          />
        ))}
        {data.plants.map((plant) => (
          <PlantMarker
            key={plant.key}
            plant={plant}
            selected={selection.type === "plant" && selection.key === plant.key}
            onSelect={(key) => setSelection({ type: "plant", key })}
          />
        ))}
        <div className="solar-cluster cluster-west" title="Napenergia-régió"><Sun size={18} weight="fill" /></div>
        <div className="solar-cluster cluster-center" title="Napenergia-régió"><Sun size={18} weight="fill" /></div>
        <div className="solar-cluster cluster-east" title="Napenergia-régió"><Sun size={18} weight="fill" /></div>

        <div className="map-inspector" aria-live="polite">
          <MapPin size={17} weight="fill" />
          <span>{selectedLabel}</span>
        </div>
      </div>
    </section>
  );
}

function HistoryTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{formatLocalTime(label)}</strong>
      {payload.map((item) => <span key={item.dataKey} style={{ color: item.color }}>{item.name}: {formatMW(item.value)} MW</span>)}
    </div>
  );
}

function TrendCard({ data, range }) {
  const chartData = useMemo(() => data.history24h.map((item) => ({ ...item, timeLabel: item.time })), [data]);
  return (
    <section className="analytics-card trend-card" aria-labelledby="trend-title">
      <div className="card-heading">
        <div><span className="eyebrow">TERHELÉS</span><h3 id="trend-title">Rendszeregyensúly · {range === "24h" ? "24 óra" : "legutóbbi nap"}</h3></div>
        <span className="unit">MW</span>
      </div>
      <div className="chart-legend">
        <span className="load">Fogyasztás</span><span className="generation">Hazai termelés</span><span className="imports">Nettó import</span>
      </div>
      <div className="history-chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid stroke="#243544" strokeDasharray="2 5" vertical={false} />
            <XAxis dataKey="timeLabel" tickFormatter={(value) => formatLocalTime(value)} minTickGap={42} tick={{ fill: "#8194a4", fontSize: 10 }} axisLine={{ stroke: "#334453" }} tickLine={false} />
            <YAxis tick={{ fill: "#8194a4", fontSize: 10 }} axisLine={false} tickLine={false} width={48} />
            <Tooltip content={<HistoryTooltip />} />
            <Area type="monotone" dataKey="loadMW" name="Fogyasztás" stroke="#36d7dc" fill="#36d7dc" fillOpacity={0.08} strokeWidth={2} />
            <Area type="monotone" dataKey="generationMW" name="Hazai termelés" stroke="#e3c354" fill="#e3c354" fillOpacity={0.05} strokeWidth={1.8} />
            <Area type="monotone" dataKey="importMW" name="Nettó import" stroke="#53a7ff" fill="#53a7ff" fillOpacity={0.04} strokeWidth={1.6} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function PriceCard({ data }) {
  const available = data.market.status === "available";
  const headline = data.market.current?.eurMWh ?? data.market.nextDay?.averageEurMWh ?? null;
  const headlineLabel = data.market.current ? "AKTUÁLIS DAM-IDŐSZAK" : "HOLNAPI DAM-ÁTLAG";
  const unavailableLabel = data.market.status === "unavailable_missing_entsoe_token"
    ? "ENTSO-E API-KULCS SZÜKSÉGES"
    : "A HIVATALOS FEED ÁTMENETILEG NEM ELÉRHETŐ";
  return (
    <section className="analytics-card price-card">
      <div className="card-heading"><div><span className="eyebrow">TŐZSDEI ÁR</span><h3>Magyar másnapi piaci ár</h3></div><span className="unit">EUR/MWh</span></div>
      <strong className={`price-value ${available ? "" : "unavailable"}`}>{headline === null ? "—" : decimalFormatter.format(headline)}</strong>
      <span className={`availability ${available ? "available" : ""}`}>{available ? headlineLabel : unavailableLabel}</span>
      {data.market.nextDay && <div className="data-line"><span>Holnapi átlag</span><b>{decimalFormatter.format(data.market.nextDay.averageEurMWh)} EUR/MWh</b></div>}
      {data.market.nextDay && <div className="data-line compact"><span>Holnapi sáv</span><b>{decimalFormatter.format(data.market.nextDay.minEurMWh)}–{decimalFormatter.format(data.market.nextDay.maxEurMWh)}</b></div>}
      <div className="data-line"><span>Forrás</span><b>{data.source.price}</b></div>
      {!available && <p>Közvetítőből származó árat nem közlünk; az érték csak a hivatalos ENTSO-E A44 feedből jelenhet meg.</p>}
    </section>
  );
}

function ImportCard({ data }) {
  const importShare = 100 - data.system.domesticCoveragePct;
  return (
    <section className="analytics-card import-card">
      <div className="card-heading"><div><span className="eyebrow">IMPORTKITETTSÉG</span><h3>Nettó import / fogyasztás</h3></div><ArrowsLeftRight size={19} /></div>
      <strong className="large-metric">{decimalFormatter.format(importShare)}%</strong>
      <div className="import-track"><span style={{ width: `${Math.min(100, importShare)}%` }} /></div>
      <div className="scale"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
      <p>{formatMW(data.system.netImportMW)} MW nettó behozatal.</p>
    </section>
  );
}

function CarbonCard({ data }) {
  const emissions = data.annualEmissions;
  const changeIsReduction = emissions.changePct < 0;
  return (
    <section className="analytics-card carbon-card">
      <div className="card-heading"><div><span className="eyebrow">KIBOCSÁTÁS</span><h3>Alacsony karbonú termelés</h3></div><ShieldCheck size={19} /></div>
      <strong className="large-metric low-carbon-value">{decimalFormatter.format(data.system.lowCarbonSharePct)}%</strong>
      <span className="availability available">KÖZVETLEN MAVIR-MIXBŐL</span>
      <div className="data-line"><span>{emissions.latest.year} leltár</span><b>{decimalFormatter.format(emissions.latest.valueMt)} Mt CO₂e</b></div>
      <div className="data-line compact"><span>Változás {emissions.previous.year}-hoz</span><b className={changeIsReduction ? "reduction" : "increase"}>{changeIsReduction ? "−" : "+"}{decimalFormatter.format(Math.abs(emissions.changePct))}%</b></div>
      <p>Az éves adat a közüzemi villamosenergia- és hőtermelés országos leltára; nem pillanatnyi karbonintenzitás.</p>
    </section>
  );
}

function SourcesDrawer({ data, onClose }) {
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="sources-drawer" role="dialog" aria-modal="true" aria-labelledby="sources-title">
        <button className="drawer-close" onClick={onClose} aria-label="Bezárás"><X size={20} /></button>
        <span className="eyebrow">ADATFORRÁSOK ÉS MÓDSZERTAN</span>
        <h2 id="sources-title">Minden számnak legyen gazdája</h2>
        <p>Csak olyan pillanatképet publikálunk, amely minden kötelező ellenőrzésen átment. Hiányzó értéket nem töltünk ki becsléssel vagy közvetítői adattal.</p>

        <div className="source-list">
          <div><Database size={20} /><span><b>Terhelés és termelési mix</b><small>{data.source.primary} · 20001-es diagram</small></span></div>
          <div><ArrowsLeftRight size={20} /><span><b>Határkeresztező áramlások</b><small>{data.source.primary} · 5229-es diagram</small></span></div>
          <div><Lightning size={20} /><span><b>Hálózati frekvencia</b><small>{data.source.primary} · 4444-es diagram</small></span></div>
          <div><Lightning size={20} /><span><b>Piaci ár</b><small>{data.source.price} · A44 · {data.market.status === "available" ? "elérhető" : "jelenleg nincs közölve"}</small></span></div>
          <div><ShieldCheck size={20} /><span><b>Éves kibocsátási leltár</b><small>{data.source.annualEmissions} · IPCC 1.A.1.a · {data.annualEmissions.latest.year}</small></span></div>
        </div>

        <div className="quality-box">
          <div><span>Forrásmix összege</span><b>{data.quality.mixGapMW.toFixed(1)} MW eltérés</b></div>
          <div><span>Határáramlások</span><b>{data.quality.flowGapMW.toFixed(1)} MW eltérés</b></div>
          <div><span>Rendszermérleg</span><b>{data.quality.systemGapMW.toFixed(1)} MW ismert rés</b></div>
          <div><span>Feedek időeltérése</span><b>legfeljebb {data.quality.maxFeedOffsetMinutes.toFixed(1)} perc</b></div>
          <div><span>Kihagyott előzetes sorok</span><b>{data.quality.provisionalRowsSkipped} db</b></div>
          <div><span>Kötelező ellenőrzések</span><b>{data.quality.checksPassed}/{data.quality.checksTotal} sikeres</b></div>
        </div>

        <div className="timestamp-box">
          <Clock size={18} />
          <span><b>Mért adat:</b> {formatLocalTime(data.measuredAt, true)}<br /><b>Pillanatkép készült:</b> {formatLocalTime(data.generatedAt, true)}</span>
        </div>

        <p className="caveat">{data.source.caveat} A Paks-érték a teljes magyar nukleáris, a Mátra-érték a teljes lignit kategóriából következik.</p>
        <a href={data.source.systemUrl} target="_blank" rel="noreferrer">MAVIR hivatalos rendszeradatok</a>
      </aside>
    </div>
  );
}

export function App() {
  const { status, data, error } = useEnergyData();
  const [range, setRange] = useState("now");
  const [selectedMix, setSelectedMix] = useState("Atom");
  const [sourcesOpen, setSourcesOpen] = useState(false);

  if (status === "loading") return <LoadingScreen />;
  if (status === "error") return <ErrorScreen error={error} />;

  return (
    <div className="dashboard-shell">
      <Header data={data} range={range} onRangeChange={setRange} onOpenSources={() => setSourcesOpen(true)} />
      <main>
        <div className="hero-grid">
          <GenerationMix data={data} selected={selectedMix} onSelect={setSelectedMix} />
          <BalancePanel data={data} />
        </div>
        <EnergyMap data={data} />
        <div className="analytics-grid">
          <TrendCard data={data} range={range} />
          <PriceCard data={data} />
          <ImportCard data={data} />
          <CarbonCard data={data} />
        </div>
      </main>

      <footer>
        <span><Info size={16} /> Tájékoztató rendszerpillanatkép · nem helyettesíti a MAVIR hivatalos publikációját.</span>
        <button onClick={() => setSourcesOpen(true)}>Adatforrások és módszertan</button>
      </footer>

      {sourcesOpen && <SourcesDrawer data={data} onClose={() => setSourcesOpen(false)} />}
    </div>
  );
}
