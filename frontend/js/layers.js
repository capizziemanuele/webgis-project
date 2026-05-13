// ===== Layer Management =====
window.mapLayers = {};
window.pendingLayers = [];
window.layerOrder = []; // [id, ...] bottom-to-top render order

const RASTER_GRADIENTS = {
  gray:    'linear-gradient(to right, #000, #fff)',
  viridis: 'linear-gradient(to right, #440154, #31688e, #35b779, #fde725)',
  plasma:  'linear-gradient(to right, #0d0887, #7e03a8, #cc4778, #f89441, #f0f921)',
  hot:     'linear-gradient(to right, #000, #880000, #f00, #ff0, #fff)',
  terrain: 'linear-gradient(to right, #334099, #3387c8, #66b866, #cccc44, #996633, #fff)',
  rdylgn:  'linear-gradient(to right, #a50026, #f46d43, #fee08b, #a6d96a, #1a9850)',
};

async function loadAllLayers() {
  try {
    const res = await apiFetch('/api/layers/');
    if (!res.ok) return;
    const layers = await res.json();
    for (const layer of layers.reverse()) {
      await loadLayer(layer);
    }
  } catch (err) {
    console.error('Failed to load layers:', err);
  }
}

async function loadLayer(layerMeta) {
  const entry = {
    id: layerMeta.id,
    name: layerMeta.name,
    type: layerMeta.layer_type,
    geomType: layerMeta.geom_type,
    style: layerMeta.style || {},
    visible: true,
    bbox: layerMeta.bbox,
    featureCount: layerMeta.feature_count,
    sourceInfo: layerMeta.source_info || {},
  };
  window.mapLayers[layerMeta.id] = entry;

  if (!window.layerOrder.includes(layerMeta.id)) {
    window.layerOrder.push(layerMeta.id);
  }

  if (map.loaded()) {
    addLayerToMap(entry);
  } else {
    (window.pendingLayers = window.pendingLayers || []).push(entry);
    map.once('load', () => addLayerToMap(entry));
  }

  renderLayerList();

  // Auto-load global stats for rasters so legend and tiles use real values
  if (layerMeta.layer_type === 'raster') {
    _autoLoadRasterStats(entry);
  }
}

async function _autoLoadRasterStats(entry) {
  if (entry._statsLoaded) return;
  try {
    const res = await apiFetch(`/api/layers/${entry.id}/stats`);
    if (!res.ok) return;
    const data = await res.json();
    entry._stats = data.bands;
    entry._statsLoaded = true;

    // Apply global p2/p98 as smin/smax only if not already set by user
    const band1 = data.bands && data.bands[0];
    if (band1 && entry.style.smin === undefined && band1.p2 !== null) {
      entry.style.smin = band1.p2;
      entry.style.smax = band1.p98;
      // Rebuild tile source with correct stretch range
      addLayerToMap(entry);
      // Persist to API (silent)
      apiFetch(`/api/layers/${entry.id}/style`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style: entry.style }),
      });
    }
    renderLayerList();
  } catch (_) {}
}

function addLayerToMap(entry) {
  const sourceId = `wgis-${entry.id}`;
  const layerId = `wgis-layer-${entry.id}`;

  if (map.getLayer(`${layerId}-fill`)) map.removeLayer(`${layerId}-fill`);
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  if (entry.type === 'raster') {
    const colormap = (entry.style && entry.style.colormap) || 'gray';
    let tileUrl = `${API}/api/layers/${entry.id}/tiles/{z}/{x}/{y}.png?cm=${colormap}`;
    if (entry.style.smin !== undefined && entry.style.smax !== undefined) {
      tileUrl += `&smin=${entry.style.smin}&smax=${entry.style.smax}`;
    }
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [tileUrl],
      tileSize: 256,
    });
    map.addLayer({
      id: layerId,
      type: 'raster',
      source: sourceId,
      paint: { 'raster-opacity': entry.style.opacity ?? 0.8 },
    });
  } else {
    map.addSource(sourceId, {
      type: 'geojson',
      data: `${API}/api/layers/${entry.id}/geojson`,
      generateId: true,
    });
    addVectorLayer(sourceId, layerId, entry);
  }

  if (!entry.visible) {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none');
    if (map.getLayer(`${layerId}-fill`)) map.setLayoutProperty(`${layerId}-fill`, 'visibility', 'none');
  }
}

function addVectorLayer(sourceId, layerId, entry) {
  const style = entry.style || {};
  const geomType = entry.geomType || 'Point';
  const color = style.color || '#3388ff';
  const fillColor = style.fillColor || color;
  const opacity = style.opacity ?? 0.8;
  const fillOpacity = style.fillOpacity ?? 0.5;

  if (geomType === 'Point' || geomType === 'Mixed') {
    if (style.iconUrl) {
      const imgId = `icon-${entry.id}`;
      if (!map.hasImage(imgId)) {
        const img = new Image(64, 64);
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          if (!map.hasImage(imgId)) map.addImage(imgId, img);
          map.addLayer({
            id: layerId,
            type: 'symbol',
            source: sourceId,
            layout: {
              'icon-image': imgId,
              'icon-allow-overlap': true,
              'icon-size': style.zoomScaling !== false
                ? ['interpolate', ['linear'], ['zoom'], 8, 0.3, 13, 0.6, 18, 1.0]
                : 0.6,
            },
          });
        };
        img.onerror = () => addCircleLayer(sourceId, layerId, entry);
        img.src = style.iconUrl;
        return;
      }
    }
    addCircleLayer(sourceId, layerId, entry);
  } else if (geomType === 'LineString') {
    map.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': color,
        'line-width': style.weight ?? 2,
        'line-opacity': opacity,
      },
    });
  } else if (geomType === 'Polygon') {
    map.addLayer({
      id: `${layerId}-fill`,
      type: 'fill',
      source: sourceId,
      paint: { 'fill-color': fillColor, 'fill-opacity': fillOpacity },
    });
    map.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': color,
        'line-width': style.weight ?? 1,
        'line-opacity': opacity,
      },
    });
  } else {
    addCircleLayer(sourceId, layerId, entry);
  }
}

function addCircleLayer(sourceId, layerId, entry) {
  const style = entry.style || {};
  const color = style.color || '#3388ff';
  const opacity = style.opacity ?? 0.8;
  const minR = style.minZoomRadius ?? 4;
  const maxR = style.maxZoomRadius ?? 16;

  const radiusExpr = style.zoomScaling !== false
    ? ['interpolate', ['linear'], ['zoom'], 8, minR / 2, 13, minR, 18, maxR]
    : style.radius ?? 8;

  map.addLayer({
    id: layerId,
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-radius': radiusExpr,
      'circle-color': color,
      'circle-opacity': opacity,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': 'rgba(255,255,255,0.7)',
    },
  });
}

function setLayerVisibility(layerId, visible) {
  const entry = window.mapLayers[layerId];
  if (!entry) return;
  entry.visible = visible;

  const mapLayerId = `wgis-layer-${layerId}`;
  const vis = visible ? 'visible' : 'none';
  if (map.getLayer(mapLayerId)) map.setLayoutProperty(mapLayerId, 'visibility', vis);
  if (map.getLayer(`${mapLayerId}-fill`)) map.setLayoutProperty(`${mapLayerId}-fill`, 'visibility', vis);
}

function updateLayerStyle(layerId, newStyle) {
  const entry = window.mapLayers[layerId];
  if (!entry) return;
  entry.style = { ...entry.style, ...newStyle };

  const mapLayerId = `wgis-layer-${layerId}`;
  const color = entry.style.color || '#3388ff';
  const opacity = entry.style.opacity ?? 0.8;

  try {
    if (entry.type === 'raster') {
      if (map.getLayer(mapLayerId)) map.setPaintProperty(mapLayerId, 'raster-opacity', opacity);
    } else if (entry.geomType === 'Point' || !entry.geomType) {
      if (map.getLayer(mapLayerId)) {
        const minR = entry.style.minZoomRadius ?? 4;
        const maxR = entry.style.maxZoomRadius ?? 16;
        const radiusExpr = entry.style.zoomScaling !== false
          ? ['interpolate', ['linear'], ['zoom'], 8, minR / 2, 13, minR, 18, maxR]
          : entry.style.radius ?? 8;
        map.setPaintProperty(mapLayerId, 'circle-radius', radiusExpr);
        map.setPaintProperty(mapLayerId, 'circle-color', color);
        map.setPaintProperty(mapLayerId, 'circle-opacity', opacity);
      }
    } else if (entry.geomType === 'LineString') {
      if (map.getLayer(mapLayerId)) {
        map.setPaintProperty(mapLayerId, 'line-color', color);
        map.setPaintProperty(mapLayerId, 'line-opacity', opacity);
        map.setPaintProperty(mapLayerId, 'line-width', entry.style.weight ?? 2);
      }
    } else if (entry.geomType === 'Polygon') {
      if (map.getLayer(`${mapLayerId}-fill`)) {
        map.setPaintProperty(`${mapLayerId}-fill`, 'fill-color', entry.style.fillColor || color);
        map.setPaintProperty(`${mapLayerId}-fill`, 'fill-opacity', entry.style.fillOpacity ?? 0.5);
      }
      if (map.getLayer(mapLayerId)) {
        map.setPaintProperty(mapLayerId, 'line-color', color);
        map.setPaintProperty(mapLayerId, 'line-opacity', opacity);
      }
    }
  } catch (e) {
    console.warn('Style update error:', e);
    addLayerToMap(entry);
  }
}

function zoomToLayer(layerId) {
  const entry = window.mapLayers[layerId];
  if (!entry || !entry.bbox) return;
  const [minX, minY, maxX, maxY] = entry.bbox;
  map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 60, maxZoom: 16, duration: 1000 });
}

async function deleteLayer(layerId) {
  if (!confirm('Delete this layer?')) return;

  const res = await apiFetch(`/api/layers/${layerId}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Failed to delete layer', 'error'); return; }

  const mapLayerId = `wgis-layer-${layerId}`;
  if (map.getLayer(mapLayerId)) map.removeLayer(mapLayerId);
  if (map.getLayer(`${mapLayerId}-fill`)) map.removeLayer(`${mapLayerId}-fill`);
  if (map.getSource(`wgis-${layerId}`)) map.removeSource(`wgis-${layerId}`);

  delete window.mapLayers[layerId];
  window.layerOrder = window.layerOrder.filter(id => id !== layerId);
  renderLayerList();
  showToast('Layer deleted', 'success');
}

// ===== Layer Reordering =====
function reapplyMapLayerOrder() {
  if (!window.layerOrder) return;
  window.layerOrder.forEach(id => {
    const mapLayerId = `wgis-layer-${id}`;
    if (map.getLayer(`${mapLayerId}-fill`)) map.moveLayer(`${mapLayerId}-fill`);
    if (map.getLayer(mapLayerId)) map.moveLayer(mapLayerId);
  });
}

window.moveLayerInList = (layerId, direction) => {
  if (!window.layerOrder) return;
  const idx = window.layerOrder.indexOf(layerId);
  if (idx === -1) return;

  if (direction === 'up' && idx < window.layerOrder.length - 1) {
    [window.layerOrder[idx], window.layerOrder[idx + 1]] = [window.layerOrder[idx + 1], window.layerOrder[idx]];
  } else if (direction === 'down' && idx > 0) {
    [window.layerOrder[idx], window.layerOrder[idx - 1]] = [window.layerOrder[idx - 1], window.layerOrder[idx]];
  } else {
    return;
  }

  reapplyMapLayerOrder();
  renderLayerList();
};

// ===== Legend Rendering =====
function _fmt(v) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 10000 || (Math.abs(n) < 0.01 && n !== 0)) return n.toExponential(2);
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function renderLayerLegend(l) {
  if (l.type === 'raster') {
    const colormap = l.style.colormap || 'gray';
    const gradient = RASTER_GRADIENTS[colormap] || RASTER_GRADIENTS.gray;
    const stats = l._stats && l._stats[0];

    const lo = l.style.smin !== undefined ? l.style.smin : (stats ? stats.p2 : null);
    const hi = l.style.smax !== undefined ? l.style.smax : (stats ? stats.p98 : null);
    const loading = !l._statsLoaded;

    const rangeRow = loading
      ? `<span class="legend-loading"><i class="fas fa-spinner fa-spin"></i> loading stats…</span>`
      : `<span>${_fmt(lo)}</span><span class="legend-cm-name">${colormap}</span><span>${_fmt(hi)}</span>`;

    const statsRow = stats
      ? `<div class="legend-stats-row">
           <span>min <b>${_fmt(stats.min)}</b></span>
           <span>max <b>${_fmt(stats.max)}</b></span>
           <span>mean <b>${_fmt(stats.mean)}</b></span>
         </div>`
      : '';

    return `
      <div class="layer-legend raster-legend">
        <div class="legend-gradient" style="background:${gradient}"></div>
        <div class="legend-range">${rangeRow}</div>
        ${statsRow}
      </div>`;
  } else {
    const color = l.style.color || '#3388ff';
    const fillColor = l.style.fillColor || color;
    const geomType = l.geomType || 'Point';
    let symbol = '';
    if (geomType === 'Polygon') {
      symbol = `<div class="legend-polygon" style="background:${fillColor};border:2px solid ${color}"></div>`;
    } else if (geomType === 'LineString') {
      symbol = `<div class="legend-line" style="background:${color}"></div>`;
    } else {
      symbol = `<div class="legend-circle" style="background:${color}"></div>`;
    }
    const count = l.featureCount > 0 ? `${l.featureCount.toLocaleString()} features` : '';
    return `
      <div class="layer-legend vector-legend">
        ${symbol}
        <span class="legend-label">${count}</span>
      </div>`;
  }
}

// ===== Layer List Rendering =====
function renderLayerList() {
  const list = document.getElementById('layerList');

  // Sync layerOrder with mapLayers
  window.layerOrder = (window.layerOrder || []).filter(id => window.mapLayers[id]);
  Object.keys(window.mapLayers).forEach(id => {
    const numId = parseInt(id);
    if (!window.layerOrder.includes(numId)) window.layerOrder.push(numId);
  });

  const totalLayers = window.layerOrder.length;
  const layers = window.layerOrder.slice().reverse().map(id => window.mapLayers[id]).filter(Boolean);

  document.getElementById('layerCount').textContent = layers.length;

  if (layers.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-layer-group"></i>
        <p>No layers yet.<br>Upload data or fetch from OSM.</p>
      </div>`;
    return;
  }

  list.innerHTML = layers.map(l => {
    const orderIdx = window.layerOrder.indexOf(l.id);
    const typeClass = { vector: 'badge-vector', raster: 'badge-raster', osm: 'badge-osm' }[l.type] || 'badge-vector';
    const dotColor = l.style.color || (l.type === 'raster' ? '#2ecc71' : '#3388ff');
    const isTop = orderIdx === totalLayers - 1;
    const isBottom = orderIdx === 0;
    return `
      <div class="layer-item" id="layer-item-${l.id}">
        <div class="layer-header" onclick="toggleLayerExpand(${l.id})">
          <button class="layer-visibility ${l.visible ? '' : 'hidden'}" onclick="event.stopPropagation();toggleLayerVisibility(${l.id})" title="${l.visible ? 'Hide' : 'Show'}">
            <i class="fas fa-${l.visible ? 'eye' : 'eye-slash'}"></i>
          </button>
          <div class="layer-color-dot" style="background:${dotColor}"></div>
          <span class="layer-name" title="${l.name}">${l.name}</span>
          <span class="layer-type-badge ${typeClass}">${l.type}</span>
          <div class="layer-reorder-btns" onclick="event.stopPropagation()">
            <button class="layer-reorder-btn" onclick="moveLayerInList(${l.id},'up')" title="Bring forward" ${isTop ? 'disabled' : ''}>
              <i class="fas fa-chevron-up"></i>
            </button>
            <button class="layer-reorder-btn" onclick="moveLayerInList(${l.id},'down')" title="Send backward" ${isBottom ? 'disabled' : ''}>
              <i class="fas fa-chevron-down"></i>
            </button>
          </div>
        </div>
        ${renderLayerLegend(l)}
        <div class="layer-controls" id="layer-controls-${l.id}">
          <div class="ctrl-row">
            <span class="ctrl-label">Opacity</span>
            <input type="range" min="0" max="1" step="0.05" value="${l.style.opacity ?? 0.8}"
              oninput="onOpacityChange(${l.id}, this.value)" />
            <span style="font-size:10px;color:var(--text-muted);width:30px">${Math.round((l.style.opacity ?? 0.8) * 100)}%</span>
          </div>
          <div class="ctrl-row">
            <div class="layer-action-btns">
              <button class="layer-action-btn" onclick="zoomToLayer(${l.id})" title="Zoom to layer">
                <i class="fas fa-search-plus"></i> Zoom
              </button>
              <button class="layer-action-btn" onclick="openSymbology(${l.id})" title="Edit symbology">
                <i class="fas fa-palette"></i> Style
              </button>
              <button class="layer-action-btn danger" onclick="deleteLayer(${l.id})" title="Delete layer">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.toggleLayerExpand = (layerId) => {
  const controls = document.getElementById(`layer-controls-${layerId}`);
  if (!controls) return;
  controls.classList.toggle('open');
};

window.toggleLayerVisibility = (layerId) => {
  const entry = window.mapLayers[layerId];
  if (!entry) return;
  setLayerVisibility(layerId, !entry.visible);
  renderLayerList();
};

window.onOpacityChange = async (layerId, value) => {
  const entry = window.mapLayers[layerId];
  if (!entry) return;
  const opacity = parseFloat(value);
  entry.style.opacity = opacity;

  const mapLayerId = `wgis-layer-${layerId}`;
  try {
    if (entry.type === 'raster') {
      map.setPaintProperty(mapLayerId, 'raster-opacity', opacity);
    } else if (entry.geomType === 'Point' || !entry.geomType) {
      map.setPaintProperty(mapLayerId, 'circle-opacity', opacity);
    } else if (entry.geomType === 'LineString') {
      map.setPaintProperty(mapLayerId, 'line-opacity', opacity);
    } else if (entry.geomType === 'Polygon') {
      map.setPaintProperty(`${mapLayerId}-fill`, 'fill-opacity', Math.min(opacity, entry.style.fillOpacity ?? 0.5));
      map.setPaintProperty(mapLayerId, 'line-opacity', opacity);
    }
  } catch (e) {}

  const opacityLabel = document.querySelector(`#layer-controls-${layerId} input[type=range] + span`);
  if (opacityLabel) opacityLabel.textContent = `${Math.round(opacity * 100)}%`;

  clearTimeout(entry._opacityDebounce);
  entry._opacityDebounce = setTimeout(async () => {
    await apiFetch(`/api/layers/${layerId}/style`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: entry.style }),
    });
  }, 800);
};

// ===== Raster Statistics =====
window.loadRasterStats = async (layerId) => {
  const display = document.getElementById('sym-stats-display');
  if (display) display.textContent = 'Loading…';
  try {
    const res = await apiFetch(`/api/layers/${layerId}/stats`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    const band1 = data.bands && data.bands[0];
    if (band1 && window.mapLayers[layerId]) {
      window.mapLayers[layerId]._stats = data.bands;
    }
    if (band1 && display) {
      display.textContent = `min:${band1.min?.toFixed(1)} max:${band1.max?.toFixed(1)} p2:${band1.p2?.toFixed(1)} p98:${band1.p98?.toFixed(1)}`;
    }
    // Auto-fill stretch values
    const stretchEl = document.getElementById('sym-stretch');
    const sminEl = document.getElementById('sym-smin');
    const smaxEl = document.getElementById('sym-smax');
    if (band1 && sminEl && smaxEl) {
      const mode = stretchEl?.value || 'percent';
      if (mode === 'percent' || mode === 'custom') {
        sminEl.value = band1.p2?.toFixed(4) ?? '';
        smaxEl.value = band1.p98?.toFixed(4) ?? '';
      } else if (mode === 'minmax') {
        sminEl.value = band1.min?.toFixed(4) ?? '';
        smaxEl.value = band1.max?.toFixed(4) ?? '';
      } else if (mode === 'stddev1') {
        sminEl.value = ((band1.mean ?? 0) - (band1.std ?? 0)).toFixed(4);
        smaxEl.value = ((band1.mean ?? 0) + (band1.std ?? 0)).toFixed(4);
      } else if (mode === 'stddev2') {
        sminEl.value = ((band1.mean ?? 0) - 2 * (band1.std ?? 0)).toFixed(4);
        smaxEl.value = ((band1.mean ?? 0) + 2 * (band1.std ?? 0)).toFixed(4);
      }
      document.getElementById('sym-custom-range').style.display = '';
    }
  } catch (e) {
    if (display) display.textContent = 'Failed to load stats';
  }
};

// ===== Symbology Modal =====
window.openSymbology = (layerId) => {
  const entry = window.mapLayers[layerId];
  if (!entry) return;
  const modal = document.getElementById('symbologyModal');
  const body = document.getElementById('symbologyBody');

  const style = entry.style || {};
  const isRaster = entry.type === 'raster';
  const isPoint = entry.geomType === 'Point' || entry.type === 'osm';

  body.innerHTML = `
    <div class="form-group">
      <label>Layer Name</label>
      <input type="text" id="sym-name" value="${entry.name}" />
    </div>

    ${isRaster ? `
    <div class="form-group">
      <label>Color Palette</label>
      <select id="sym-colormap">
        <option value="gray"    ${(style.colormap||'gray')==='gray'   ?'selected':''}>Grayscale</option>
        <option value="viridis" ${style.colormap==='viridis'          ?'selected':''}>Viridis</option>
        <option value="plasma"  ${style.colormap==='plasma'           ?'selected':''}>Plasma</option>
        <option value="hot"     ${style.colormap==='hot'              ?'selected':''}>Hot</option>
        <option value="terrain" ${style.colormap==='terrain'          ?'selected':''}>Terrain</option>
        <option value="rdylgn"  ${style.colormap==='rdylgn'           ?'selected':''}>Red→Yellow→Green</option>
      </select>
    </div>
    <div class="form-group">
      <label>Stretch Mode</label>
      <select id="sym-stretch" onchange="document.getElementById('sym-custom-range').style.display=''">
        <option value="percent"  ${(style.stretch||'percent')==='percent' ?'selected':''}>Percentile 2/98 (auto)</option>
        <option value="minmax"   ${style.stretch==='minmax'               ?'selected':''}>Min / Max</option>
        <option value="stddev1"  ${style.stretch==='stddev1'              ?'selected':''}>Std Dev ±1σ</option>
        <option value="stddev2"  ${style.stretch==='stddev2'              ?'selected':''}>Std Dev ±2σ</option>
        <option value="custom"   ${style.stretch==='custom'               ?'selected':''}>Custom Range</option>
      </select>
    </div>
    <div class="form-group" style="display:flex;align-items:center;gap:10px">
      <button type="button" class="btn-secondary btn-sm" onclick="loadRasterStats(${layerId})">
        <i class="fas fa-chart-bar"></i> Load Statistics
      </button>
      <span id="sym-stats-display" style="font-size:10px;color:var(--text-muted);flex:1"></span>
    </div>
    <div id="sym-custom-range" style="${style.smin !== undefined ? '' : 'display:none'}">
      <div class="form-row">
        <div class="form-group">
          <label>Min Value</label>
          <input type="number" id="sym-smin" value="${style.smin ?? ''}" step="any" placeholder="auto" />
        </div>
        <div class="form-group">
          <label>Max Value</label>
          <input type="number" id="sym-smax" value="${style.smax ?? ''}" step="any" placeholder="auto" />
        </div>
      </div>
    </div>
    ` : ''}

    ${!isRaster ? `
    <div class="form-group">
      <label>${isPoint ? 'Point Color' : 'Line/Border Color'}</label>
      <input type="color" id="sym-color" value="${style.color || '#3388ff'}"
        style="width:60px;height:36px;background:none;border:1px solid var(--border);border-radius:6px;cursor:pointer;padding:2px;" />
    </div>

    ${entry.geomType === 'Polygon' ? `
    <div class="form-group">
      <label>Fill Color</label>
      <input type="color" id="sym-fill-color" value="${style.fillColor || '#3388ff'}"
        style="width:60px;height:36px;background:none;border:1px solid var(--border);border-radius:6px;cursor:pointer;padding:2px;" />
    </div>
    <div class="form-group">
      <label>Fill Opacity</label>
      <input type="range" id="sym-fill-opacity" min="0" max="1" step="0.05" value="${style.fillOpacity ?? 0.5}" />
    </div>
    ` : ''}

    ${isPoint ? `
    <div class="form-row">
      <div class="form-group">
        <label>Min Radius (zoom 8)</label>
        <input type="number" id="sym-min-r" value="${style.minZoomRadius ?? 4}" min="1" max="20" />
      </div>
      <div class="form-group">
        <label>Max Radius (zoom 18)</label>
        <input type="number" id="sym-max-r" value="${style.maxZoomRadius ?? 16}" min="2" max="50" />
      </div>
    </div>
    <div class="check-group" style="margin-bottom:12px">
      <input type="checkbox" id="sym-zoom-scale" ${style.zoomScaling !== false ? 'checked' : ''} />
      <label for="sym-zoom-scale">Scale with zoom</label>
    </div>
    <div class="form-group">
      <label>Custom Icon URL (optional)</label>
      <input type="text" id="sym-icon-url" value="${style.iconUrl || ''}" placeholder="https://...icon.svg" />
    </div>
    ` : ''}

    ${!isPoint ? `
    <div class="form-group">
      <label>Line Width</label>
      <input type="number" id="sym-weight" value="${style.weight ?? 2}" min="0.5" max="10" step="0.5" />
    </div>
    ` : ''}
    ` : ''}

    <div class="modal-actions">
      <button class="btn-secondary btn-sm" onclick="document.getElementById('symbologyModal').style.display='none'">Cancel</button>
      <button class="btn-primary btn-sm" onclick="saveSymbology(${layerId})"><i class="fas fa-save"></i> Apply</button>
    </div>
  `;

  modal.style.display = 'flex';
};

document.getElementById('symbologyClose').addEventListener('click', () => {
  document.getElementById('symbologyModal').style.display = 'none';
});

window.saveSymbology = async (layerId) => {
  const entry = window.mapLayers[layerId];
  if (!entry) return;

  const name = document.getElementById('sym-name')?.value.trim();
  const newStyle = { ...entry.style };

  const colormapEl = document.getElementById('sym-colormap');
  if (colormapEl) newStyle.colormap = colormapEl.value;

  const stretchEl = document.getElementById('sym-stretch');
  if (stretchEl) {
    newStyle.stretch = stretchEl.value;
    const sminVal = document.getElementById('sym-smin')?.value;
    const smaxVal = document.getElementById('sym-smax')?.value;
    if (sminVal !== '' && sminVal !== undefined && sminVal !== null) {
      newStyle.smin = parseFloat(sminVal);
    } else {
      delete newStyle.smin;
    }
    if (smaxVal !== '' && smaxVal !== undefined && smaxVal !== null) {
      newStyle.smax = parseFloat(smaxVal);
    } else {
      delete newStyle.smax;
    }
  }

  const colorEl = document.getElementById('sym-color');
  if (colorEl) { newStyle.color = colorEl.value; newStyle.fillColor = colorEl.value; }

  const fillColorEl = document.getElementById('sym-fill-color');
  if (fillColorEl) newStyle.fillColor = fillColorEl.value;

  const fillOpEl = document.getElementById('sym-fill-opacity');
  if (fillOpEl) newStyle.fillOpacity = parseFloat(fillOpEl.value);

  const minREl = document.getElementById('sym-min-r');
  if (minREl) newStyle.minZoomRadius = parseFloat(minREl.value);

  const maxREl = document.getElementById('sym-max-r');
  if (maxREl) newStyle.maxZoomRadius = parseFloat(maxREl.value);

  const zoomScaleEl = document.getElementById('sym-zoom-scale');
  if (zoomScaleEl) newStyle.zoomScaling = zoomScaleEl.checked;

  const iconUrlEl = document.getElementById('sym-icon-url');
  if (iconUrlEl) newStyle.iconUrl = iconUrlEl.value.trim() || null;

  const weightEl = document.getElementById('sym-weight');
  if (weightEl) newStyle.weight = parseFloat(weightEl.value);

  const payload = { style: newStyle };
  if (name) payload.name = name;

  const res = await apiFetch(`/api/layers/${layerId}/style`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    if (name) entry.name = name;
    entry.style = newStyle;
    addLayerToMap(entry);
    renderLayerList();
    document.getElementById('symbologyModal').style.display = 'none';
    showToast('Symbology updated', 'success');
  } else {
    showToast('Failed to save symbology', 'error');
  }
};

document.getElementById('symbologyModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('symbologyModal')) {
    document.getElementById('symbologyModal').style.display = 'none';
  }
});

loadAllLayers();
