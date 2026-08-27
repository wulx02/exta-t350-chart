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
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const searchButton = document.getElementById("search-button");

const margin = { left: 58, right: 14, top: 14, bottom: 50 };
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
    searchInput.disabled = false;
    searchButton.disabled = false;
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
    enabled: ["h0", "h1", "h2"].includes(action.name),
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
    input.checked = action.enabled;
    input.addEventListener("change", () => {
      state.actions[index].enabled = input.checked;
      updateInspector();
      requestDraw();
    });
    const swatch = document.createElement("span");
    swatch.className = "action-swatch";
    const text = document.createElement("span");
    text.innerHTML = formatGeneratorMathHtml(action.name);
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
    x0: 0,
    x1: Math.min(maxStem + 1, 90),
    y0: 0,
    y1: Math.min(maxS + 1, 50),
  };
}

function fitAll() {
  state.view = {
    x0: 0,
    x1: state.extent.maxStem + 2,
    y0: 0,
    y1: state.extent.maxS + 2,
  };
  requestDraw();
}

function constrainToFirstQuadrant(view) {
  const constrained = { ...view };
  if (constrained.x0 < 0) {
    constrained.x1 -= constrained.x0;
    constrained.x0 = 0;
  }
  if (constrained.y0 < 0) {
    constrained.y1 -= constrained.y0;
    constrained.y0 = 0;
  }
  return constrained;
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

function gridStep(pixelsPerUnit, minimumSpacing) {
  const rawStep = Math.max(1, minimumSpacing / Math.max(pixelsPerUnit, Number.EPSILON));
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceMultiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(1, niceMultiplier * magnitude);
}

function drawGrid() {
  const scale = scales();
  const xTicks = gridTicks(state.view.x0, state.view.x1, gridStep(scale.x, 72));
  const yTicks = gridTicks(state.view.y0, state.view.y1, gridStep(scale.y, 48));

  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, scale.width, scale.height);
  ctx.clip();
  drawGridLines("x", xTicks);
  drawGridLines("y", yTicks);
  ctx.restore();

  ctx.strokeStyle = "#aab3c0";
  ctx.lineWidth = 1;
  ctx.strokeRect(margin.left + 0.5, margin.top + 0.5, scale.width, scale.height);
  drawGridLabels("x", xTicks);
  drawGridLabels("y", yTicks);
}

function gridTicks(min, max, step) {
  const ticks = [];
  const first = Math.max(0, Math.ceil(min / step) * step);
  for (let value = first; value <= max + step * 1e-9; value += step) {
    ticks.push(value);
  }
  return ticks;
}

function drawGridLines(axis, ticks) {
  ctx.strokeStyle = "#e4e8ee";
  ctx.lineWidth = 1;
  for (const value of ticks) {
    const point = axis === "x" ? worldToScreen(value, 0) : worldToScreen(0, value);
    ctx.beginPath();
    if (axis === "x") {
      ctx.moveTo(point.x + 0.5, margin.top);
      ctx.lineTo(point.x + 0.5, state.height - margin.bottom);
    } else {
      ctx.moveTo(margin.left, point.y + 0.5);
      ctx.lineTo(state.width - margin.right, point.y + 0.5);
    }
    ctx.stroke();
  }
}

function drawGridLabels(axis, ticks) {
  const plotBottom = state.height - margin.bottom;
  ctx.save();
  ctx.font = '11px "Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = "#5f6b7e";
  ctx.strokeStyle = "#aab3c0";
  ctx.lineWidth = 1;

  if (axis === "x") {
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
  } else {
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
  }

  for (const value of ticks) {
    const point = axis === "x" ? worldToScreen(value, 0) : worldToScreen(0, value);
    ctx.beginPath();
    if (axis === "x") {
      ctx.moveTo(point.x + 0.5, plotBottom);
      ctx.lineTo(point.x + 0.5, plotBottom + 5);
      ctx.stroke();
      ctx.fillText(String(value), point.x, plotBottom + 8);
    } else {
      ctx.moveTo(margin.left - 5, point.y + 0.5);
      ctx.lineTo(margin.left, point.y + 0.5);
      ctx.stroke();
      ctx.fillText(String(value), margin.left - 9, point.y);
    }
  }
  ctx.restore();
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
    const x0 = Math.max(0, node.wx - width / 2);
    const y0 = Math.max(0, node.wy - height / 2);
    state.view = { x0, x1: x0 + width, y0, y1: y0 + height };
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
  selectedName.innerHTML = formatClassMathHtml(node);
  selectedDetails.innerHTML = [
    ["(s,t)", `(${node.s}, ${node.t})`],
    ["(stem,s)", `(${node.stem}, ${node.s})`],
    ["Multiplicity", `${node.groupIndex + 1} of ${node.groupSize}`],
    ["Factors", formatFactorsMathHtml(node.factors)],
  ].map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("");
  selectedActions.replaceChildren();
  for (const action of state.actions) {
    const row = document.createElement("div");
    row.className = "selected-action";
    const title = document.createElement("div");
    title.className = "action-title";
    title.innerHTML = `<span class="action-swatch" style="--action-color:${action.color}"></span>${formatActionMathHtml(action.name, node.id)}`;
    const value = document.createElement("div");
    value.className = "action-value";
    if (node.t + action.t > state.data.t_max) {
      value.textContent = "outside t cutoff";
    } else {
      const targets = action.productsBySource.get(node.id) || [];
      value.innerHTML = formatTargetSumMathHtml(targets);
    }
    row.append(title, value);
    selectedActions.append(row);
  }
}

function factorGroups(factors) {
  const groups = [];
  for (let index = 0; index < factors.length;) {
    const id = factors[index];
    let end = index + 1;
    while (end < factors.length && factors[end] === id) end += 1;
    groups.push({ id, exponent: end - index });
    index = end;
  }
  return groups;
}

function formatFactorsText(factors) {
  if (!factors.length) return "1";
  return factorGroups(factors).map(({ id, exponent }) => {
    const name = state.data.generators[id]?.name || `x${id}`;
    return exponent === 1 ? name : `${name}^${exponent}`;
  }).join(" ");
}

function generatorMathNode(name, exponent = 1) {
  const hMatch = /^h(\d+)$/.exec(name);
  const xMatch = /^x_\{(\d+(?:,\d+)*)\}$/.exec(name);
  let symbol;
  let subscript;

  if (hMatch) {
    symbol = "<mi>h</mi>";
    subscript = `<mn>${hMatch[1]}</mn>`;
  } else if (xMatch) {
    symbol = "<mi>x</mi>";
    const indices = xMatch[1].split(",");
    subscript = `<mrow>${indices.map((value) => `<mn>${value}</mn>`).join("<mo>,</mo>")}</mrow>`;
  } else {
    const fallback = `<mi>${escapeHtml(name)}</mi>`;
    return exponent === 1 ? fallback : `<msup>${fallback}<mn>${exponent}</mn></msup>`;
  }

  return exponent === 1
    ? `<msub>${symbol}${subscript}</msub>`
    : `<msubsup>${symbol}${subscript}<mn>${exponent}</mn></msubsup>`;
}

function classMathNode(id) {
  return `<msub><mi>m</mi><mn>${id}</mn></msub>`;
}

function factorsMathNodes(factors) {
  if (!factors.length) return "<mn>1</mn>";
  return factorGroups(factors)
    .map(({ id, exponent }) => {
      const name = state.data.generators[id]?.name || `x${id}`;
      return generatorMathNode(name, exponent);
    })
    .join('<mspace width="0.22em"></mspace>');
}

function wrapMath(content, label, extraClass = "") {
  const className = ["math-expression", extraClass].filter(Boolean).join(" ");
  return `<math class="${className}" aria-label="${escapeHtml(label)}"><mrow>${content}</mrow></math>`;
}

function formatGeneratorMathHtml(name) {
  return wrapMath(generatorMathNode(name), name);
}

function formatFactorsMathHtml(factors) {
  return wrapMath(factorsMathNodes(factors), formatFactorsText(factors));
}

function formatClassMathHtml(node) {
  const label = `m${node.id} = ${formatFactorsText(node.factors)}`;
  return wrapMath(`${classMathNode(node.id)}<mo>=</mo>${factorsMathNodes(node.factors)}`, label, "class-expression");
}

function formatActionMathHtml(actionName, nodeId) {
  return wrapMath(`${generatorMathNode(actionName)}<mo>·</mo>${classMathNode(nodeId)}`, `${actionName} times m${nodeId}`);
}

function formatTargetSumMathHtml(targets) {
  if (!targets.length) return wrapMath("<mn>0</mn>", "0");
  const content = targets.map((id) => classMathNode(id)).join("<mo>+</mo>");
  return wrapMath(content, targets.map((id) => `m${id}`).join(" plus "));
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
  state.view = constrainToFirstQuadrant({
    x0: anchor.x - width * xRatio,
    x1: anchor.x + width * (1 - xRatio),
    y0: anchor.y - height * yRatio,
    y1: anchor.y + height * (1 - yRatio),
  });
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
    state.view = constrainToFirstQuadrant({
      x0: state.drag.view.x0 - dx / scale.x,
      x1: state.drag.view.x1 - dx / scale.x,
      y0: state.drag.view.y0 + dy / scale.y,
      y1: state.drag.view.y1 + dy / scale.y,
    });
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
  hoverLabel.innerHTML = formatClassMathHtml(node);
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

searchInput.addEventListener("input", () => searchInput.setCustomValidity(""));

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  const match = query.match(/^m(\d+)$/i);

  if (!match) {
    searchInput.setCustomValidity("Enter m followed by digits, for example m68130.");
    searchInput.reportValidity();
    return;
  }

  const node = state.nodes[Number(match[1])];
  if (!node) {
    searchInput.setCustomValidity(`Class m${match[1]} was not found.`);
    searchInput.reportValidity();
    return;
  }

  searchInput.setCustomValidity("");
  searchInput.value = `m${node.id}`;
  selectNode(node.id, true);
});

function formatRange(min, max) {
  return `${Math.max(0, Math.ceil(min))}–${Math.floor(max)}`;
}

window.addEventListener("resize", resizeCanvas);
initialize();
