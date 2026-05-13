// ===== Map Initialization =====
let map;
let currentBasemapId = 'osm';
let measureMode = false;
let measurePoints = [];
let measureSource = null;
let geocodeMarker = null;

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAPS[0].style,
    center: [12.5, 41.9],
    zoom: 5,
    attributionControl: true,
  });

  map.on('load', () => {
    // Load all pending layers
    if (window.pendingLayers) {
      window.pendingLayers.forEach(l => addLayerToMap(l));
      window.pendingLayers = [];
    }
  });

  // Update coordinates display
  map.on('mousemove', (e) => {
    const { lng, lat } = e.lngLat;
    document.getElementById('coordsDisplay').textContent =
      `${lng.toFixed(5)}, ${lat.toFixed(5)}`;
  });

  // Measure tool click handler
  map.on('click', (e) => {
    if (!measureMode) return;
    measurePoints.push([e.lngLat.lng, e.lngLat.lat]);
    updateMeasureLine();
  });

  // Feature popup on layer click
  map.on('click', async (e) => {
    if (measureMode) return;

    // Check rendered vector features first
    const features = map.queryRenderedFeatures(e.point);
    const layerFeature = features.find(f => f.source && f.source.startsWith('wgis-'));
    if (layerFeature) {
      showFeaturePopup(e, layerFeature);
      return;
    }

    // Check raster layers by bbox – query pixel value
    const { lng, lat } = e.lngLat;
    const rasterLayers = (window.layerOrder || [])
      .slice().reverse()
      .map(id => window.mapLayers[id])
      .filter(l => l && l.type === 'raster' && l.visible && l.bbox);

    for (const rLayer of rasterLayers) {
      const [minX, minY, maxX, maxY] = rLayer.bbox;
      if (lng >= minX && lng <= maxX && lat >= minY && lat <= maxY) {
        try {
          const res = await apiFetch(`/api/layers/${rLayer.id}/value?lat=${lat}&lon=${lng}`);
          if (res.ok) showRasterValuePopup(e, rLayer, await res.json());
        } catch (_) {}
        break;
      }
    }
  });

  map.on('mouseenter', (e) => {
    const features = map.queryRenderedFeatures(e.point);
    if (features.some(f => f.source && f.source.startsWith('wgis-'))) {
      map.getCanvas().style.cursor = 'pointer';
    }
  });
  map.on('mouseleave', () => {
    if (!measureMode) map.getCanvas().style.cursor = '';
  });
}

// ===== Basemap Selector =====
function initBasemapPanel() {
  const grid = document.getElementById('basemapGrid');
  grid.innerHTML = BASEMAPS.map(b => `
    <div class="basemap-card ${b.id === currentBasemapId ? 'active' : ''}" data-id="${b.id}" onclick="switchBasemap('${b.id}')">
      <div class="basemap-preview" style="background-image:url('${b.preview}');background-color:#334;"></div>
      <div class="basemap-label">${b.name}</div>
    </div>
  `).join('');
}

window.switchBasemap = (id) => {
  const bm = BASEMAPS.find(b => b.id === id);
  if (!bm || id === currentBasemapId) {
    document.getElementById('basemapPanel').style.display = 'none';
    return;
  }

  const center = map.getCenter();
  const zoom = map.getZoom();
  const bearing = map.getBearing();
  const pitch = map.getPitch();

  // Remember current layer sources
  const layerSources = Object.values(window.mapLayers || {}).map(l => ({
    layer: l,
    visible: l.visible,
  }));

  map.setStyle(bm.style);
  currentBasemapId = id;

  map.once('styledata', () => {
    map.setCenter(center);
    map.setZoom(zoom);
    map.setBearing(bearing);
    map.setPitch(pitch);

    // Re-add all layers
    layerSources.forEach(({ layer, visible }) => {
      addLayerToMap(layer);
      if (!visible) setLayerVisibility(layer.id, false);
    });
  });

  document.getElementById('currentBasemapName').textContent = bm.name;
  document.getElementById('basemapPanel').style.display = 'none';

  // Update grid active state
  document.querySelectorAll('.basemap-card').forEach(c => {
    c.classList.toggle('active', c.dataset.id === id);
  });
};

document.getElementById('basemapBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  initBasemapPanel();
  const panel = document.getElementById('basemapPanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});

document.getElementById('basemapPanel').addEventListener('click', (e) => {
  if (e.target === document.getElementById('basemapPanel')) {
    document.getElementById('basemapPanel').style.display = 'none';
  }
});

// ===== Map Controls =====
document.getElementById('zoomInBtn').addEventListener('click', () => map.zoomIn());
document.getElementById('zoomOutBtn').addEventListener('click', () => map.zoomOut());
document.getElementById('zoomExtentBtn').addEventListener('click', () => {
  map.flyTo({ center: [0, 20], zoom: 2, duration: 1000 });
});

document.getElementById('locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return showToast('Geolocation not supported', 'error');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 14 });
      showToast('Zoomed to your location', 'success');
    },
    () => showToast('Could not get location', 'error')
  );
});

document.getElementById('fullscreenBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
    document.getElementById('fullscreenBtn').innerHTML = '<i class="fas fa-compress"></i>';
  } else {
    document.exitFullscreen();
    document.getElementById('fullscreenBtn').innerHTML = '<i class="fas fa-expand"></i>';
  }
});

// Sidebar toggle
document.getElementById('sidebarToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
  setTimeout(() => map.resize(), 300);
});

// Coordinates copy
document.getElementById('coordsToggle').addEventListener('click', () => {
  const coords = document.getElementById('coordsDisplay').textContent;
  navigator.clipboard?.writeText(coords).then(() => showToast('Coordinates copied', 'success'));
});

// ===== Measure Tool =====
document.getElementById('measureBtn').addEventListener('click', () => {
  measureMode = !measureMode;
  document.getElementById('measureBtn').classList.toggle('active', measureMode);
  map.getCanvas().style.cursor = measureMode ? 'crosshair' : '';

  if (!measureMode) {
    clearMeasure();
  } else {
    measurePoints = [];
    showToast('Click on map to measure distance. Click button again to stop.', 'info', 5000);
  }
});

function updateMeasureLine() {
  if (measurePoints.length < 1) return;

  const sourceId = 'measure-line';
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: measurePoints },
        properties: {},
      },
      ...measurePoints.map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: p },
        properties: {},
      })),
    ],
  };

  if (map.getSource(sourceId)) {
    map.getSource(sourceId).setData(geojson);
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'measure-line-layer',
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': '#f1c40f',
        'line-width': 2,
        'line-dasharray': [2, 1],
      },
    });
    map.addLayer({
      id: 'measure-points-layer',
      type: 'circle',
      source: sourceId,
      filter: ['==', '$type', 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#f1c40f',
        'circle-stroke-color': 'white',
        'circle-stroke-width': 2,
      },
    });
  }

  if (measurePoints.length >= 2) {
    const dist = calculateDistance(measurePoints);
    showToast(`Distance: ${formatDistance(dist)}`, 'info', 3000);
  }
}

function clearMeasure() {
  measurePoints = [];
  if (map.getLayer('measure-line-layer')) map.removeLayer('measure-line-layer');
  if (map.getLayer('measure-points-layer')) map.removeLayer('measure-points-layer');
  if (map.getSource('measure-line')) map.removeSource('measure-line');
}

function calculateDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [lon1, lat1] = points[i - 1];
    const [lon2, lat2] = points[i];
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

// ===== Feature Popups =====
function showFeaturePopup(e, feature) {
  const props = feature.properties || {};
  const priority = ['name', 'amenity', 'feature_type', 'highway', 'shop', 'tourism', 'railway'];
  const skip = ['osm_type'];
  let rows = '';

  priority.forEach(k => {
    if (props[k] != null && props[k] !== '') {
      rows += `<div class="popup-row"><span class="popup-key">${k}</span><span class="popup-val">${props[k]}</span></div>`;
    }
  });

  Object.entries(props).forEach(([k, v]) => {
    if (!priority.includes(k) && !skip.includes(k) && v != null && v !== '' && String(v).length < 200) {
      rows += `<div class="popup-row"><span class="popup-key">${k}</span><span class="popup-val">${v}</span></div>`;
    }
  });

  if (!rows) rows = '<div style="color:var(--text-muted);font-size:11px;padding:4px 0">No attributes</div>';

  const title = props.name || props.feature_type || 'Feature';
  new maplibregl.Popup({ maxWidth: '320px', closeButton: true, offset: 10 })
    .setLngLat(e.lngLat)
    .setHTML(`<div class="popup-title">${title}</div><div class="popup-scroll">${rows}</div>`)
    .addTo(map);
}

function showRasterValuePopup(e, rLayer, data) {
  const values = data.values || {};
  const keys = Object.keys(values);
  let rows = '';

  keys.forEach(k => {
    const val = values[k];
    const display = val !== null ? Number(val).toFixed(4) : '<em style="color:var(--text-muted)">NoData</em>';
    const label = keys.length === 1 ? 'Value' : k.replace('_', ' ');
    rows += `<div class="popup-row"><span class="popup-key">${label}</span><span class="popup-val">${display}</span></div>`;
  });

  if (!rows) return;

  new maplibregl.Popup({ maxWidth: '280px', closeButton: true, offset: 10 })
    .setLngLat(e.lngLat)
    .setHTML(`
      <div class="popup-title"><i class="fas fa-map" style="font-size:11px;margin-right:4px"></i>${rLayer.name}</div>
      ${rows}
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);font-size:10px;color:var(--text-muted)">
        ${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}
      </div>
    `)
    .addTo(map);
}

// Start map
initMap();
