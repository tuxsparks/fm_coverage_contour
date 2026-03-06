(() => {
  "use strict";

  const EARTH_RADIUS_KM = 6371;
  const KM_PER_MILE = 1.609344;
  const MI2_PER_KM2 = 0.386102159;
  const MAX_BATCH_POINTS = 1000;
  const BATCH_CHUNK_SIZE = 120;
  const THEME_STORAGE_KEY = "fmCoverageTheme";

  const state = {
    map: null,
    stationLayer: null,
    boosterLayer: null,
    stationMarker: null,
    boosterMarker: null,
    lastResult: null,
    lastBatchResult: null
  };

  const elements = {
    form: document.getElementById("station-form"),
    formMessage: document.getElementById("formMessage"),
    themeToggleBtn: document.getElementById("themeToggleBtn"),
    mapEl: document.getElementById("map"),
    exportKmlBtn: document.getElementById("exportKmlBtn"),
    stationLocationText: document.getElementById("stationLocationText"),
    boosterLocationText: document.getElementById("boosterLocationText"),
    patternType: document.getElementById("patternType"),
    customPatternWrap: document.getElementById("customPatternWrap"),
    customPattern: document.getElementById("customPattern"),
    patternStrengthDb: document.getElementById("patternStrengthDb"),
    patternStrengthValue: document.getElementById("patternStrengthValue"),
    obstructionType: document.getElementById("obstructionType"),
    useBooster: document.getElementById("useBooster"),
    boosterFields: document.getElementById("boosterFields"),
    batchLocations: document.getElementById("batchLocations"),
    batchUseBaseObstruction: document.getElementById("batchUseBaseObstruction"),
    batchGreatPct: document.getElementById("batchGreatPct"),
    batchStrongPct: document.getElementById("batchStrongPct"),
    batchSuburbanEdgePct: document.getElementById("batchSuburbanEdgePct"),
    batchUrbanEdgePct: document.getElementById("batchUrbanEdgePct"),
    batchDenseUrbanEdgePct: document.getElementById("batchDenseUrbanEdgePct"),
    batchSuburbanPenalty: document.getElementById("batchSuburbanPenalty"),
    batchUrbanPenalty: document.getElementById("batchUrbanPenalty"),
    batchDenseUrbanPenalty: document.getElementById("batchDenseUrbanPenalty"),
    runBatchBtn: document.getElementById("runBatchBtn"),
    exportBatchCsvBtn: document.getElementById("exportBatchCsvBtn"),
    batchSummary: document.getElementById("batchSummary"),
    batchMessage: document.getElementById("batchMessage"),
    batchCount: document.getElementById("batchCount"),
    batchReachable: document.getElementById("batchReachable"),
    batchMedianMargin: document.getElementById("batchMedianMargin"),
    batchWorstMargin: document.getElementById("batchWorstMargin"),
    batchLists: document.getElementById("batchLists"),
    batchCoveredTitle: document.getElementById("batchCoveredTitle"),
    batchNotCoveredTitle: document.getElementById("batchNotCoveredTitle"),
    batchCoveredNames: document.getElementById("batchCoveredNames"),
    batchNotCoveredNames: document.getElementById("batchNotCoveredNames"),
    stationRadius: document.getElementById("stationRadius"),
    stationArea: document.getElementById("stationArea"),
    boosterRadius: document.getElementById("boosterRadius"),
    boosterArea: document.getElementById("boosterArea")
  };

  const antennaMultipliers = {
    circular: 1.0,
    panel: 1.08,
    slot: 1.03,
    horizontal: 0.93,
    vertical: 0.9
  };

  const obstructionProfiles = {
    open: { baseLossDb: 0, varianceDb: 0 },
    // Calibrated per field feedback: rural should be lighter than suburban.
    rural: { baseLossDb: 0.2, varianceDb: 0.7 },
    // Calibrated per field feedback: treat suburban like rural/light trees.
    suburban: { baseLossDb: 0.5, varianceDb: 1.2 },
    // Calibrated per field feedback: urban should behave like light trees/rural.
    urban: { baseLossDb: 0.9, varianceDb: 1.8 },
    // Calibrated per field feedback: dense urban should behave like suburban.
    denseUrban: { baseLossDb: 2.4, varianceDb: 3.2 }
  };

  const defaultCoverageBandRatios = {
    greatMax: 1 / 3,
    strongMax: 2 / 3,
    moderateMax: 1
  };

  const defaultEdgeCountRatios = {
    open: 1.0,
    rural: 1.0,
    suburban: 0.96,
    urban: 0.88,
    denseUrban: 0.8
  };

  const defaultCoveragePenalties = {
    open: 0,
    rural: 0,
    suburban: 0,
    urban: 1,
    denseUrban: 2
  };

  const coverageStatusOrder = ["great", "strong", "moderate", "notCovered"];

  function initializeMap() {
    if (state.map || typeof L === "undefined") {
      if (typeof L === "undefined") {
        elements.formMessage.textContent = "Map library did not load. You can still generate contours and export KML.";
      }
      return;
    }

    state.map = L.map(elements.mapEl, { zoomControl: true }).setView([39.5, -98.35], 4);

    const tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors"
    });

    tileLayer.on("tileerror", () => {
      elements.formMessage.textContent = "Basemap tiles failed to load, but contour geometry is still generated.";
    });

    tileLayer.addTo(state.map);
    L.control.scale({ metric: false, imperial: true }).addTo(state.map);
  }

  function detectPreferredTheme() {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "dark" || saved === "light") {
        return saved;
      }
    } catch {
      // Ignore localStorage access issues and fall back to OS preference.
    }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme) {
    const normalized = theme === "dark" ? "dark" : "light";
    document.body.dataset.theme = normalized;
    if (!elements.themeToggleBtn) {
      return;
    }
    const isDark = normalized === "dark";
    elements.themeToggleBtn.textContent = isDark ? "Light Mode" : "Dark Mode";
    elements.themeToggleBtn.setAttribute("aria-pressed", isDark ? "true" : "false");
  }

  function onToggleTheme() {
    const current = document.body.dataset.theme === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore localStorage write failures.
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function toRad(value) {
    return (value * Math.PI) / 180;
  }

  function toDeg(value) {
    return (value * 180) / Math.PI;
  }

  function normalizeAngle(angle) {
    return ((angle % 360) + 360) % 360;
  }

  function shortestAngleDifference(a, b) {
    return ((a - b + 540) % 360) - 180;
  }

  function destinationPoint(lat, lon, bearingDeg, distanceKm) {
    const angularDistance = distanceKm / EARTH_RADIUS_KM;
    const bearing = toRad(bearingDeg);
    const lat1 = toRad(lat);
    const lon1 = toRad(lon);

    const sinLat2 = Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing);
    const lat2 = Math.asin(sinLat2);

    const lon2 = lon1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

    const normalizedLon = ((toDeg(lon2) + 540) % 360) - 180;
    return [toDeg(lat2), normalizedLon];
  }

  function haversineKm(a, b) {
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const dLat = lat2 - lat1;
    const dLon = toRad(b[1] - a[1]);

    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function polygonAreaKm2(points) {
    if (!points || points.length < 3) {
      return 0;
    }

    let latSum = 0;
    for (const [lat] of points) {
      latSum += lat;
    }
    const latRef = toRad(latSum / points.length);

    const projected = points.map(([lat, lon]) => {
      const x = EARTH_RADIUS_KM * toRad(lon) * Math.cos(latRef);
      const y = EARTH_RADIUS_KM * toRad(lat);
      return [x, y];
    });

    let area = 0;
    for (let i = 0; i < projected.length; i += 1) {
      const [x1, y1] = projected[i];
      const [x2, y2] = projected[(i + 1) % projected.length];
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area) / 2;
  }

  function estimateBaseRadiusKm(erpW, towerHeightM, mode, antennaType) {
    const erpRatio = Math.max(erpW, 1) / 250;
    const heightRatio = Math.max(towerHeightM, 1) / 247;
    const powerScale = Math.pow(erpRatio, 0.29);
    const heightScale = Math.pow(heightRatio, 0.33);
    const modeMultiplier = mode === "hd" ? 0.86 : 1.0;
    const antennaMultiplier = antennaMultipliers[antennaType] || 1.0;

    // Calibrated so 250W @ 247m is approximately 12 miles in omni analog mode.
    const estimatedMiles = 12 * powerScale * heightScale * modeMultiplier * antennaMultiplier;
    return clamp(estimatedMiles * KM_PER_MILE, 1.6, 145);
  }

  function parseCustomPatternTable(text) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const rawPoints = [];

    for (const line of lines) {
      if (line.startsWith("#")) {
        continue;
      }
      const parts = line.split(/[,:\s]+/).filter(Boolean);
      if (parts.length < 2) {
        continue;
      }
      const azimuth = normalizeAngle(Number(parts[0]));
      const gainDb = Number(parts[1]);
      if (!Number.isFinite(azimuth) || !Number.isFinite(gainDb)) {
        continue;
      }
      rawPoints.push({ azimuth, radiusFactor: Math.pow(10, gainDb / 20) });
    }

    if (rawPoints.length < 2) {
      return null;
    }

    rawPoints.sort((a, b) => a.azimuth - b.azimuth);
    const mean = rawPoints.reduce((sum, point) => sum + point.radiusFactor, 0) / rawPoints.length;
    return rawPoints.map((point) => ({
      azimuth: point.azimuth,
      radiusFactor: point.radiusFactor / mean
    }));
  }

  function interpolatedCustomFactor(points, azimuth) {
    if (!points || points.length === 0) {
      return 1;
    }

    const sorted = points.slice().sort((a, b) => a.azimuth - b.azimuth);
    const first = sorted[0];
    const extended = sorted.concat([{ azimuth: first.azimuth + 360, radiusFactor: first.radiusFactor }]);
    let angle = normalizeAngle(azimuth);
    if (angle < first.azimuth) {
      angle += 360;
    }

    for (let i = 0; i < extended.length - 1; i += 1) {
      const a = extended[i];
      const b = extended[i + 1];
      if (angle >= a.azimuth && angle <= b.azimuth) {
        const span = Math.max(b.azimuth - a.azimuth, 0.000001);
        const t = (angle - a.azimuth) / span;
        const factor = a.radiusFactor + t * (b.radiusFactor - a.radiusFactor);
        return clamp(factor, 0.2, 2.2);
      }
    }
    return 1;
  }

  function directionalFactor(azimuth, patternType, strengthDb, customPatternTable) {
    if (patternType === "omni") {
      return 1;
    }

    if (patternType === "custom") {
      return interpolatedCustomFactor(customPatternTable, azimuth);
    }

    const ratio = Math.pow(10, strengthDb / 20);
    const minFactor = 1 / Math.max(1, ratio);
    let phase = 0;
    let shape = "cardioid";

    if (patternType === "cardioidNorth") {
      phase = 0;
    } else if (patternType === "cardioidEast") {
      phase = 90;
    } else if (patternType === "figure8NS") {
      phase = 0;
      shape = "figure8";
    } else if (patternType === "figure8EW") {
      phase = 90;
      shape = "figure8";
    }

    const diff = toRad(shortestAngleDifference(azimuth, phase));
    const unit = shape === "figure8" ? Math.cos(diff) ** 2 : (1 + Math.cos(diff)) / 2;
    const value = minFactor + (1 - minFactor) * unit;
    return clamp(value, 0.15, 2.2);
  }

  function initialBearingDeg(a, b) {
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const lonDiff = toRad(b[1] - a[1]);
    const y = Math.sin(lonDiff) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(lonDiff);
    return normalizeAngle(toDeg(Math.atan2(y, x)));
  }

  function obstructionLossDb(obstructionType, bearing, centerLat, centerLon) {
    const profile = obstructionProfiles[obstructionType] || obstructionProfiles.open;
    if (profile.baseLossDb <= 0 && profile.varianceDb <= 0) {
      return 0;
    }

    const angle = toRad(normalizeAngle(bearing));
    const seedA = toRad(normalizeAngle(centerLat * 13.37 + centerLon * 4.29));
    const seedB = toRad(normalizeAngle(centerLat * -7.11 + centerLon * 9.73));
    const wave =
      0.5 +
      0.24 * Math.sin(angle * 2.1 + seedA) +
      0.18 * Math.cos(angle * 3.9 + seedB) +
      0.08 * Math.sin(angle * 7.7 + seedA * 0.35);
    const directionalLoss = clamp(wave, 0, 1);
    return profile.baseLossDb + profile.varianceDb * directionalLoss;
  }

  function obstructionDistanceFactor(obstructionType, bearing, centerLat, centerLon) {
    const lossDb = obstructionLossDb(obstructionType, bearing, centerLat, centerLon);
    const factor = Math.pow(10, -lossDb / 20);
    return clamp(factor, 0.08, 1);
  }

  function effectiveRadiusKm(
    baseRadiusKm,
    bearing,
    patternType,
    strengthDb,
    customPatternTable,
    obstructionType,
    centerLat,
    centerLon
  ) {
    const dirFactor = directionalFactor(bearing, patternType, strengthDb, customPatternTable);
    const obstructionFactor = obstructionDistanceFactor(obstructionType, bearing, centerLat, centerLon);
    return baseRadiusKm * dirFactor * obstructionFactor;
  }

  function buildContour(
    centerLat,
    centerLon,
    baseRadiusKm,
    patternType,
    strengthDb,
    customPatternTable,
    obstructionType
  ) {
    const points = [];
    for (let bearing = 0; bearing < 360; bearing += 3) {
      const radius = effectiveRadiusKm(
        baseRadiusKm,
        bearing,
        patternType,
        strengthDb,
        customPatternTable,
        obstructionType,
        centerLat,
        centerLon
      );
      points.push(destinationPoint(centerLat, centerLon, bearing, radius));
    }
    return points;
  }

  function contourStats(points, center) {
    const distances = points.map((point) => haversineKm(center, point));
    const minRadius = Math.min(...distances);
    const maxRadius = Math.max(...distances);
    const avgRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length;
    return {
      minRadius,
      maxRadius,
      avgRadius,
      areaKm2: polygonAreaKm2(points)
    };
  }

  function kmToMiles(valueKm) {
    return valueKm / KM_PER_MILE;
  }

  function formatMiles(valueKm) {
    return `${kmToMiles(valueKm).toFixed(1)} mi`;
  }

  function formatArea(valueKm2) {
    return `${Math.round(valueKm2 * MI2_PER_KM2).toLocaleString()} mi²`;
  }

  function asValidNumber(input, label, limits) {
    const value = Number(input);
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a valid number.`);
    }
    if (limits && Number.isFinite(limits.min) && value < limits.min) {
      throw new Error(`${label} must be at least ${limits.min}.`);
    }
    if (limits && Number.isFinite(limits.max) && value > limits.max) {
      throw new Error(`${label} must be at most ${limits.max}.`);
    }
    return value;
  }

  function asIntegerWithin(input, label, limits) {
    const value = asValidNumber(input, label, limits);
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be a whole number.`);
    }
    return value;
  }

  function isNumericToken(value) {
    return /^[+-]?\d+(?:\.\d+)?$/.test(String(value ?? "").trim());
  }

  function normalizeObstructionType(rawType, fallbackType = "open") {
    const fallback = obstructionProfiles[fallbackType] ? fallbackType : "open";
    const raw = String(rawType ?? "").trim();
    if (!raw) {
      return fallback;
    }
    const normalized = raw.toLowerCase().replace(/[\s_-]+/g, "");
    const aliases = {
      clear: "open",
      flat: "open",
      none: "open",
      open: "open",
      rural: "rural",
      suburb: "suburban",
      suburban: "suburban",
      city: "urban",
      urban: "urban",
      dense: "denseUrban",
      downtown: "denseUrban",
      metro: "denseUrban",
      denseurban: "denseUrban"
    };
    const mapped = aliases[normalized];
    if (!mapped || !obstructionProfiles[mapped]) {
      throw new Error(`Unknown obstruction type "${raw}". Use open, rural, suburban, urban, or denseUrban.`);
    }
    return mapped;
  }

  function obstructionDisplayLabel(obstructionType) {
    const labels = {
      open: "open",
      rural: "rural",
      suburban: "suburban",
      urban: "urban",
      denseUrban: "denseUrban"
    };
    return labels[obstructionType] || "open";
  }

  function parseCoordinateComponent(rawValue, axis) {
    const raw = String(rawValue ?? "").trim();
    if (!raw) {
      throw new Error(`${axis === "lat" ? "Latitude" : "Longitude"} coordinate is empty.`);
    }

    const upper = raw.toUpperCase();
    const hasN = upper.includes("N");
    const hasS = upper.includes("S");
    const hasE = upper.includes("E");
    const hasW = upper.includes("W");

    if (axis === "lat" && (hasE || hasW)) {
      throw new Error("Latitude cannot include E/W hemisphere.");
    }
    if (axis === "lon" && (hasN || hasS)) {
      throw new Error("Longitude cannot include N/S hemisphere.");
    }
    if (hasN && hasS) {
      throw new Error("Coordinate hemisphere cannot contain both N and S.");
    }
    if (hasE && hasW) {
      throw new Error("Coordinate hemisphere cannot contain both E and W.");
    }

    let hemisphereSign = null;
    if (hasN || hasE) {
      hemisphereSign = 1;
    } else if (hasS || hasW) {
      hemisphereSign = -1;
    }

    const parts = upper
      .replace(/[NSEW]/g, " ")
      .replace(/[°ºD]/g, " ")
      .replace(/[′’'M]/g, " ")
      .replace(/[″”"]/g, " ")
      .replace(/[,:;]/g, " ")
      .replace(/[^\d+\-. ]+/g, " ")
      .match(/[+-]?\d+(?:\.\d+)?/g);

    if (!parts || parts.length === 0 || parts.length > 3) {
      throw new Error(`Could not parse ${axis === "lat" ? "latitude" : "longitude"} coordinate.`);
    }

    const values = parts.map((value) => Number(value));
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(`Invalid ${axis === "lat" ? "latitude" : "longitude"} value.`);
    }

    const degreesRaw = values[0];
    const degreesAbs = Math.abs(degreesRaw);
    const minutes = values.length >= 2 ? Math.abs(values[1]) : 0;
    const seconds = values.length >= 3 ? Math.abs(values[2]) : 0;

    if (minutes >= 60 || seconds >= 60) {
      throw new Error("Minutes and seconds must be less than 60.");
    }

    let sign = degreesRaw < 0 ? -1 : 1;
    if (hemisphereSign !== null) {
      if (degreesRaw < 0 && hemisphereSign > 0) {
        throw new Error("Coordinate sign conflicts with hemisphere direction.");
      }
      sign = hemisphereSign;
    }

    const decimal = (degreesAbs + minutes / 60 + seconds / 3600) * sign;
    const limits = axis === "lat"
      ? { min: -90, max: 90, label: "Latitude" }
      : { min: -180, max: 180, label: "Longitude" };
    return asValidNumber(decimal, limits.label, { min: limits.min, max: limits.max });
  }

  function parseCoordinatePair(rawValue, label) {
    const raw = String(rawValue ?? "").trim();
    if (!raw) {
      throw new Error(`${label} is empty.`);
    }

    const segmented = raw.toUpperCase()
      .replace(/([NSEW])/g, "$1|")
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);

    let latPart = null;
    let lonPart = null;
    for (const part of segmented) {
      if (!latPart && /[NS]/.test(part)) {
        latPart = part;
      }
      if (!lonPart && /[EW]/.test(part)) {
        lonPart = part;
      }
    }

    if (latPart && lonPart) {
      return {
        lat: parseCoordinateComponent(latPart, "lat"),
        lon: parseCoordinateComponent(lonPart, "lon")
      };
    }

    const commaParts = raw.split(",").map((part) => part.trim()).filter(Boolean);
    if (commaParts.length === 2) {
      return {
        lat: parseCoordinateComponent(commaParts[0], "lat"),
        lon: parseCoordinateComponent(commaParts[1], "lon")
      };
    }

    const simpleParts = raw.match(/[+-]?\d+(?:\.\d+)?/g);
    if (simpleParts && simpleParts.length === 2) {
      return {
        lat: asValidNumber(simpleParts[0], "Latitude", { min: -90, max: 90 }),
        lon: asValidNumber(simpleParts[1], "Longitude", { min: -180, max: 180 })
      };
    }

    throw new Error(`${label} must look like 39°06'59.2"N 84°30'06.8"W or 39.116444, -84.501889.`);
  }

  function parseLocationField(rawValue, label, latInput, lonInput) {
    const raw = String(rawValue ?? "").trim();
    if (!raw) {
      return null;
    }
    const parsed = parseCoordinatePair(raw, label);
    latInput.value = parsed.lat.toFixed(6);
    lonInput.value = parsed.lon.toFixed(6);
    return parsed;
  }

  function parseBatchTargets(rawValue, defaultObstructionType, forceBaseObstruction = false) {
    const rawLines = String(rawValue ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    if (rawLines.length === 0) {
      throw new Error("Batch list is empty. Add at least one town/city row.");
    }
    if (rawLines.length > MAX_BATCH_POINTS) {
      throw new Error(`Batch list supports up to ${MAX_BATCH_POINTS.toLocaleString()} rows.`);
    }

    const targets = [];
    let autoIndex = 1;

    for (let idx = 0; idx < rawLines.length; idx += 1) {
      const line = rawLines[idx];
      const lineNo = idx + 1;
      const parts = line.split(/[,\t;]+/).map((part) => part.trim()).filter(Boolean);
      if (parts.length < 2) {
        throw new Error(`Batch line ${lineNo} is not valid.`);
      }

      let name = "";
      let latRaw = "";
      let lonRaw = "";
      let obstructionRaw = "";

      if (parts.length >= 3 && isNumericToken(parts[1]) && isNumericToken(parts[2])) {
        name = parts[0];
        latRaw = parts[1];
        lonRaw = parts[2];
        obstructionRaw = parts[3] || "";
      } else if (isNumericToken(parts[0]) && isNumericToken(parts[1])) {
        name = `Town ${autoIndex}`;
        latRaw = parts[0];
        lonRaw = parts[1];
        obstructionRaw = parts[2] || "";
      } else {
        throw new Error(`Batch line ${lineNo} must be "name,lat,lon[,obstruction]" or "lat,lon[,obstruction]".`);
      }

      const lat = asValidNumber(latRaw, `Batch line ${lineNo} latitude`, { min: -90, max: 90 });
      const lon = asValidNumber(lonRaw, `Batch line ${lineNo} longitude`, { min: -180, max: 180 });
      const rowObstructionType = forceBaseObstruction
        ? normalizeObstructionType(defaultObstructionType, defaultObstructionType)
        : normalizeObstructionType(obstructionRaw, defaultObstructionType);

      targets.push({
        name: name || `Town ${autoIndex}`,
        lat,
        lon,
        obstructionType: rowObstructionType
      });
      autoIndex += 1;
    }

    return targets;
  }

  function median(values) {
    if (!values || values.length === 0) {
      return 0;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  function readMainParams() {
    const patternType = elements.patternType.value;
    const customPatternTable = patternType === "custom"
      ? parseCustomPatternTable(elements.customPattern.value)
      : null;
    const latitudeInput = document.getElementById("latitude");
    const longitudeInput = document.getElementById("longitude");
    const locationPair = parseLocationField(
      elements.stationLocationText.value,
      "Station location",
      latitudeInput,
      longitudeInput
    );

    if (patternType === "custom" && !customPatternTable) {
      throw new Error("Custom pattern needs at least 2 valid azimuth,gain lines.");
    }

    return {
      stationName: document.getElementById("stationName").value.trim() || "FM Station",
      latitude: locationPair ? locationPair.lat : asValidNumber(latitudeInput.value, "Latitude", { min: -90, max: 90 }),
      longitude: locationPair ? locationPair.lon : asValidNumber(longitudeInput.value, "Longitude", { min: -180, max: 180 }),
      erpW: asValidNumber(document.getElementById("erpW").value, "ERP", { min: 1 }),
      towerHeightM: asValidNumber(document.getElementById("towerHeightM").value, "Tower height", { min: 1 }),
      mode: document.getElementById("mode").value,
      patternType,
      patternStrengthDb: asValidNumber(elements.patternStrengthDb.value, "Pattern strength", { min: 0 }),
      antennaType: document.getElementById("antennaType").value,
      obstructionType: normalizeObstructionType(elements.obstructionType.value, "open"),
      customPatternTable
    };
  }

  function readBoosterParams(enabled) {
    if (!enabled) {
      return null;
    }

    const boosterLatitudeInput = document.getElementById("boosterLatitude");
    const boosterLongitudeInput = document.getElementById("boosterLongitude");
    const boosterLocationPair = parseLocationField(
      elements.boosterLocationText.value,
      "Booster location",
      boosterLatitudeInput,
      boosterLongitudeInput
    );

    return {
      latitude: boosterLocationPair ? boosterLocationPair.lat : asValidNumber(boosterLatitudeInput.value, "Booster latitude", { min: -90, max: 90 }),
      longitude: boosterLocationPair ? boosterLocationPair.lon : asValidNumber(boosterLongitudeInput.value, "Booster longitude", { min: -180, max: 180 }),
      erpW: asValidNumber(document.getElementById("boosterErpW").value, "Booster ERP", { min: 1 }),
      towerHeightM: asValidNumber(document.getElementById("boosterHeightM").value, "Booster height", { min: 1 })
    };
  }

  function readBatchSettings() {
    const greatPct = asValidNumber(elements.batchGreatPct.value, "Great max %", { min: 5, max: 80 });
    const strongPct = asValidNumber(elements.batchStrongPct.value, "Strong max %", { min: 10, max: 95 });
    if (strongPct <= greatPct) {
      throw new Error("Strong max % must be greater than Great max %.");
    }

    const suburbanEdgePct = asValidNumber(elements.batchSuburbanEdgePct.value, "Suburban edge cutoff %", { min: 50, max: 100 });
    const urbanEdgePct = asValidNumber(elements.batchUrbanEdgePct.value, "Urban edge cutoff %", { min: 50, max: 100 });
    const denseUrbanEdgePct = asValidNumber(elements.batchDenseUrbanEdgePct.value, "Dense urban edge cutoff %", { min: 40, max: 100 });

    const suburbanPenalty = asIntegerWithin(elements.batchSuburbanPenalty.value, "Suburban penalty", { min: 0, max: 3 });
    const urbanPenalty = asIntegerWithin(elements.batchUrbanPenalty.value, "Urban penalty", { min: 0, max: 3 });
    const denseUrbanPenalty = asIntegerWithin(elements.batchDenseUrbanPenalty.value, "Dense urban penalty", { min: 0, max: 3 });

    return {
      coverageBandRatios: {
        greatMax: greatPct / 100,
        strongMax: strongPct / 100,
        moderateMax: defaultCoverageBandRatios.moderateMax
      },
      edgeCountRatios: {
        ...defaultEdgeCountRatios,
        suburban: suburbanEdgePct / 100,
        urban: urbanEdgePct / 100,
        denseUrban: denseUrbanEdgePct / 100
      },
      coveragePenalties: {
        ...defaultCoveragePenalties,
        suburban: suburbanPenalty,
        urban: urbanPenalty,
        denseUrban: denseUrbanPenalty
      }
    };
  }

  function updateMetrics(result) {
    elements.stationRadius.textContent = `Radius: ${formatMiles(result.station.stats.avgRadius)} avg (${formatMiles(result.station.stats.minRadius)} to ${formatMiles(result.station.stats.maxRadius)})`;
    elements.stationArea.textContent = `Area: ${formatArea(result.station.stats.areaKm2)}`;

    if (result.booster) {
      elements.boosterRadius.textContent = `Radius: ${formatMiles(result.booster.stats.avgRadius)} avg (${formatMiles(result.booster.stats.minRadius)} to ${formatMiles(result.booster.stats.maxRadius)})`;
      elements.boosterArea.textContent = `Area: ${formatArea(result.booster.stats.areaKm2)}`;
    } else {
      elements.boosterRadius.textContent = "Radius: -";
      elements.boosterArea.textContent = "Area: -";
    }
  }

  function renderMap(result) {
    initializeMap();
    if (!state.map) {
      return;
    }

    if (state.stationLayer) {
      state.map.removeLayer(state.stationLayer);
    }
    if (state.boosterLayer) {
      state.map.removeLayer(state.boosterLayer);
      state.boosterLayer = null;
    }
    if (state.stationMarker) {
      state.map.removeLayer(state.stationMarker);
    }
    if (state.boosterMarker) {
      state.map.removeLayer(state.boosterMarker);
      state.boosterMarker = null;
    }

    state.stationLayer = L.polygon(result.station.contour, {
      color: "#db5f00",
      weight: 2,
      fillColor: "#ff7a18",
      fillOpacity: 0.28
    }).addTo(state.map);

    state.stationMarker = L.circleMarker([result.station.center[0], result.station.center[1]], {
      radius: 5,
      color: "#963d00",
      fillColor: "#ff7a18",
      fillOpacity: 1
    }).addTo(state.map).bindPopup(`Station Site<br>${obstructionDisplayLabel(result.obstructionType)} obstruction`);

    const layers = [state.stationLayer, state.stationMarker];

    if (result.booster) {
      state.boosterLayer = L.polygon(result.booster.contour, {
        color: "#127987",
        weight: 2,
        fillColor: "#1f9aa9",
        fillOpacity: 0.22
      }).addTo(state.map);

      state.boosterMarker = L.circleMarker([result.booster.center[0], result.booster.center[1]], {
        radius: 5,
        color: "#10555e",
        fillColor: "#1f9aa9",
        fillOpacity: 1
      }).addTo(state.map).bindPopup("Booster Site");
      layers.push(state.boosterLayer, state.boosterMarker);
    }

    const bounds = L.featureGroup(layers).getBounds();
    if (bounds.isValid()) {
      state.map.fitBounds(bounds.pad(0.2));
    }
  }

  function contourToKmlCoordinates(points) {
    const closed = points.concat([points[0]]);
    return closed.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)},0`).join(" ");
  }

  function buildKml(result) {
    const docName = escapeXml(result.stationName);
    const stationCoords = contourToKmlCoordinates(result.station.contour);
    const boosterSection = result.booster
      ? `
    <Placemark>
      <name>${escapeXml(result.stationName)} Booster</name>
      <styleUrl>#boosterStyle</styleUrl>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${contourToKmlCoordinates(result.booster.contour)}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>`
      : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${docName} Approximate Coverage</name>
    <Style id="stationStyle">
      <LineStyle><color>ff005fdb</color><width>2</width></LineStyle>
      <PolyStyle><color>66007aff</color></PolyStyle>
    </Style>
    <Style id="boosterStyle">
      <LineStyle><color>ff877912</color><width>2</width></LineStyle>
      <PolyStyle><color>66a99a1f</color></PolyStyle>
    </Style>
    <Placemark>
      <name>${docName} Station</name>
      <styleUrl>#stationStyle</styleUrl>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${stationCoords}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>${boosterSection}
  </Document>
</kml>`;
  }

  function escapeXml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  function generateResult() {
    const main = readMainParams();
    const boosterInput = readBoosterParams(elements.useBooster.checked);

    const stationBaseRadius = estimateBaseRadiusKm(main.erpW, main.towerHeightM, main.mode, main.antennaType);
    const stationContour = buildContour(
      main.latitude,
      main.longitude,
      stationBaseRadius,
      main.patternType,
      main.patternStrengthDb,
      main.customPatternTable,
      main.obstructionType
    );
    const stationCenter = [main.latitude, main.longitude];

    const result = {
      stationName: main.stationName,
      obstructionType: main.obstructionType,
      station: {
        center: stationCenter,
        contour: stationContour,
        stats: contourStats(stationContour, stationCenter)
      },
      booster: null
    };

    if (boosterInput) {
      const boosterBaseRadius = estimateBaseRadiusKm(
        boosterInput.erpW,
        boosterInput.towerHeightM,
        main.mode,
        main.antennaType
      );
      const boosterContour = buildContour(
        boosterInput.latitude,
        boosterInput.longitude,
        boosterBaseRadius,
        main.patternType,
        main.patternStrengthDb,
        main.customPatternTable,
        main.obstructionType
      );
      const boosterCenter = [boosterInput.latitude, boosterInput.longitude];
      result.booster = {
        center: boosterCenter,
        contour: boosterContour,
        stats: contourStats(boosterContour, boosterCenter)
      };
    }

    return result;
  }

  function onGenerate(event) {
    event.preventDefault();
    try {
      const result = generateResult();
      state.lastResult = result;
      updateMetrics(result);
      renderMap(result);
      elements.exportKmlBtn.disabled = false;
      elements.formMessage.textContent = `Contour generated with "${obstructionDisplayLabel(result.obstructionType)}" obstruction profile. Use Export KML to save polygon(s).`;
    } catch (error) {
      elements.formMessage.textContent = error instanceof Error ? error.message : "Unable to generate contour.";
      elements.exportKmlBtn.disabled = !state.lastResult;
    }
  }

  function onExportKml() {
    if (!state.lastResult) {
      return;
    }
    const kml = buildKml(state.lastResult);
    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
    const url = URL.createObjectURL(blob);
    const safeName = (state.lastResult.stationName || "fm-station")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "fm-station";

    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeName}-coverage.kml`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function formatSignedMiles(valueKm) {
    const miles = kmToMiles(valueKm);
    const sign = miles >= 0 ? "+" : "";
    return `${sign}${miles.toFixed(1)} mi`;
  }

  function coverageBandThresholdsKm(coverageRadiusKm, obstructionType, settings) {
    const radius = Math.max(0, coverageRadiusKm);
    const bandRatios = settings?.coverageBandRatios || defaultCoverageBandRatios;
    const edgeRatios = settings?.edgeCountRatios || defaultEdgeCountRatios;
    const edgeRatio = edgeRatios[obstructionType] || edgeRatios.open;
    const greatRatio = clamp(bandRatios.greatMax, 0.05, 0.9);
    const strongRatio = clamp(bandRatios.strongMax, greatRatio + 0.01, 0.99);
    const moderateBaseKm = radius * clamp(edgeRatio, 0.5, 1);
    return {
      greatMaxKm: moderateBaseKm * greatRatio,
      strongMaxKm: moderateBaseKm * strongRatio,
      moderateMaxKm: moderateBaseKm
    };
  }

  function applyCoveragePenalty(baseStatus, penaltyLevels) {
    const currentIndex = Math.max(0, coverageStatusOrder.indexOf(baseStatus));
    const finalIndex = clamp(currentIndex + penaltyLevels, 0, coverageStatusOrder.length - 1);
    return coverageStatusOrder[finalIndex];
  }

  function classifyCoverage(distanceKm, coverageRadiusKm, obstructionType, settings) {
    const thresholdsKm = coverageBandThresholdsKm(coverageRadiusKm, obstructionType, settings);
    const penalties = settings?.coveragePenalties || defaultCoveragePenalties;
    const penaltyLevels = Math.max(0, Math.round(penalties[obstructionType] ?? penalties.open ?? 0));

    let baseStatus = "notCovered";
    if (distanceKm <= thresholdsKm.greatMaxKm) {
      baseStatus = "great";
    } else if (distanceKm <= thresholdsKm.strongMaxKm) {
      baseStatus = "strong";
    } else if (distanceKm <= thresholdsKm.moderateMaxKm) {
      baseStatus = "moderate";
    }

    const status = applyCoveragePenalty(baseStatus, penaltyLevels);
    return {
      status,
      baseStatus,
      penaltyLevels,
      isCovered: status !== "notCovered",
      thresholdsKm
    };
  }

  function summarizeBatchRows(rows) {
    const greatCount = rows.filter((row) => row.coverageStatus === "great").length;
    const strongCount = rows.filter((row) => row.coverageStatus === "strong").length;
    const moderateCount = rows.filter((row) => row.coverageStatus === "moderate").length;
    const coveredCount = greatCount + strongCount + moderateCount;
    const margins = rows.map((row) => row.marginKm);
    return {
      totalCount: rows.length,
      coveredCount,
      greatCount,
      strongCount,
      moderateCount,
      uncoveredCount: Math.max(0, rows.length - coveredCount),
      coveredPct: rows.length > 0 ? (coveredCount / rows.length) * 100 : 0,
      medianMarginKm: median(margins),
      worstMarginKm: margins.length > 0 ? Math.min(...margins) : 0
    };
  }

  function updateBatchSummary(summary) {
    elements.batchCount.textContent = `Towns analyzed: ${summary.totalCount.toLocaleString()}`;
    elements.batchReachable.textContent = `Covered towns: ${summary.coveredCount.toLocaleString()} (${summary.coveredPct.toFixed(1)}%) | Great: ${summary.greatCount.toLocaleString()} | Strong: ${summary.strongCount.toLocaleString()} | Moderate: ${summary.moderateCount.toLocaleString()}`;
    elements.batchMedianMargin.textContent = `Median margin: ${formatSignedMiles(summary.medianMarginKm)}`;
    elements.batchWorstMargin.textContent = `Worst margin: ${formatSignedMiles(summary.worstMarginKm)}`;
    elements.batchSummary.classList.remove("hidden");
  }

  function clearBatchSummary() {
    elements.batchCount.textContent = "Towns analyzed: -";
    elements.batchReachable.textContent = "Covered towns: -";
    elements.batchMedianMargin.textContent = "Median margin: -";
    elements.batchWorstMargin.textContent = "Worst margin: -";
    elements.batchSummary.classList.add("hidden");
  }

  function updateBatchTownLists(rows) {
    const coveredNames = rows
      .filter((row) => row.isReachable)
      .map((row) => {
        if (row.coverageStatus === "great") {
          return `${row.name} (great)`;
        }
        if (row.coverageStatus === "strong") {
          return `${row.name} (strong)`;
        }
        if (row.coverageStatus === "moderate") {
          return `${row.name} (moderate)`;
        }
        return row.name;
      });
    const notCoveredNames = rows.filter((row) => !row.isReachable).map((row) => row.name);
    elements.batchCoveredTitle.textContent = `Covered Towns (${coveredNames.length.toLocaleString()})`;
    elements.batchNotCoveredTitle.textContent = `Not Covered Towns (${notCoveredNames.length.toLocaleString()})`;
    elements.batchCoveredNames.value = coveredNames.length > 0 ? coveredNames.join("\n") : "None";
    elements.batchNotCoveredNames.value = notCoveredNames.length > 0 ? notCoveredNames.join("\n") : "None";
    elements.batchLists.classList.remove("hidden");
  }

  function clearBatchTownLists() {
    elements.batchCoveredTitle.textContent = "Covered Towns (0)";
    elements.batchNotCoveredTitle.textContent = "Not Covered Towns (0)";
    elements.batchCoveredNames.value = "";
    elements.batchNotCoveredNames.value = "";
    elements.batchLists.classList.add("hidden");
  }

  function escapeCsvCell(value) {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  }

  function buildBatchCsv(batchResult) {
    const header = [
      "name",
      "latitude",
      "longitude",
      "distance_km",
      "distance_mi",
      "bearing_deg",
      "obstruction",
      "obstruction_loss_db",
      "coverage_radius_km",
      "coverage_radius_mi",
      "great_limit_distance_km",
      "great_limit_distance_mi",
      "strong_limit_distance_km",
      "strong_limit_distance_mi",
      "moderate_limit_distance_km",
      "moderate_limit_distance_mi",
      "margin_km",
      "margin_mi",
      "base_reception_status",
      "status_penalty_levels",
      "reception_status",
      "covered"
    ];
    const lines = [header.join(",")];
    for (const row of batchResult.rows) {
      lines.push([
        row.name,
        row.lat.toFixed(6),
        row.lon.toFixed(6),
        row.distanceKm.toFixed(3),
        row.distanceMi.toFixed(3),
        row.bearingDeg.toFixed(1),
        obstructionDisplayLabel(row.obstructionType),
        row.obstructionLossDb.toFixed(2),
        row.coverageRadiusKm.toFixed(3),
        row.coverageRadiusMi.toFixed(3),
        row.greatMaxDistanceKm.toFixed(3),
        row.greatMaxDistanceMi.toFixed(3),
        row.strongMaxDistanceKm.toFixed(3),
        row.strongMaxDistanceMi.toFixed(3),
        row.moderateMaxDistanceKm.toFixed(3),
        row.moderateMaxDistanceMi.toFixed(3),
        row.marginKm.toFixed(3),
        row.marginMi.toFixed(3),
        row.baseCoverageStatus,
        row.coveragePenaltyLevels,
        row.coverageStatus,
        row.isReachable ? "yes" : "no"
      ].map(escapeCsvCell).join(","));
    }
    return lines.join("\n");
  }

  async function onRunBatch() {
    const previousLabel = elements.runBatchBtn.textContent;
    try {
      const main = readMainParams();
      const batchSettings = readBatchSettings();
      const targets = parseBatchTargets(
        elements.batchLocations.value,
        main.obstructionType,
        elements.batchUseBaseObstruction.checked
      );
      const stationCenter = [main.latitude, main.longitude];
      const stationBaseRadius = estimateBaseRadiusKm(main.erpW, main.towerHeightM, main.mode, main.antennaType);
      const rows = [];

      state.lastBatchResult = null;
      elements.exportBatchCsvBtn.disabled = true;
      clearBatchSummary();
      clearBatchTownLists();
      elements.batchMessage.textContent = `Processing 0 / ${targets.length.toLocaleString()} towns...`;
      elements.runBatchBtn.disabled = true;
      elements.runBatchBtn.textContent = "Running...";

      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        const point = [target.lat, target.lon];
        const bearingDeg = initialBearingDeg(stationCenter, point);
        const distanceKm = haversineKm(stationCenter, point);
        const coverageRadiusKm = effectiveRadiusKm(
          stationBaseRadius,
          bearingDeg,
          main.patternType,
          main.patternStrengthDb,
          main.customPatternTable,
          target.obstructionType,
          main.latitude,
          main.longitude
        );
        const marginKm = coverageRadiusKm - distanceKm;
        const coverageClass = classifyCoverage(
          distanceKm,
          coverageRadiusKm,
          target.obstructionType,
          batchSettings
        );
        const obstructionLoss = obstructionLossDb(
          target.obstructionType,
          bearingDeg,
          main.latitude,
          main.longitude
        );

        rows.push({
          name: target.name,
          lat: target.lat,
          lon: target.lon,
          bearingDeg,
          obstructionType: target.obstructionType,
          obstructionLossDb: obstructionLoss,
          distanceKm,
          distanceMi: kmToMiles(distanceKm),
          coverageRadiusKm,
          coverageRadiusMi: kmToMiles(coverageRadiusKm),
          greatMaxDistanceKm: coverageClass.thresholdsKm.greatMaxKm,
          greatMaxDistanceMi: kmToMiles(coverageClass.thresholdsKm.greatMaxKm),
          strongMaxDistanceKm: coverageClass.thresholdsKm.strongMaxKm,
          strongMaxDistanceMi: kmToMiles(coverageClass.thresholdsKm.strongMaxKm),
          moderateMaxDistanceKm: coverageClass.thresholdsKm.moderateMaxKm,
          moderateMaxDistanceMi: kmToMiles(coverageClass.thresholdsKm.moderateMaxKm),
          marginKm,
          marginMi: kmToMiles(marginKm),
          baseCoverageStatus: coverageClass.baseStatus,
          coveragePenaltyLevels: coverageClass.penaltyLevels,
          coverageStatus: coverageClass.status,
          isReachable: coverageClass.isCovered
        });

        if ((i + 1) % BATCH_CHUNK_SIZE === 0 || i === targets.length - 1) {
          elements.batchMessage.textContent = `Processing ${Math.min(i + 1, targets.length).toLocaleString()} / ${targets.length.toLocaleString()} towns...`;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      const summary = summarizeBatchRows(rows);
      const overrideMode = elements.batchUseBaseObstruction.checked;
      state.lastBatchResult = {
        generatedAt: new Date().toISOString(),
        stationName: main.stationName,
        rows,
        summary,
        batchSettings,
        overrideMode
      };
      updateBatchSummary(summary);
      updateBatchTownLists(rows);
      elements.exportBatchCsvBtn.disabled = false;
      const modeText = overrideMode
        ? `using transmitter surroundings "${obstructionDisplayLabel(main.obstructionType)}" for all rows`
        : "using per-row obstruction values";
      elements.batchMessage.textContent = `Batch complete for ${summary.totalCount.toLocaleString()} towns (${modeText}) with great/strong/moderate/not-covered classification.`;
      elements.formMessage.textContent = `Batch check complete for ${summary.totalCount.toLocaleString()} towns/cities.`;
    } catch (error) {
      state.lastBatchResult = null;
      elements.exportBatchCsvBtn.disabled = true;
      clearBatchSummary();
      clearBatchTownLists();
      elements.batchMessage.textContent = error instanceof Error ? error.message : "Batch run failed.";
      elements.formMessage.textContent = elements.batchMessage.textContent;
    } finally {
      elements.runBatchBtn.disabled = false;
      elements.runBatchBtn.textContent = previousLabel;
    }
  }

  function onExportBatchCsv() {
    if (!state.lastBatchResult) {
      return;
    }
    const csv = buildBatchCsv(state.lastBatchResult);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const safeName = (state.lastBatchResult.stationName || "fm-station")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "fm-station";

    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeName}-obstruction-batch.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function refreshPatternUI() {
    const isCustom = elements.patternType.value === "custom";
    elements.customPatternWrap.classList.toggle("hidden", !isCustom);
  }

  function refreshBoosterUI() {
    elements.boosterFields.classList.toggle("hidden", !elements.useBooster.checked);
  }

  function updatePatternStrengthLabel() {
    elements.patternStrengthValue.textContent = `${elements.patternStrengthDb.value} dB`;
  }

  function invalidateBatchResult() {
    state.lastBatchResult = null;
    elements.exportBatchCsvBtn.disabled = true;
    clearBatchSummary();
    clearBatchTownLists();
  }

  function bindEvents() {
    elements.form.addEventListener("submit", onGenerate);
    elements.exportKmlBtn.addEventListener("click", onExportKml);
    elements.themeToggleBtn.addEventListener("click", onToggleTheme);
    elements.runBatchBtn.addEventListener("click", () => {
      void onRunBatch();
    });
    elements.exportBatchCsvBtn.addEventListener("click", onExportBatchCsv);
    elements.patternType.addEventListener("change", refreshPatternUI);
    elements.useBooster.addEventListener("change", refreshBoosterUI);
    elements.patternStrengthDb.addEventListener("input", updatePatternStrengthLabel);
    elements.batchLocations.addEventListener("input", () => {
      invalidateBatchResult();
      elements.batchMessage.textContent = "";
    });
    elements.form.addEventListener("change", (event) => {
      if (event.target !== elements.batchLocations) {
        invalidateBatchResult();
      }
    });
  }

  function initialize() {
    applyTheme(detectPreferredTheme());
    initializeMap();
    bindEvents();
    refreshPatternUI();
    refreshBoosterUI();
    updatePatternStrengthLabel();
    clearBatchSummary();
    clearBatchTownLists();
    elements.batchMessage.textContent = "";
    elements.form.requestSubmit();
  }

  initialize();
})();
