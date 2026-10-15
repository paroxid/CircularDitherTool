import "./style.css";
import { createRenderer } from "./canvasRenderer.js";
import { canEncodeMp4, exportMedia, frameCountFor } from "./exporter.js";

const DEFAULT_PARAMS = Object.freeze({
  cellSize: 12,
  offsetX: 0,
  offsetY: 0,
  stagger: 0,
  minRadius: 0.5,
  maxRadius: 0.5,
  radiusResponse: 1,
  minStroke: 1,
  maxStroke: 6,
  strokeCurve: 1,
  solidThreshold: 1,
  gap: 0,
  softness: 1,
  blackPoint: 0,
  whitePoint: 1,
  brightness: 0,
  contrast: 1,
  gamma: 1,
  invert: false,
  lumR: 0.2126,
  lumG: 0.7152,
  lumB: 0.0722,
  ink: "#ffffff",
  paper: "#000000",
});

const FIELDS = [
  { key: "cellSize", label: "Cell size", group: "Grid", min: 2, max: 96, simple: [4, 32], step: 1, unit: "px" },
  { key: "offsetX", label: "Offset X", group: "Grid", min: -48, max: 48, step: 1, unit: "px" },
  { key: "offsetY", label: "Offset Y", group: "Grid", min: -48, max: 48, step: 1, unit: "px" },
  { key: "stagger", label: "Row stagger", group: "Grid", min: 0, max: 1, step: 0.01 },
  { key: "minRadius", label: "Min radius", group: "Shape", min: 0, max: 0.5, step: 0.01 },
  { key: "maxRadius", label: "Max radius", group: "Shape", min: 0, max: 0.5, step: 0.01 },
  { key: "radiusResponse", label: "Radius response", group: "Shape", min: 0, max: 1, step: 0.01 },
  { key: "minStroke", label: "Min stroke", group: "Shape", min: 0, max: 48, simple: [0.5, 8], step: 0.1, unit: "px" },
  { key: "maxStroke", label: "Max stroke", group: "Shape", min: 0, max: 96, simple: [0.5, 32], step: 0.1, unit: "px", simpleMax: "radius" },
  { key: "strokeCurve", label: "Stroke curve", group: "Shape", min: 0.2, max: 4, step: 0.01 },
  { key: "solidThreshold", label: "Solid threshold", group: "Shape", min: 0, max: 1, step: 0.01 },
  { key: "gap", label: "Gap", group: "Edge", min: 0, max: 8, step: 0.1, unit: "px" },
  { key: "softness", label: "Edge softness", group: "Edge", min: 0.25, max: 4, step: 0.05 },
  { key: "blackPoint", label: "Black point", group: "Tone", min: 0, max: 1, step: 0.01 },
  { key: "whitePoint", label: "White point", group: "Tone", min: 0, max: 1, step: 0.01 },
  { key: "brightness", label: "Brightness", group: "Tone", min: -2, max: 2, simple: [-1, 1], step: 0.01 },
  { key: "contrast", label: "Contrast", group: "Tone", min: 0, max: 4, simple: [0, 2], step: 0.01 },
  { key: "gamma", label: "Gamma", group: "Tone", min: 0.1, max: 4, simple: [0.2, 2.5], step: 0.01 },
  { key: "lumR", label: "Luminance R", group: "Tone", min: 0, max: 1, step: 0.01 },
  { key: "lumG", label: "Luminance G", group: "Tone", min: 0, max: 1, step: 0.01 },
  { key: "lumB", label: "Luminance B", group: "Tone", min: 0, max: 1, step: 0.01 },
];

const SIMPLE_ORDER = ["cellSize", "minStroke", "maxStroke", "brightness", "contrast", "gamma"];
const GROUPS = ["Grid", "Shape", "Edge", "Tone", "Color"];

const PLAY_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3.2v9.6l8-4.8-8-4.8z" fill="currentColor"/></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.4 3h2.3v10H4.4V3zm4.9 0h2.3v10H9.3V3z" fill="currentColor"/></svg>`;

const params = { ...DEFAULT_PARAMS };
const video = document.querySelector("#source");
const canvas = document.querySelector("#view");
const panel = document.querySelector("#panel");
const stage = document.querySelector("#stage");
const empty = document.querySelector("#empty");
const stageError = document.querySelector("#stage-error");
const fileInput = document.querySelector("#file-input");
const fileName = document.querySelector("#file-name");
const playButton = document.querySelector("#play");
const seek = document.querySelector("#seek");
const currentTime = document.querySelector("#current-time");
const durationLabel = document.querySelector("#duration");
const loopButton = document.querySelector("#loop");
const muteButton = document.querySelector("#mute");
const fpsSelect = document.querySelector("#fps");
const exportEstimate = document.querySelector("#export-estimate");
const exportStatus = document.querySelector("#export-status");
const progress = document.querySelector("#progress");
const progressBar = document.querySelector("#progress-bar");
const cancelButton = document.querySelector("#cancel-export");
const mp4Note = document.querySelector("#mp4-note");
const exportButtons = [...document.querySelectorAll("[data-format]")];

let renderer;
let objectUrl = "";
let mediaName = "dither";
let ready = false;
let exporting = false;
let paramsDirty = true;
let lastTime = -1;
let raf = 0;
let scrubbing = false;
let exportAbort = null;
let mp4Ok = false;

try {
  renderer = createRenderer(canvas);
} catch (error) {
  stageError.textContent = error.message;
  stageError.classList.remove("hidden");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function decimalsFor(step) {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

function formatValue(value, step, unit) {
  const text = Number(value).toFixed(decimalsFor(step));
  return unit ? `${text} ${unit}` : text;
}

function fieldByKey(key) {
  return FIELDS.find((field) => field.key === key);
}

function rangeFor(field, section) {
  if (section === "advanced") return [field.min, field.max];
  const min = field.simple[0];
  if (field.simpleMax === "radius") {
    const radius = params.cellSize * Math.max(params.minRadius, params.maxRadius);
    return [min, Math.max(min, Math.round(radius * 10) / 10)];
  }
  return field.simple;
}

function sliderMarkup(field, section) {
  const [min, max] = rangeFor(field, section);
  return `<label class="block py-2" data-key="${field.key}" data-section="${section}">
    <span class="mb-1.5 flex items-baseline justify-between text-[12px]">
      <span>${field.label}</span>
      <span class="readout font-mono text-[11px] text-white/45 tabular-nums"></span>
    </span>
    <input type="range" min="${min}" max="${max}" step="${field.step}" value="${params[field.key]}" />
  </label>`;
}

function invertMarkup() {
  return `<div class="flex items-center justify-between py-2">
    <span class="text-[12px]">Invert</span>
    <button class="switch" type="button" data-toggle="invert" aria-pressed="false" aria-label="Invert thresholds"></button>
  </div>`;
}

function buildPanel() {
  const simple = SIMPLE_ORDER.map((key) => sliderMarkup(fieldByKey(key), "simple")).join("");
  const advanced = GROUPS.map((group) => {
    const fields = FIELDS.filter((field) => field.group === group)
      .map((field) => sliderMarkup(field, "advanced"))
      .join("");
    const extra =
      group === "Tone"
        ? invertMarkup()
        : group === "Color"
          ? `<label class="flex items-center justify-between py-2 text-[12px]">Ink<input type="color" data-color="ink" value="${params.ink}" /></label>
             <label class="flex items-center justify-between py-2 text-[12px]">Paper<input type="color" data-color="paper" value="${params.paper}" /></label>
             <button id="reset" class="btn mt-3 w-full" type="button">Reset defaults</button>`
          : "";
    return `<div class="mt-4">
      <p class="mb-1 text-[10px] tracking-[0.16em] text-white/35 uppercase">${group}</p>
      ${fields}
      ${extra}
    </div>`;
  }).join("");

  panel.innerHTML = `
    <p class="pt-1 text-[11px] tracking-[0.18em] text-white/40 uppercase">Simple</p>
    ${simple}
    ${invertMarkup()}
    <details id="advanced" class="mt-3 border-t border-white/10">
      <summary>
        <span class="text-[11px] tracking-[0.18em] text-white/40 uppercase">Advanced</span>
        <span class="chevron"></span>
      </summary>
      ${advanced}
    </details>
  `;

  panel.querySelectorAll("input[type='range']").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.closest("[data-key]").dataset.key;
      params[key] = Number(input.value);
      paramsDirty = true;
      syncControls();
      redraw();
    });
  });

  panel.querySelectorAll("[data-toggle='invert']").forEach((button) => {
    button.addEventListener("click", () => {
      params.invert = !params.invert;
      paramsDirty = true;
      syncControls();
    });
  });

  panel.querySelectorAll("[data-color]").forEach((input) => {
    input.addEventListener("input", () => {
      params[input.dataset.color] = input.value;
      paramsDirty = true;
    });
  });

  panel.querySelector("#reset").addEventListener("click", () => {
    Object.assign(params, DEFAULT_PARAMS);
    paramsDirty = true;
    syncControls();
  });
}

function syncControls() {
  panel.querySelectorAll("[data-key]").forEach((row) => {
    const field = fieldByKey(row.dataset.key);
    const section = row.dataset.section;
    const input = row.querySelector("input");
    const [min, max] = rangeFor(field, section);
    input.min = String(min);
    input.max = String(max);
    const shown = section === "simple" ? clamp(params[field.key], min, max) : params[field.key];
    if (document.activeElement !== input) input.value = String(shown);
    row.querySelector(".readout").textContent = formatValue(shown, field.step, field.unit);
  });
  panel.querySelectorAll("[data-toggle='invert']").forEach((button) => {
    button.setAttribute("aria-pressed", params.invert ? "true" : "false");
  });
  panel.querySelectorAll("[data-color]").forEach((input) => {
    if (document.activeElement !== input) input.value = params[input.dataset.color];
  });
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function syncPlay() {
  const playing = !video.paused && !video.ended;
  playButton.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function updateEstimate() {
  if (!ready || !Number.isFinite(video.duration)) {
    exportEstimate.textContent = "";
    return;
  }
  const fps = Number(fpsSelect.value);
  const frames = frameCountFor(video.duration, fps);
  exportEstimate.textContent = `${frames} frames at ${fps} fps`;
}

function setExportEnabled(enabled) {
  exportButtons.forEach((button) => {
    const blocked = button.dataset.format === "mp4" && !mp4Ok;
    button.disabled = !enabled || blocked || exporting;
  });
}

function setBusy(busy) {
  exporting = busy;
  document.querySelector("#open-button").disabled = busy;
  fileInput.disabled = busy;
  playButton.disabled = busy || !ready;
  seek.disabled = busy || !ready;
  loopButton.disabled = busy;
  muteButton.disabled = busy;
  fpsSelect.disabled = busy;
  panel.querySelectorAll("input, button").forEach((el) => {
    el.disabled = busy;
  });
  setExportEnabled(ready);
  cancelButton.classList.toggle("hidden", !busy);
  progress.classList.toggle("hidden", !busy);
  if (!busy) progressBar.style.transform = "scaleX(0)";
}

function loadFile(file) {
  const allowed = /video\/(mp4|webm|quicktime)|\.mp4$|\.webm$|\.mov$/i;
  if (file && file.type && !file.type.startsWith("video/") && !allowed.test(file.name)) {
    exportStatus.textContent = "Use an MP4, WebM, or MOV file.";
    return;
  }
  if (!file) return;
  exportAbort?.abort();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  mediaName = file.name;
  fileName.textContent = file.name;
  document.title = `${file.name} — Round Dither`;
  video.src = objectUrl;
  video.load();
}

async function onReady() {
  if (!renderer || !video.videoWidth) return;
  renderer.resize(video.videoWidth, video.videoHeight);
  ready = true;
  empty.classList.add("hidden");
  seek.max = String(video.duration || 0);
  seek.disabled = false;
  playButton.disabled = false;
  durationLabel.textContent = formatClock(video.duration);
  updateEstimate();
  setExportEnabled(true);
  paramsDirty = true;
  startLoop();
  redraw();
  try {
    await video.play();
  } catch {
    video.muted = true;
    muteButton.setAttribute("aria-pressed", "true");
    muteButton.classList.add("is-on");
    await video.play().catch(() => {});
  }
  syncPlay();
}

function redraw() {
  if (!renderer || exporting || video.readyState < 2) return;
  if (renderer.draw(video, params)) {
    lastTime = video.currentTime;
    paramsDirty = false;
  }
}

function startLoop() {
  if (raf) return;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!renderer || exporting || video.readyState < 2) return;
    const moving = !video.paused;
    if (moving || paramsDirty || video.currentTime !== lastTime) redraw();
  };
  tick();
}

function togglePlay() {
  if (!ready || exporting) return;
  if (video.paused) video.play();
  else video.pause();
}

async function runExport(format) {
  if (!ready || exporting || !renderer) return;
  const selectedFps = Number(fpsSelect.value);
  const fps = format === "gif" ? Math.min(selectedFps, 12) : selectedFps;
  const frames = frameCountFor(video.duration, fps);
  const heavy = (format === "png" && frames > 300) || (format === "gif" && frames > 150);
  if (heavy) {
    const ok = window.confirm(`${frames} frames stay in memory for this export. Continue?`);
    if (!ok) return;
  }

  exportAbort = new AbortController();
  setBusy(true);
  exportStatus.textContent = format === "gif" && selectedFps > 12 ? "Encoding GIF at 12 fps…" : "Encoding…";
  progressBar.style.transform = "scaleX(0)";

  try {
    const frozen = { ...params };
  const result = await exportMedia({
      canvas,
      video,
      draw: () => renderer.draw(video, frozen, true),
      fps: selectedFps,
      format,
      signal: exportAbort.signal,
      fileName: mediaName,
      ink: frozen.ink,
      paper: frozen.paper,
      onProgress: (ratio, index, total) => {
        progressBar.style.transform = `scaleX(${ratio})`;
        exportStatus.textContent = `Frame ${index} of ${total}`;
      },
    });
    exportStatus.textContent = `Saved ${result.frameCount} frames at ${result.fps} fps.`;
  } catch (error) {
    if (error?.name === "AbortError") exportStatus.textContent = "Export canceled.";
    else exportStatus.textContent = error?.message || "Export failed.";
  } finally {
    exportAbort = null;
    setBusy(false);
    paramsDirty = true;
  }
}

buildPanel();
syncControls();
syncPlay();
video.loop = true;

document.querySelector("#open-button").addEventListener("click", () => fileInput.click());
empty.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
  fileInput.value = "";
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  stage.classList.add("is-drag");
});
window.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) stage.classList.remove("is-drag");
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  stage.classList.remove("is-drag");
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

playButton.addEventListener("click", togglePlay);
video.addEventListener("play", syncPlay);
video.addEventListener("pause", syncPlay);
video.addEventListener("loadedmetadata", onReady);
video.addEventListener("loadeddata", () => redraw());
video.addEventListener("seeked", () => redraw());
video.addEventListener("error", () => {
  exportStatus.textContent = "This browser could not play that file.";
});
video.addEventListener("timeupdate", () => {
  if (scrubbing) return;
  seek.value = String(video.currentTime);
  currentTime.textContent = formatClock(video.currentTime);
});

seek.addEventListener("pointerdown", () => {
  scrubbing = true;
});
seek.addEventListener("pointerup", () => {
  scrubbing = false;
});
seek.addEventListener("input", () => {
  video.currentTime = Number(seek.value);
  currentTime.textContent = formatClock(video.currentTime);
  paramsDirty = true;
});

loopButton.addEventListener("click", () => {
  video.loop = !video.loop;
  loopButton.setAttribute("aria-pressed", video.loop ? "true" : "false");
  loopButton.classList.toggle("is-on", video.loop);
});

muteButton.addEventListener("click", () => {
  video.muted = !video.muted;
  muteButton.setAttribute("aria-pressed", video.muted ? "true" : "false");
  muteButton.classList.toggle("is-on", video.muted);
});

fpsSelect.addEventListener("change", updateEstimate);
exportButtons.forEach((button) => {
  button.addEventListener("click", () => runExport(button.dataset.format));
});
cancelButton.addEventListener("click", () => exportAbort?.abort());

window.addEventListener("keydown", (event) => {
  if (event.code !== "Space") return;
  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") return;
  event.preventDefault();
  togglePlay();
});

canEncodeMp4().then((supported) => {
  mp4Ok = supported;
  mp4Note.classList.toggle("hidden", supported);
  setExportEnabled(ready);
});
