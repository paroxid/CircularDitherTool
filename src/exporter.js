function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function stemName(fileName) {
  const base = (fileName || "dither").replace(/\.[^.]+$/, "") || "dither";
  return base.replace(/[^\w\-]+/g, "_");
}

export function frameCountFor(duration, fps) {
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  return Math.max(1, Math.round(duration * fps));
}

export async function canEncodeMp4() {
  if (typeof VideoEncoder === "undefined" || !VideoEncoder.isConfigSupported) return false;
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec: "avc1.42001f",
      width: 1280,
      height: 720,
      bitrate: 4_000_000,
      framerate: 30,
    });
    return Boolean(result.supported);
  } catch {
    return false;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Export canceled", "AbortError");
  }
}

async function seekTo(video, time, signal) {
  const target = Math.min(Math.max(time, 0), Math.max((video.duration || 0) - 0.001, 0));
  throwIfAborted(signal);
  if (Math.abs(video.currentTime - target) > 0.0005) {
    await new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", finish);
        resolve();
      };
      timer = setTimeout(finish, 1200);
      video.addEventListener("seeked", finish);
      video.currentTime = target;
    });
  }
  throwIfAborted(signal);
  if (typeof video.requestVideoFrameCallback === "function") {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 180);
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  } else {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  throwIfAborted(signal);
}

function readback(canvas, cache) {
  if (!cache.canvas) {
    cache.canvas = document.createElement("canvas");
    cache.ctx = cache.canvas.getContext("2d", { willReadFrequently: true });
  }
  if (cache.canvas.width !== canvas.width || cache.canvas.height !== canvas.height) {
    cache.canvas.width = canvas.width;
    cache.canvas.height = canvas.height;
  }
  cache.ctx.drawImage(canvas, 0, 0);
  return cache.ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("Could not encode a PNG frame."));
      else resolve(blob);
    }, "image/png");
  });
}

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function exportEncoded({ canvas, video, draw, fps, frameCount, signal, onProgress, fileName, kind }) {
  const {
    Output,
    Mp4OutputFormat,
    WebMOutputFormat,
    BufferTarget,
    CanvasSource,
    Quality,
  } = await import("mediabunny");

  const output = new Output({
    format: kind === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, {
    codec: kind === "mp4" ? "avc" : "vp9",
    quality: new Quality("high"),
  });
  output.addVideoTrack(source, { frameRate: fps });
  output.setMetadataTags?.({ title: stemName(fileName) });
  await output.start();

  try {
    for (let i = 0; i < frameCount; i += 1) {
      throwIfAborted(signal);
      const time = Math.min(i / fps, Math.max((video.duration || 0) - 0.001, 0));
      await seekTo(video, time, signal);
      if (draw() === false) throw new Error("Could not read a video frame.");
      await source.add(i / fps, 1 / fps, { keyFrame: i % fps === 0 });
      onProgress?.((i + 1) / frameCount, i + 1, frameCount);
    }
    throwIfAborted(signal);
    await output.finalize();
  } catch (error) {
    try {
      await output.cancel?.();
    } catch {
      /* The muxer may already be closed after a failed finalize. */
    }
    throw error;
  }

  const buffer = output.target.buffer;
  const type = kind === "mp4" ? "video/mp4" : "video/webm";
  const ext = kind === "mp4" ? "mp4" : "webm";
  downloadBlob(new Blob([buffer], { type }), `${stemName(fileName)}.${ext}`);
}

export async function exportMedia(options) {
  const fps = options.format === "gif" ? Math.min(options.fps, 12) : options.fps;
  const frameCount = frameCountFor(options.video.duration, fps);
  const wasPlaying = !options.video.paused;
  const resumeTime = options.video.currentTime;
  options.video.pause();

  try {
    if (options.format === "mp4" || options.format === "webm") {
      await exportEncoded({ ...options, fps, frameCount, kind: options.format });
      return { fps, frameCount };
    }
    if (options.format === "gif") {
      await exportGifFile({ ...options, fps, frameCount });
      return { fps, frameCount };
    }
    if (options.format === "png") {
      await exportPngZip({ ...options, fps, frameCount });
      return { fps, frameCount };
    }
    throw new Error("Unknown export format.");
  } finally {
    try {
      await seekTo(options.video, resumeTime);
    } catch {
      try {
        options.video.currentTime = resumeTime;
      } catch {
        /* The element may have been replaced mid-export. */
      }
    }
    if (wasPlaying) await options.video.play().catch(() => {});
  }
}

async function exportGifFile({ canvas, video, draw, fps, frameCount, signal, onProgress, fileName, ink, paper }) {
  const { GIFEncoder, applyPalette } = await import("gifenc");
  const gif = GIFEncoder();
  const palette = [hexToRgb(paper || "#000000"), hexToRgb(ink || "#ffffff")];
  const cache = {};
  const delay = Math.max(2, Math.round(1000 / fps));

  for (let i = 0; i < frameCount; i += 1) {
    throwIfAborted(signal);
    const time = Math.min(i / fps, Math.max((video.duration || 0) - 0.001, 0));
    await seekTo(video, time, signal);
    if (draw() === false) throw new Error("Could not read a video frame.");
    const image = readback(canvas, cache);
    const index = applyPalette(new Uint8Array(image.data), palette);
    gif.writeFrame(index, canvas.width, canvas.height, {
      palette: i === 0 ? palette : null,
      delay,
      repeat: 0,
    });
    onProgress?.((i + 1) / frameCount, i + 1, frameCount);
  }

  gif.finish();
  downloadBlob(new Blob([gif.bytes()], { type: "image/gif" }), `${stemName(fileName)}.gif`);
}

async function exportPngZip({ canvas, video, draw, fps, frameCount, signal, onProgress, fileName }) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();

  for (let i = 0; i < frameCount; i += 1) {
    throwIfAborted(signal);
    const time = Math.min(i / fps, Math.max((video.duration || 0) - 0.001, 0));
    await seekTo(video, time, signal);
    if (draw() === false) throw new Error("Could not read a video frame.");
    const blob = await canvasToPng(canvas);
    const name = `frame_${String(i + 1).padStart(4, "0")}.png`;
    zip.file(name, blob, { compression: "STORE" });
    onProgress?.((i + 0.85) / frameCount, i + 1, frameCount);
  }

  throwIfAborted(signal);
  onProgress?.(0.95, frameCount, frameCount);
  const zipped = await zip.generateAsync({ type: "blob" });
  downloadBlob(zipped, `${stemName(fileName)}_frames.zip`);
}
