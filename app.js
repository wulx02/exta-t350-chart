"use strict";

const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d", { alpha: false });
const plotShell = document.querySelector(".plot-shell");
const loading = document.getElementById("loading");
const hoverLabel = document.getElementById("hover-label");
const datasetMeta = document.getElementById("dataset-meta");
const viewportStatus = document.getElementById("viewport-status");
const renderStatus = document.getElementById("render-status");
const selectedName = document.getElementById("selected-name");
const selectedDetails = document.getElementById("selected-details");
const selectedActions = document.getElementById("selected-actions");
const actionToggles = document.getElementById("action-toggles");

const margin = { left: 48, right: 14, top: 14, bottom: 34 };
const tilt = -17 * Math.PI / 180;
const state = {
  data: null,
  nodes: [],
  groups: new Map(),
  actions: [],
  selected: null,
  hover: null,
  visibleNodes: [],
  view: { x0: -1, x1: 80, y0: -1, y1: 45 },
  drag: null,
  frame: 0,
  lastSearch: "",
  searchIndex: 0,
};

function dataUrl() {
  return new URLSearchParams(location.search).get("data") || "chart-data.json";
}

async function initialize() {
  try {
    const response = await fetch(dataUrl());
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    if (data.schema !== "ext_product.ext_chart.v1") {
      throw new Error(`Unsupported chart schema: ${data.schema}`);
    }
    prepareData(data);
    installActionToggles();
    resizeCanvas();
    setInitialView();
    loading.hidden = true;
    requestDraw();
  } catch (error) {
    loading.textContent = `Unable to load chart data: ${error.message}`;
  }
}

function prepareData(data) {
  state.data = data;
  state.nodes = data.nodes;
  state.actions = data.actions.map((action) => ({
    ...action,
    enabled: true,
    productsBySource: new Map(action.products.map((product) => [product.source, product.targets])),
  }));
  for (const node of state.nodes) {
    const key = `${node.stem},${node.s}`;
    if (!state.groups.has(key)) state.groups.set(key, []);
    state.groups.get(key).push(node);
  }
  for (const group of state.groups.values()) {
    group.sort((a, b) => a.id - b.id);
    const count = group.length;
    const step = count > 1 ? Math.min(0.19, 0.76 / (count - 1)) : 0;
    for (let index = 0; index < count; index += 1) {
      const offset = ((count - 1) / 2 - index) * step;
      group[index].wx = group[index].stem + offset * Math.cos(tilt);
      group[index].wy = group[index].s + offset * Math.sin(tilt);
      group[index].groupIndex = index;
      group[index].groupSize = count;
    }
  }
  const { summary } = data;
  datasetMeta.textContent = `t ≤ ${data.t_max} · ${summary.additive_basis.toLocaleString()} classes · ${summary.indecomposables.toLocaleString()} generators`;
}

function installActionToggles() {
  actionToggles.replaceChildren();
  state.actions.forEach((action, index) => {
    const label = document.createElement("label");
    label.className = "action-toggle";
    label.style.setProperty("--action-color", action.color);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.addEventListener("change", () => {
      state.actions[index].enabled = input.checked;
      updateInspector();
      requestDraw();
    });
    const swatch = document.createElement("span");
    swatch.className = "action-swatch";
    const text = document.createElement("span");
    text.textContent = action.name;
    label.append(input, swatch, text);
    actionToggles.append(label);
  });
}

function setInitialView() {
  let maxStem = 0;
  let maxS = 0;
  for (const node of state.nodes) {
    maxStem = Math.max(maxStem, node.stem);
    maxS = Math.max(maxS, node.s);
  }
  state.extent = { maxStem, maxS };
  state.view = {
    x0: -1,
    x1: Math.min(maxStem + 1, 90),
    y0: -1,
    y1: Math.min(maxS + 1, 50),
  };
}

function fitAll() {
  state.view = {
    x0: -2,
    x1: state.extent.maxStem + 2,
    y0: -2,
    y1: state.extent.maxS + 2,
  };
  requestDraw();
}

function resizeCanvas() {
  const rect = plotShell.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.width = rect.width;
  state.height = rect.height;
  requestDraw();
}

function scales() {
  const width = Math.max(1, state.width - margin.left - margin.right);
  const height = Math.max(1, state.height - margin.top - margin.bottom);
  return {
    width,
    height,
    x: width / (state.view.x1 - state.view.x0),
    y: height / (state.view.y1 - state.view.y0),
  };
}

function worldToScreen(x, y) {
  const scale = scales();
  return {
    x: margin.left + (x - state.view.x0) * scale.x,
    y: margin.top + (state.view.y1 - y) * scale.y,
  };
}

function screenToWorld(x, y) {
  const scale = scales();
  return {
    x: state.view.x0 + (x - margin.left) / scale.x,
    y: state.view.y1 - (y - margin.top) / scale.y,
  };
}

function requestDraw() {
  if (state.frame) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    draw();
  });
}

function draw() {
  if (!state.data || !state.width || !state.height) return;
  const start = performance.now();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, state.width, state.height);
  drawGrid();
  drawEdges();
  drawNodes();
  drawSelectionEdges();
  drawSelectedNode();
  const elapsed = performance.now() - start;
  const shownEdges = state.actions
    .filter((action) => action.enabled)
    .reduce((sum, action) => sum + action.target_terms, 0);
  renderStatus.textContent = `${state.visibleNodes.length.toLocaleString()} visible · ${shownEdges.toLocaleString()} enabled edges · ${elapsed.toFixed(0)} ms`;
  viewportStatus.textContent = `stem ${formatRange(state.view.x0, state.view.x1)} · s ${formatRange(state.view.y0, state.view.y1)}`;
}

function gridStep(pixelsPerUnit) {
  const choices = [1, 2, 5, 10, 20, 50, 100];
  return choices.find((step) => step * pixelsPerUnit >= 45) || 200;
}

function drawGrid() {
  const scale = scales();
  const xStep = gridStep(scale.x);
  const yStep = gridStep(scale.y);
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, scale.width, scale.height);
  ctx.clip();
  drawGridAxis("x", xStep, state.view.x0, state.view.x1);
  drawGridAxis("y", yStep, state.view.y0, state.view.y1);
  ctx.restore();
  ctx.strokeStyle = "#aab3c0";
  ctx.lineWidth = 1;
  ctx.strokeRect(margin.left + 0.5, margin.top + 0.5, scale.width, scale.height);
}

function drawGridAxis(axis, step, min, max) {
  const first = Math.max(0, Math.ceil(min / step) * step);
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = "#667085";
  ctx.strokeStyle = "#e4e8ee";
  ctx.lineWidth = 1;
  for (let value = first; value <= max; value += step) {
    const point = axis === "x" ? worldToScreen(value, 0) : worldToScreen(0, value);
    ctx.beginPath();
    if (axis === "x") {
      ctx.moveTo(point.x + 0.5, margin.top);
      ctx.lineTo(point.x + 0.5, state.height - margin.bottom);
      ctx.fillText(String(value), point.x + 3, state.height - margin.bottom + 16);
    } else {
      ctx.moveTo(margin.left, point.y + 0.5);
      ctx.lineTo(state.width - margin.right, point.y + 0.5);
      ctx.fillText(String(value), 7, point.y - 3);
    }
    ctx.stroke();
  }
}

function pointVisible(node, padding = 1) {
  return node.wx >= state.view.x0 - padding && node.wx <= state.view.x1 + padding
    && node.wy >= state.view.y0 - padding && node.wy <= state.view.y1 + padding;
}

function drawEdges() {
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, scales().width, scales().height);
  ctx.clip();
  const dimmed = state.selected !== null;
  for (const action of state.actions) {
    if (!action.enabled) continue;
    ctx.strokeStyle = colorWithAlpha(action.color, dimmed ? 0.055 : 0.18);
    ctx.lineWidth = dimmed ? 0.55 : 0.75;
    ctx.beginPath();
    for (const product of action.products) {
      const source = state.nodes[product.source];
      if (!pointVisible(source, action.t + action.s + 2)) continue;
      const a = worldToScreen(source.wx, source.wy);
      for (const targetId of product.targets) {
        const target = state.nodes[targetId];
        if (!pointVisible(target, action.t + action.s + 2)) continue;
        const b = worldToScreen(target.wx, target.wy);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawNodes() {
  const scale = scales();
  const radius = Math.max(1.35, Math.min(4.2, Math.min(scale.x, scale.y) * 0.075));
  state.visibleNodes = [];
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, scale.width, scale.height);
  ctx.clip();
  for (const node of state.nodes) {
    if (!pointVisible(node, 0.2)) continue;
    const point = worldToScreen(node.wx, node.wy);
    node.sx = point.x;
    node.sy = point.y;
    state.visibleNodes.push(node);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    if (node.factors.length === 1) {
      ctx.fillStyle = "#1f5fae";
      ctx.fill();
    } else {
      ctx.fillStyle = "#111827";
      ctx.fill();
    }
  }
  ctx.restore();
  state.pointRadius = radius;
}

function drawSelectionEdges() {
  if (state.selected === null) return;
  const selected = state.nodes[state.selected];
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, scales().width, scales().height);
  ctx.clip();
  for (const action of state.actions) {
    if (!action.enabled) continue;
    ctx.strokeStyle = colorWithAlpha(action.color, 0.92);
    ctx.lineWidth = 2;
    ctx.beginPath();
    const outgoing = action.productsBySource.get(selected.id) || [];
    const a = worldToScreen(selected.wx, selected.wy);
    for (const targetId of outgoing) {
      const target = state.nodes[targetId];
      const b = worldToScreen(target.wx, target.wy);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (const product of action.products) {
      if (!product.targets.includes(selected.id)) continue;
      const source = state.nodes[product.source];
      const b = worldToScreen(source.wx, source.wy);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawSelectedNode() {
  if (state.selected === null) return;
  const node = state.nodes[state.selected];
  const point = worldToScreen(node.wx, node.wy);
  ctx.beginPath();
  ctx.arc(point.x, point.y, Math.max(5, state.pointRadius + 3), 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#dc2626";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(point.x, point.y, Math.max(1.8, state.pointRadius), 0, Math.PI * 2);
  ctx.fillStyle = node.factors.length === 1 ? "#1f5fae" : "#111827";
  ctx.fill();
}

function colorWithAlpha(hex, alpha) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function nearestVisibleNode(x, y) {
  let best = null;
  let bestDistance = 11;
  for (const node of state.visibleNodes) {
    const distance = Math.hypot(node.sx - x, node.sy - y);
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

function selectNode(id, center = false) {
  state.selected = id;
  const node = state.nodes[id];
  if (center) {
    const width = Math.min(48, state.view.x1 - state.view.x0);
    const height = Math.min(34, state.view.y1 - state.view.y0);
    state.view = {
      x0: Math.max(-1, node.stem - width / 2),
      x1: Math.max(-1, node.stem - width / 2) + width,
      y0: Math.max(-1, node.s - height / 2),
      y1: Math.max(-1, node.s - height / 2) + height,
    };
  }
  updateInspector();
  requestDraw();
}

function updateInspector() {
  if (state.selected === null) {
    selectedName.textContent = "None";
    selectedDetails.replaceChildren();
    selectedActions.replaceChildren();
    return;
  }
  const node = state.nodes[state.selected];
  selectedName.textContent = `m${node.id} = ${formatFactors(node.factors)}`;
  selectedDetails.innerHTML = [
    ["Bidegree", `(${node.s}, ${node.t})`],
    ["Chart", `(${node.stem}, ${node.s})`],
    ["Multiplicity", `${node.groupIndex + 1} of ${node.groupSize}`],
    ["Factors", `<code>${escapeHtml(formatFactors(node.factors))}</code>`],
    ["Coordinates", `<code>${escapeHtml(formatCoordinates(node.coordinates))}</code>`],
  ].map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("");
  selectedActions.replaceChildren();
  for (const action of state.actions) {
    const row = document.createElement("div");
    row.className = "selected-action";
    const title = document.createElement("div");
    title.className = "action-title";
    title.innerHTML = `<span class="action-swatch" style="--action-color:${action.color}"></span><span>${escapeHtml(action.name)} · m${node.id}</span>`;
    const value = document.createElement("div");
    value.className = "action-value";
    if (node.t + action.t > state.data.t_max) {
      value.textContent = "outside t cutoff";
    } else {
      const targets = action.productsBySource.get(node.id) || [];
      value.textContent = targets.length ? targets.map((id) => `m${id}`).join(" + ") : "0";
    }
    row.append(title, value);
    selectedActions.append(row);
  }
}

function formatFactors(factors) {
  if (!factors.length) return "1";
  const parts = [];
  for (let index = 0; index < factors.length;) {
    const id = factors[index];
    let end = index + 1;
    while (end < factors.length && factors[end] === id) end += 1;
    const name = state.data.generators[id]?.name || `x${id}`;
    parts.push(end - index === 1 ? name : `${name}^${end - index}`);
    index = end;
  }
  return parts.join(" ");
}

function formatCoordinates(coordinates) {
  const shown = coordinates.slice(0, 24).map((id) => `g${id}`).join(" + ");
  return coordinates.length > 24 ? `${shown} + … (${coordinates.length} terms)` : shown;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function zoomAt(factor, screenX = state.width / 2, screenY = state.height / 2) {
  const anchor = screenToWorld(screenX, screenY);
  const width = (state.view.x1 - state.view.x0) * factor;
  const height = (state.view.y1 - state.view.y0) * factor;
  const xRatio = (screenX - margin.left) / scales().width;
  const yRatio = 1 - (screenY - margin.top) / scales().height;
  state.view = {
    x0: anchor.x - width * xRatio,
    x1: anchor.x + width * (1 - xRatio),
    y0: anchor.y - height * yRatio,
    y1: anchor.y + height * (1 - yRatio),
  };
  requestDraw();
}

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  zoomAt(event.deltaY > 0 ? 1.16 : 0.86, event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  state.drag = {
    x: event.clientX,
    y: event.clientY,
    view: { ...state.view },
    moved: false,
  };
  canvas.classList.add("dragging");
});

canvas.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (state.drag) {
    const dx = event.clientX - state.drag.x;
    const dy = event.clientY - state.drag.y;
    state.drag.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
    const scale = scales();
    state.view = {
      x0: state.drag.view.x0 - dx / scale.x,
      x1: state.drag.view.x1 - dx / scale.x,
      y0: state.drag.view.y0 + dy / scale.y,
      y1: state.drag.view.y1 + dy / scale.y,
    };
    hoverLabel.hidden = true;
    requestDraw();
    return;
  }
  const node = nearestVisibleNode(x, y);
  if (!node) {
    hoverLabel.hidden = true;
    return;
  }
  hoverLabel.hidden = false;
  hoverLabel.textContent = `m${node.id} · (${node.stem}, ${node.s}) · ${formatFactors(node.factors)}`;
  hoverLabel.style.left = `${Math.min(state.width - 320, x + 12)}px`;
  hoverLabel.style.top = `${Math.max(4, y - 32)}px`;
});

canvas.addEventListener("pointerup", (event) => {
  const drag = state.drag;
  state.drag = null;
  canvas.classList.remove("dragging");
  if (!drag || drag.moved) return;
  const rect = canvas.getBoundingClientRect();
  const node = nearestVisibleNode(event.clientX - rect.left, event.clientY - rect.top);
  if (node) selectNode(node.id);
});

canvas.addEventListener("pointerleave", () => {
  if (!state.drag) hoverLabel.hidden = true;
});

document.getElementById("zoom-in").addEventListener("click", () => zoomAt(0.72));
document.getElementById("zoom-out").addEventListener("click", () => zoomAt(1.38));
document.getElementById("fit-view").addEventListener("click", fitAll);

document.getElementById("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = document.getElementById("search-input").value.trim();
  const matches = searchNodes(query);
  if (!matches.length) {
    document.getElementById("search-input").setCustomValidity("No matching class");
    document.getElementById("search-input").reportValidity();
    return;
  }
  document.getElementById("search-input").setCustomValidity("");
  if (state.lastSearch === query) state.searchIndex = (state.searchIndex + 1) % matches.length;
  else state.searchIndex = 0;
  state.lastSearch = query;
  selectNode(matches[state.searchIndex].id, true);
});

function searchNodes(query) {
  let match = query.match(/^m(\d+)$/i);
  if (match) return state.nodes[Number(match[1])] ? [state.nodes[Number(match[1])]] : [];
  match = query.match(/^g(\d+)$/i);
  if (match) {
    const basisId = Number(match[1]);
    return state.nodes.filter((node) => node.coordinates.includes(basisId));
  }
  match = query.match(/^x(\d+)$/i);
  if (match) {
    const generatorId = Number(match[1]);
    return state.nodes.filter((node) => node.factors.length === 1 && node.factors[0] === generatorId);
  }
  match = query.match(/^(-?\d+)\s*,\s*(-?\d+)$/);
  if (match) return state.groups.get(`${Number(match[1])},${Number(match[2])}`) || [];
  const generator = state.data.generators.find((item) => item.name.toLowerCase() === query.toLowerCase());
  if (generator) {
    return state.nodes.filter((node) => node.factors.length === 1 && node.factors[0] === generator.id);
  }
  return [];
}

function formatRange(min, max) {
  return `${Math.max(0, Math.ceil(min))}–${Math.floor(max)}`;
}

window.addEventListener("resize", resizeCanvas);
initialize();
