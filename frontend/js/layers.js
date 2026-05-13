// ===== Layer Management =====
window.mapLayers = {};  // { layerId: { id, name, type, geomType, style, visible, bbox } }
window.pendingLayers = [];

// Load all layers from API on startup
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

  if (map.loaded()) {
    addLayerToMap(entry);
  } else {
    (window.pendingLayers = window.pendingLayers || []).push(entry);
    map.once('load', () => addLayerToMap(entry));
  }

  renderLayerList();
}

function addLayerToMap(entry) {
  const sourceId = `wgis-${entry.id}`;
  const layerId = `wgis-layer-${entry.id}`;

  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  if (entry.type === 'raster') {
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [`${API}/api/layers/${entry.id}/tiles/{z}/{x}/{y}.png`],
      tileSize: 256,
    });
    map.addLayer({
      id: layerId,
      type: 'raster',
      source: sourceId,
      paint: {
        'raster-opacity': entry.style.opacity ?? 0.8,
      },
    });
  } else {
    // Vector / OSM: load GeoJSON
    map.addSource(sourceId, {
      type: 'geojson',
      data: `${API}/api/layers/${entry.id}/geojson`,
      generateId: true,
    });
    addVectorLayer(sourceId, layerId, entry);
  }

  if (!entry.visible) map.setLayoutProperty(layerId, 'visibility', 'none');
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
      // Custom icon with zoom scaling
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
    // Fill layer
    map.addLayer({
      id: `${layerId}-fill`,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': fillColor,
        'fill-opacity': fillOpacity,
      },
    });
    // Outline
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
  const fillLayerId = `${mapLayerId}-fill`;
  const vis = visible ? 'visible' : 'none';

  if (map.getLayer(mapLayerId)) map.setLayoutProperty(mapLayerId, 'visibility', vis);
  if (map.getLayer(fillLayerId)) map.setLayoutProperty(fillLayerId, 'visibility', vis);
}

function updateLayerStyle(layerId, newStyle) {
  const entry = window.mapLayers[layerId];
  if (!entry) return;
  entry.style = { ...entry.style, ...newStyle };

  const mapLayerId = `wgis-layer-${layerId}`;
  const fillLayerId = `${mapLayerId}-fill`;
  const sourceId = `wgis-${layerId}`;
  const color = entry.style.color || '#3388ff';
  const opacity = entry.style.opacity ?? 0.8;

  try {
    if (entry.type === 'raster') {
      if (map.getLayer(mapLayerId)) {
        map.setPaintProperty(mapLayerId, 'raster-opacity', opacity);
      }
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
      if (map.getLayer(fillLayerId)) {
        map.setPaintProperty(fillLayerId, 'fill-color', entry.style.fillColor || color);
        map.setPaintProperty(fillLayerId, 'fill-opacity', entry.style.fillOpacity ?? 0.5);
      }
      if (map.getLayer(mapLayerId)) {
        map.setPaintProperty(mapLayerId, 'line-color', color);
        map.setPaintProperty(mapLayerId, 'line-opacity', opacity);
      }
    }
  } catch (e) {
    console.warn('Style update error:', e);
    // Rebuild layer if paint property fails
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
  const fillLayerId = `${mapLayerId}-fill`;
  const sourceId = `wgis-${layerId}`;

  if (map.getLayer(mapLayerId)) map.removeLayer(mapLayerId);
  if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  delete window.mapLayers[layerId];
  renderLayerList();
  showToast('Layer deleted', 'success');
}

// ===== Layer List Rendering =====
function renderLayerList() {
  const list = document.getElementById('layerList');
  const layers = Object.values(window.mapLayers).reverse();

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
    const typeClass = { vector: 'badge-vector', raster: 'badge-raster', osm: 'badge-osm' }[l.type] || 'badge-vector';
    const dotColor = l.style.color || '#3388ff';
    return `
      <div class="layer-item" id="layer-item-${l.id}">
        <div class="layer-header" onclick="toggleLayerExpand(${l.id})">
          <button class="layer-visibility ${l.visible ? '' : 'hidden'}" onclick="event.stopPropagation();toggleLayerVisibility(${l.id})" title="${l.visible ? 'Hide' : 'Show'}">
            <i class="fas fa-${l.visible ? 'eye' : 'eye-slash'}"></i>
          </button>
          <div class="layer-color-dot" style="background:${dotColor}"></div>
          <span class="layer-name" title="${l.name}">${l.name}</span>
          <span class="layer-type-badge ${typeClass}">${l.type}</span>
          <button class="layer-expand-btn" id="expand-btn-${l.id}"><i class="fas fa-chevron-down"></i></button>
        </div>
        <div class="layer-controls" id="layer-controls-${l.id}">
          <div class="ctrl-row">
            <span class="ctrl-label">Opacity</span>
            <input type="range" min="0" max="1" step="0.05" value="${l.style.opacity ?? 0.8}"
              oninput="onOpacityChange(${l.id}, this.value)" />
            <span style="font-size:10px;color:var(--text-muted);width:30px">${Math.round((l.style.opacity ?? 0.8) * 100)}%</span>
          </div>
          <div class="ctrl-row" style="gap:6px">
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
          ${l.featureCount > 0 ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px"><i class="fas fa-info-circle"></i> ${l.featureCount} features</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

window.toggleLayerExpand = (layerId) => {
  const controls = document.getElementById(`layer-controls-${layerId}`);
  const btn = document.getElementById(`expand-btn-${layerId}`);
  if (!controls) return;
  controls.classList.toggle('open');
  btn.innerHTML = controls.classList.contains('open')
    ? '<i class="fas fa-chevron-up"></i>'
    : '<i class="fas fa-chevron-down"></i>';
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

  // Update visual immediately
  const mapLayerId = `wgis-layer-${layerId}`;
  try {
    if (entry.type === 'raster') {
      map.setPaintProperty(mapLayerId, 'raster-opacity', opacity);
    } else if (entry.geomType === 'Point' || !entry.geomType) {
      map.setPaintProperty(mapLayerId, 'circle-opacity', opacity);
    } else if (entry.geomType === 'LineString') {
      map.setPaintProperty(mapLayerId, 'line-opacity', opacity);
    } else if (entry.geomType === 'Polygon') {
      const fillOpacity = Math.min(opacity, entry.style.fillOpacity ?? 0.5);
      map.setPaintProperty(`${mapLayerId}-fill`, 'fill-opacity', fillOpacity);
      map.setPaintProperty(mapLayerId, 'line-opacity', opacity);
    }
  } catch (e) { }

  // Update opacity display
  const opacityLabel = document.querySelector(`#layer-controls-${layerId} input[type=range] + span`);
  if (opacityLabel) opacityLabel.textContent = `${Math.round(opacity * 100)}%`;

  // Save to API (debounced)
  clearTimeout(entry._opacityDebounce);
  entry._opacityDebounce = setTimeout(async () => {
    await apiFetch(`/api/layers/${layerId}/style`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: entry.style }),
    });
  }, 800);
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

    ${!isRaster ? `
    <div class="form-group">
      <label>${isPoint ? 'Point Color' : 'Line/Border Color'}</label>
      <input type="color" id="sym-color" value="${style.color || '#3388ff'}" style="width:60px;height:36px;background:none;border:1px solid var(--border);border-radius:6px;cursor:pointer;padding:2px;" />
    </div>

    ${entry.geomType === 'Polygon' ? `
    <div class="form-group">
      <label>Fill Color</label>
      <input type="color" id="sym-fill-color" value="${style.fillColor || '#3388ff'}" style="width:60px;height:36px;background:none;border:1px solid var(--border);border-radius:6px;cursor:pointer;padding:2px;" />
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

    ${!isPoint && !isRaster ? `
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

  const colorEl = document.getElementById('sym-color');
  if (colorEl) newStyle.color = colorEl.value;

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
    // Rebuild map layer to apply icon/style changes
    addLayerToMap(entry);
    renderLayerList();
    document.getElementById('symbologyModal').style.display = 'none';
    showToast('Symbology updated', 'success');
  } else {
    showToast('Failed to save symbology', 'error');
  }
};

// Close modals on overlay click
document.getElementById('symbologyModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('symbologyModal')) {
    document.getElementById('symbologyModal').style.display = 'none';
  }
});

// Initialize
loadAllLayers();
