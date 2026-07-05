"use strict";

const tauri = window.__TAURI_INTERNALS__;

function invoke(command, args) {
    return tauri.invoke(command, args);
}

function convertFileSrc(path) {
    return tauri.convertFileSrc(path);
}

function openFolderDialog(options) {
    return invoke("plugin:dialog|open", { options });
}

function listenWindowEvent(event, callback) {
    return invoke("plugin:event|listen", {
        event,
        target: { kind: "Window", label: tauri.metadata.currentWindow.label },
        handler: tauri.transformCallback(callback),
    });
}

function onDragDropEvent(callback) {
    void listenWindowEvent("tauri://drag-enter", (event) => {
        callback({
            payload: {
                type: "enter",
                paths: event.payload.paths ?? [],
                position: event.payload.position,
            },
        });
    });
    void listenWindowEvent("tauri://drag-over", (event) => {
        callback({
            payload: { type: "over", position: event.payload.position },
        });
    });
    void listenWindowEvent("tauri://drag-drop", (event) => {
        callback({
            payload: {
                type: "drop",
                paths: event.payload.paths ?? [],
                position: event.payload.position,
            },
        });
    });
    void listenWindowEvent("tauri://drag-leave", () => {
        callback({ payload: { type: "leave" } });
    });
}

const presets = [
    ["144x144(1:1)", 144, 144],
    ["200x200(1:1)", 200, 200],
    ["250x250(1:1)", 250, 250],
    ["300x300(1:1)", 300, 300],
    ["400x400(1:1)", 400, 400],
    ["240x135(16:9)", 240, 135],
    ["320x180(16:9)", 320, 180],
    ["480x270(16:9)", 480, 270],
    ["240x160(3:2)", 240, 160],
    ["300x200(3:2)", 300, 200],
    ["420x280(3:2)", 420, 280],
    ["200x150(4:3)", 200, 150],
    ["300x225(4:3)", 300, 225],
    ["400x300(4:3)", 400, 300],
    ["135x240(9:16)", 135, 240],
    ["180x320(9:16)", 180, 320],
    ["270x480(9:16)", 270, 480],
    ["160x240(2:3)", 160, 240],
    ["200x300(2:3)", 200, 300],
    ["280x420(2:3)", 280, 420],
    ["150x200(3:4)", 150, 200],
    ["225x300(3:4)", 225, 300],
    ["300x400(3:4)", 300, 400],
].map(([label, width, height]) => ({ label, width, height }));

const outputFormats = ["webp", "gif"];
const webpPresets = ["picture", "photo", "icon"];
const saved = JSON.parse(localStorage.getItem("anyForgeSettings") || "{}");

let busy = false;
let pendingPath = "";
let pendingKind = "";
let desktopDir = "";
let lastOutputPath = "";
let outputFormat = outputFormats.includes(saved.outputFormat) ? saved.outputFormat : "webp";
let previewKind = "";
let previewInfo = null;
let pendingMediaInfo = null;
let pendingStaticInput = false;

const $ = (selector) => document.querySelector(selector);
const presetEl = $("#size-preset");
const widthEl = $("#width-input");
const heightEl = $("#height-input");
const outputDirEl = $("#output-dir-input");
const fpsEl = $("#fps-input");
const loopEl = $("#loop-input");
const lossyEl = $("#lossy-input");
const qualityEl = $("#quality-input");
const compressionLevelEl = $("#compression-level-input");
const webpPresetEl = $("#webp-preset");
const webpOptionsEl = $("#webp-options");
const formatToggleEl = $("#format-toggle");
const formatImageEl = $("#format-image");
const chooseFolderEl = $("#choose-folder");
const convertButtonEl = $("#convert-button");
const locateButtonEl = $("#locate-button");
const statusEl = $("#status");
const dropzoneEl = $("#dropzone");
const previewVideoEl = $("#preview-video");
const previewImageEl = $("#preview-image");
const previewEmptyEl = $("#preview-empty");
const previewBadgeEl = $("#preview-badge");
const fileNameEl = $("#file-name");

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function readNumber(input, fallback) {
    return Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : fallback;
}

function snapToFive(value) {
    return Math.max(5, Math.round(value / 5) * 5);
}

function normalizeSizeInput(input, fallback) {
    input.value = String(Math.max(1, Math.round(readNumber(input, fallback))));
}

function normalizeIntegerInput(input, fallback, min, max) {
    input.value = String(clamp(Math.round(readNumber(input, fallback)), min, max));
}

function normalizeQualityInput() {
    qualityEl.value = String(clamp(snapToFive(readNumber(qualityEl, 80)), 50, 100));
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0)
        return "--";
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return minutes ? `${minutes}:${String(rest).padStart(2, "0")}` : `${rest}s`;
}

function formatFileSize(bytes) {
    if (bytes >= 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)}M`;
    return `${Math.max(1, Math.round(bytes / 1024))}K`;
}

function normalizeMediaInfo(info) {
    return {
        width: Number.isFinite(info?.width) && info.width > 0 ? Math.round(info.width) : null,
        height: Number.isFinite(info?.height) && info.height > 0 ? Math.round(info.height) : null,
        fps: Number.isFinite(info?.fps) && info.fps > 0 ? info.fps : null,
        isStaticImage: Boolean(info?.isStaticImage),
    };
}

function formatBadgeSize(info) {
    return info?.width && info?.height ? `${info.width} x ${info.height}` : "-- x --";
}

function formatBadgeFps(info) {
    if (!Number.isFinite(info?.fps) || info.fps <= 0)
        return "--";
    return Number(info.fps.toFixed(2));
}

function fileKind(path) {
    const extension = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() || "";
    if (extension === "jpeg")
        return "jpg";
    return extension;
}

function shouldUseImagePreview(kind) {
    return ["gif", "webp", "png", "jpg", "bmp", "avif"].includes(kind);
}

function isStaticImageKind(kind) {
    return ["png", "jpg", "bmp", "tif", "tiff", "heic", "heif", "avif"].includes(kind);
}

function saveSettings() {
    localStorage.setItem("anyForgeSettings", JSON.stringify({
        outputFormat,
        width: readNumber(widthEl, 144),
        height: readNumber(heightEl, 144),
        outputDir: outputDirEl.value.trim(),
        fps: currentFps(),
        loopAnimation: loopEl.checked,
        lossy: lossyEl.checked,
        quality: currentQuality(),
        compressionLevel: currentCompressionLevel(),
        webpPreset: currentWebpPreset(),
        preset: presetEl.value,
    }));
}

function updatePresetSelection() {
    const width = readNumber(widthEl, 144);
    const height = readNumber(heightEl, 144);
    const match = presets.find((preset) => preset.width === width && preset.height === height);
    if (match)
        presetEl.value = `${match.width}x${match.height}`;
}

function setStatus(message, tone) {
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
}

function waitForPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function startConvertButtonAnimation() {
    convertButtonEl.classList.remove("is-converting");
    void convertButtonEl.offsetWidth;
    convertButtonEl.classList.add("is-converting");
}

function setBusy(nextBusy) {
    busy = nextBusy;
    document.body.classList.toggle("is-busy", busy);
    updateConvertButton();
    updateLocateButton();
}

function updateConvertButton() {
    convertButtonEl.disabled = busy || !pendingPath;
}

function updateLocateButton() {
    locateButtonEl.disabled = busy || !lastOutputPath;
    locateButtonEl.classList.toggle("is-ready", Boolean(lastOutputPath) && !busy);
}

function currentWidth() {
    return Math.max(1, Math.round(readNumber(widthEl, 144)));
}

function currentHeight() {
    return Math.max(1, Math.round(readNumber(heightEl, 144)));
}

function currentFps() {
    return clamp(Math.round(readNumber(fpsEl, 12)), 10, 30);
}

function currentQuality() {
    return clamp(snapToFive(readNumber(qualityEl, 80)), 50, 100);
}

function currentCompressionLevel() {
    return clamp(Math.round(readNumber(compressionLevelEl, 6)), 0, 6);
}

function currentWebpPreset() {
    return webpPresets.includes(webpPresetEl.value) ? webpPresetEl.value : "picture";
}

function outputLabel() {
    return outputFormat.toUpperCase();
}

function updateOutputFormatUi() {
    const isWebp = outputFormat === "webp";
    const staticInput = pendingStaticInput;
    formatToggleEl.dataset.format = outputFormat;
    formatImageEl.src = outputFormat === "webp"
        ? formatImageEl.dataset.webpSrc
        : formatImageEl.dataset.gifSrc;
    formatImageEl.alt = `any to ${outputFormat}`;
    webpOptionsEl.classList.toggle("is-disabled", !isWebp);
    fpsEl.disabled = staticInput;
    loopEl.disabled = !isWebp || staticInput;
    lossyEl.disabled = !isWebp;
    compressionLevelEl.disabled = !isWebp;
    webpPresetEl.disabled = !isWebp;
    updateQualityState();
}

function updateQualityState() {
    qualityEl.disabled = outputFormat !== "webp" || !lossyEl.checked;
}

function updateBadge(kind, info = previewInfo) {
    previewKind = kind;
    previewBadgeEl.hidden = false;
    previewBadgeEl.dataset.kind = kind;
    const parts = [kind.toUpperCase(), formatBadgeSize(info)];
    if (!info?.isStaticImage)
        parts.push(`FPS ${formatBadgeFps(info)}`);
    previewBadgeEl.textContent = parts.join(", ");
}

function renderPreview(path, kind) {
    const src = `${convertFileSrc(path)}?t=${Date.now()}`;
    const imagePreview = shouldUseImagePreview(kind);
    if (imagePreview) {
        previewImageEl.src = src;
        previewImageEl.hidden = false;
        previewVideoEl.hidden = true;
        previewVideoEl.pause();
    }
    else {
        previewVideoEl.src = src;
        previewVideoEl.hidden = false;
        previewImageEl.hidden = true;
        previewVideoEl.load();
        previewVideoEl.play().catch(() => { });
    }
    previewEmptyEl.hidden = true;
    dropzoneEl.classList.add("has-preview");
}

function resetOutputState() {
    lastOutputPath = "";
    updateLocateButton();
}

function markParamsChanged() {
    if (!pendingPath)
        return;
    renderPreview(pendingPath, pendingKind);
    previewInfo = pendingMediaInfo || { isStaticImage: pendingStaticInput };
    updateBadge(pendingKind);
    resetOutputState();
}

async function loadPreview(path) {
    const kind = fileKind(path) || "file";
    pendingPath = path;
    pendingKind = kind;
    pendingStaticInput = isStaticImageKind(kind);
    pendingMediaInfo = null;
    previewInfo = { isStaticImage: pendingStaticInput };
    resetOutputState();
    fileNameEl.textContent = path.split(/[\\/]/).pop() || kind.toUpperCase();
    renderPreview(path, kind);
    updateBadge(kind);
    updateOutputFormatUi();
    setStatus("读取文件信息...", "idle");
    updateConvertButton();
    try {
        const info = await invoke("media_info", { inputPath: path });
        if (pendingPath !== path)
            return;
        pendingMediaInfo = normalizeMediaInfo(info);
        pendingStaticInput = pendingMediaInfo.isStaticImage;
        previewInfo = pendingMediaInfo;
        updateBadge(kind);
        updateOutputFormatUi();
        if (pendingStaticInput) {
            setStatus(`${kind.toUpperCase()} 文件 原始宽 ${info.width} 高 ${info.height}`, "idle");
        }
        else {
            setStatus(`${kind.toUpperCase()} 文件 原始宽 ${info.width} 高 ${info.height} FPS${Number(info.fps.toFixed(2))} 时长 ${formatDuration(info.duration)}`, "idle");
        }
    }
    catch {
        setStatus("已载入，点击转换", "idle");
    }
}

async function convert() {
    if (busy)
        return;
    if (!pendingPath) {
        setStatus("先拖入一个文件", "error");
        return;
    }
    setBusy(true);
    startConvertButtonAnimation();
    setStatus(`正在转换 ${outputLabel()}...`, "busy");
    try {
        await waitForPaint();
        const outputWidth = currentWidth();
        const outputHeight = currentHeight();
        widthEl.value = String(outputWidth);
        heightEl.value = String(outputHeight);
        normalizeQualityInput();
        normalizeIntegerInput(compressionLevelEl, 6, 0, 6);
        webpPresetEl.value = currentWebpPreset();
        saveSettings();
        const result = await invoke("convert_file", {
            inputPath: pendingPath,
            outputFormat,
            width: outputWidth,
            height: outputHeight,
            outputDir: outputDirEl.value.trim() || desktopDir,
            fps: currentFps(),
            loopAnimation: loopEl.checked,
            lossy: lossyEl.checked,
            quality: currentQuality(),
            compressionLevel: currentCompressionLevel(),
            preset: currentWebpPreset(),
        });
        lastOutputPath = result.outputPath;
        previewInfo = normalizeMediaInfo({
            width: outputWidth,
            height: outputHeight,
            fps: pendingStaticInput ? null : currentFps(),
            isStaticImage: pendingStaticInput,
        });
        renderPreview(result.outputPath, outputFormat);
        updateBadge(outputFormat);
        updateLocateButton();
        setStatus(`转换成功，文件大小 ${formatFileSize(result.fileSize)}`, "ok");
    }
    catch (error) {
        setStatus(String(error), "error");
    }
    finally {
        setBusy(false);
    }
}

async function chooseFolder() {
    const selected = await openFolderDialog({
        directory: true,
        multiple: false,
        defaultPath: outputDirEl.value.trim() || desktopDir,
        canCreateDirectories: true,
    });
    if (typeof selected !== "string")
        return;
    outputDirEl.value = selected;
    saveSettings();
}

async function locateOutput() {
    if (!lastOutputPath || busy)
        return;
    await invoke("reveal_in_finder", { outputPath: lastOutputPath });
}

function toggleOutputFormat() {
    outputFormat = outputFormat === "webp" ? "gif" : "webp";
    updateOutputFormatUi();
    saveSettings();
    markParamsChanged();
    setStatus(`输出格式 ${outputLabel()}`, "idle");
}

async function boot() {
    presets.forEach((preset) => {
        const option = document.createElement("option");
        option.value = `${preset.width}x${preset.height}`;
        option.textContent = preset.label;
        presetEl.append(option);
    });
    try {
        desktopDir = await invoke("desktop_dir");
    }
    catch {
        desktopDir = "/Users/xiaole/Desktop";
    }
    const savedPreset = presets.find((preset) => `${preset.width}x${preset.height}` === saved.preset);
    const initialPreset = savedPreset || presets[0];
    presetEl.value = `${initialPreset.width}x${initialPreset.height}`;
    widthEl.value = String(savedPreset ? saved.width || initialPreset.width : initialPreset.width);
    heightEl.value = String(savedPreset ? saved.height || initialPreset.height : initialPreset.height);
    outputDirEl.value = saved.outputDir || desktopDir;
    fpsEl.value = String(clamp(saved.fps || 12, 10, 30));
    loopEl.checked = saved.loopAnimation ?? true;
    lossyEl.checked = saved.lossy ?? true;
    qualityEl.value = String(clamp(saved.quality || 80, 50, 100));
    compressionLevelEl.value = String(clamp(saved.compressionLevel ?? 6, 0, 6));
    webpPresetEl.value = webpPresets.includes(saved.webpPreset) ? saved.webpPreset : "picture";
    normalizeQualityInput();
    updateOutputFormatUi();
    updatePresetSelection();
    updateConvertButton();
    updateLocateButton();
    presetEl.addEventListener("change", () => {
        const preset = presets.find((item) => `${item.width}x${item.height}` === presetEl.value);
        if (!preset)
            return;
        widthEl.value = String(preset.width);
        heightEl.value = String(preset.height);
        saveSettings();
        markParamsChanged();
    });
    [widthEl, heightEl].forEach((input) => {
        input.addEventListener("change", () => {
            normalizeSizeInput(input, 144);
            updatePresetSelection();
            saveSettings();
            markParamsChanged();
        });
    });
    outputDirEl.addEventListener("input", saveSettings);
    chooseFolderEl.addEventListener("click", chooseFolder);
    convertButtonEl.addEventListener("click", convert);
    convertButtonEl.addEventListener("animationend", () => {
        convertButtonEl.classList.remove("is-converting");
    });
    locateButtonEl.addEventListener("click", locateOutput);
    formatToggleEl.addEventListener("click", toggleOutputFormat);
    fpsEl.addEventListener("input", () => {
        if (fpsEl.disabled)
            return;
        normalizeIntegerInput(fpsEl, 12, 10, 30);
        saveSettings();
        resetOutputState();
    });
    loopEl.addEventListener("change", () => {
        saveSettings();
        markParamsChanged();
    });
    lossyEl.addEventListener("change", () => {
        updateQualityState();
        saveSettings();
        markParamsChanged();
    });
    qualityEl.addEventListener("input", () => {
        normalizeQualityInput();
        saveSettings();
        markParamsChanged();
    });
    compressionLevelEl.addEventListener("input", () => {
        normalizeIntegerInput(compressionLevelEl, 6, 0, 6);
        saveSettings();
        markParamsChanged();
    });
    webpPresetEl.addEventListener("change", () => {
        webpPresetEl.value = currentWebpPreset();
        saveSettings();
        markParamsChanged();
    });
    onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
            dropzoneEl.classList.add("is-over");
        }
        if (event.payload.type === "leave") {
            dropzoneEl.classList.remove("is-over");
        }
        if (event.payload.type === "drop") {
            dropzoneEl.classList.remove("is-over");
            const input = event.payload.paths[0];
            if (input)
                loadPreview(input);
            else
                setStatus("没有找到可转换文件", "error");
        }
    });
}

boot();
