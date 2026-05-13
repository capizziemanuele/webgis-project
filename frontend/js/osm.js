// ===== OSM Feature Fetcher =====
let osmColorValue = '#e74c3c';

document.getElementById('osmQueryBtn').addEventListener('click', openOsmModal);

async function openOsmModal() {
  document.getElementById('osmModal').style.display = 'flex';
  setStatus('osmStatus', '', '');

  // Populate feature types
  const select = document.getElementById('osmFeatureType');
  if (select.options.length === 0) {
    try {
      const res = await apiFetch('/api/osm/types');
      const types = await res.json();
      select.innerHTML = types.map(t => `<option value="${t.key}">${t.label}</option>`).join('');
    } catch {
      select.innerHTML = '<option value="hospital">Hospitals</option>';
    }
  }
}

document.getElementById('osmModalClose').addEventListener('click', closeOsmModal);
document.getElementById('osmModalCancel').addEventListener('click', closeOsmModal);
document.getElementById('osmModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('osmModal')) closeOsmModal();
});

function closeOsmModal() {
  document.getElementById('osmModal').style.display = 'none';
}

document.getElementById('osmFetchBtn').addEventListener('click', async () => {
  const city = document.getElementById('osmCity').value.trim();
  const featureType = document.getElementById('osmFeatureType').value;
  const layerName = document.getElementById('osmLayerName').value.trim() || null;
  const minRadius = parseFloat(document.getElementById('osmMinRadius').value) || 4;
  const maxRadius = parseFloat(document.getElementById('osmMaxRadius').value) || 16;
  const zoomScaling = document.getElementById('osmZoomScaling').checked;
  const iconUrl = document.getElementById('osmIconUrl').value.trim() || null;

  if (!city) {
    setStatus('osmStatus', 'Please enter a city name', 'error');
    return;
  }

  const btn = document.getElementById('osmFetchBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Fetching...';
  setStatus('osmStatus', `Querying Overpass API for ${featureType} in ${city}...`, 'loading');

  try {
    const style = {
      color: osmColorValue,
      fillColor: osmColorValue,
      opacity: 1.0,
      fillOpacity: 0.85,
      minZoomRadius: minRadius,
      maxZoomRadius: maxRadius,
      zoomScaling,
    };
    if (iconUrl) style.iconUrl = iconUrl;

    const res = await apiFetch('/api/osm/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        city,
        feature_type: featureType,
        layer_name: layerName,
        style,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      setStatus('osmStatus', err.detail || 'Query failed', 'error');
      return;
    }

    const result = await res.json();
    setStatus('osmStatus', result.message, 'success');

    // Add layer to map
    const layer = result.layer;
    await loadLayer({
      ...layer,
      style: layer.style || style,
    });

    // Zoom to results
    setTimeout(() => {
      zoomToLayer(layer.id);
      closeOsmModal();
      showToast(`${result.message}`, 'success');
    }, 500);

  } catch (err) {
    setStatus('osmStatus', 'Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-download"></i> Fetch Features';
  }
});

// Initialize Pickr color picker for OSM
window.addEventListener('load', () => {
  try {
    const pickr = Pickr.create({
      el: '#osmColorPicker',
      theme: 'nano',
      default: osmColorValue,
      components: {
        preview: true,
        opacity: true,
        hue: true,
        interaction: { hex: true, input: true, save: true },
      },
    });
    pickr.on('save', (color) => {
      if (color) osmColorValue = color.toHEXA().toString();
      pickr.hide();
    });
  } catch (e) {
    // Pickr unavailable — fallback handled
    const el = document.getElementById('osmColorPicker');
    if (el) el.innerHTML = '<input type="color" value="#e74c3c" onchange="osmColorValue=this.value" style="width:40px;height:36px;border:none;background:none;cursor:pointer;" />';
  }
});
