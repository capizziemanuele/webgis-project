// ===== Nominatim Geocoding =====
let geocodeDebounce;
let currentGeocodeMarker = null;

const geocodeInput = document.getElementById('geocodeInput');
const suggestions = document.getElementById('geocodeSuggestions');

geocodeInput.addEventListener('input', () => {
  clearTimeout(geocodeDebounce);
  const q = geocodeInput.value.trim();
  if (q.length < 3) { suggestions.innerHTML = ''; return; }
  geocodeDebounce = setTimeout(() => fetchSuggestions(q), 350);
});

document.getElementById('geocodeBtn').addEventListener('click', () => {
  const q = geocodeInput.value.trim();
  if (q) geocodeSearch(q);
});

geocodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = geocodeInput.value.trim();
    if (q) geocodeSearch(q);
    suggestions.innerHTML = '';
  }
  if (e.key === 'Escape') suggestions.innerHTML = '';
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) suggestions.innerHTML = '';
});

async function fetchSuggestions(query) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    renderSuggestions(data);
  } catch {
    suggestions.innerHTML = '';
  }
}

function renderSuggestions(results) {
  if (!results.length) { suggestions.innerHTML = ''; return; }
  suggestions.innerHTML = results.map(r => {
    const addr = r.address || {};
    const main = r.display_name.split(',')[0];
    const sub = [addr.city || addr.town || addr.village, addr.country].filter(Boolean).join(', ');
    const icon = getTypeIcon(r.type, r.class);
    return `
      <div class="suggestion-item" onclick="zoomToResult(${r.lat}, ${r.lon}, '${escapeHtml(r.display_name)}')">
        <i class="fas ${icon}"></i>
        <div>
          <div class="suggestion-main">${escapeHtml(main)}</div>
          <div class="suggestion-sub">${escapeHtml(sub)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function getTypeIcon(type, cls) {
  if (cls === 'place') return 'fa-map-marker-alt';
  if (cls === 'amenity') return 'fa-map-pin';
  if (cls === 'highway') return 'fa-road';
  if (cls === 'boundary') return 'fa-globe';
  if (cls === 'natural') return 'fa-tree';
  return 'fa-search-location';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function geocodeSearch(query) {
  suggestions.innerHTML = '';
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    if (data.length > 0) {
      zoomToResult(data[0].lat, data[0].lon, data[0].display_name, data[0].boundingbox);
    } else {
      showToast(`No results found for "${query}"`, 'error');
    }
  } catch {
    showToast('Geocoding service unavailable', 'error');
  }
}

window.zoomToResult = (lat, lon, name, bbox) => {
  suggestions.innerHTML = '';
  geocodeInput.value = name.split(',')[0];

  if (currentGeocodeMarker) currentGeocodeMarker.remove();

  const el = document.createElement('div');
  el.className = 'geocode-marker';
  currentGeocodeMarker = new maplibregl.Marker({ element: el })
    .setLngLat([parseFloat(lon), parseFloat(lat)])
    .setPopup(new maplibregl.Popup({ offset: 15 }).setHTML(`<strong>${name.split(',')[0]}</strong>`))
    .addTo(map);

  if (bbox && bbox.length === 4) {
    map.fitBounds(
      [[parseFloat(bbox[2]), parseFloat(bbox[0])], [parseFloat(bbox[3]), parseFloat(bbox[1])]],
      { padding: 60, maxZoom: 14, duration: 1000 }
    );
  } else {
    map.flyTo({ center: [parseFloat(lon), parseFloat(lat)], zoom: 13, duration: 1000 });
  }
};
