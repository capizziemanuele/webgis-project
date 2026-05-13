const API = window.location.origin;

const BASEMAPS = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm-tiles', type: 'raster', source: 'osm' }],
    },
    preview: 'https://tile.openstreetmap.org/5/15/12.png',
  },
  {
    id: 'satellite',
    name: 'Satellite',
    style: {
      version: 8,
      sources: {
        satellite: {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          attribution: 'Esri, Maxar, Earthstar Geographics',
        },
      },
      layers: [{ id: 'satellite-tiles', type: 'raster', source: 'satellite' }],
    },
    preview: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/3/4',
  },
  {
    id: 'dark',
    name: 'Dark Matter',
    style: {
      version: 8,
      sources: {
        dark: {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
            'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
          ],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors, © CARTO',
        },
      },
      layers: [{ id: 'dark-tiles', type: 'raster', source: 'dark' }],
    },
    preview: 'https://a.basemaps.cartocdn.com/dark_all/5/15/12@2x.png',
  },
  {
    id: 'light',
    name: 'Positron',
    style: {
      version: 8,
      sources: {
        light: {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
            'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
          ],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors, © CARTO',
        },
      },
      layers: [{ id: 'light-tiles', type: 'raster', source: 'light' }],
    },
    preview: 'https://a.basemaps.cartocdn.com/light_all/5/15/12@2x.png',
  },
  {
    id: 'topo',
    name: 'Topo',
    style: {
      version: 8,
      sources: {
        topo: {
          type: 'raster',
          tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenTopoMap contributors',
        },
      },
      layers: [{ id: 'topo-tiles', type: 'raster', source: 'topo' }],
    },
    preview: 'https://tile.opentopomap.org/5/15/12.png',
  },
  {
    id: 'esri-street',
    name: 'Streets',
    style: {
      version: 8,
      sources: {
        streets: {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          attribution: 'Esri',
        },
      },
      layers: [{ id: 'streets-tiles', type: 'raster', source: 'streets' }],
    },
    preview: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/3/3/4',
  },
];

// Utility: show toast
function showToast(message, type = 'info', duration = 4000) {
  const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle', warning: 'fa-exclamation-triangle' };
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i class="fas ${icons[type] || icons.info}"></i>
    <span>${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
  `;
  container.appendChild(toast);
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, duration);
}

// Utility: show/hide status message
function setStatus(elId, message, type) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!message) { el.style.display = 'none'; return; }
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', loading: 'fa-spinner fa-spin' };
  el.innerHTML = `<i class="fas ${icons[type] || 'fa-info-circle'}"></i> ${message}`;
  el.className = `status-msg ${type}`;
  el.style.display = 'flex';
}

// Auth headers
function authHeaders() {
  const token = localStorage.getItem('webgis_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    credentials: 'include',
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem('webgis_token');
    localStorage.removeItem('webgis_user');
    window.location.href = '/login.html';
    throw new Error('Unauthorized');
  }
  return res;
}
