console.log("JS loaded");

const map = L.map('map').setView([45.46, 9.19], 12);

// BASE MAP
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: 'OSM'
}).addTo(map);

// store layers
let layerGroups = {};

// API
const API = "http://217.160.247.18:8000";

// -------------------------
// LOAD GEOJSON
// -------------------------
fetch(`${API}/layers`)
  .then(res => res.json())
  .then(data => {

    console.log("GEOJSON:", data);

    const geoLayer = L.geoJSON(data, {

      pointToLayer: (feature, latlng) => {

        const type = feature.properties?.type;

        if (type === "parks") {
          return L.circleMarker(latlng, {
            radius: 7,
            color: "green",
            fillColor: "green",
            fillOpacity: 0.7
          });
        }

        if (type === "cities") {
          return L.circleMarker(latlng, {
            radius: 7,
            color: "red",
            fillColor: "red",
            fillOpacity: 0.7
          });
        }

        return L.circleMarker(latlng, {
          radius: 6,
          color: "blue",
          fillOpacity: 0.6
        });
      },

      onEachFeature: (feature, layer) => {
        const name = feature.properties?.name;
        if (name) layer.bindPopup(name);
      }

    });

    geoLayer.addTo(map);

    layerGroups["main"] = geoLayer;

    createLayerPanel();

  });


// -------------------------
// UI PANEL (CLEAN)
// -------------------------
function createLayerPanel() {

  const panel = L.control({ position: "topright" });

  panel.onAdd = function () {

    const div = L.DomUtil.create("div", "layer-panel");

    div.style.background = "white";
    div.style.padding = "10px";
    div.style.borderRadius = "8px";
    div.style.boxShadow = "0 0 5px rgba(0,0,0,0.3)";

    div.innerHTML = "<b>Layers</b><br><br>";

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "6px";

    row.innerHTML = `
      <input type="checkbox" id="chk-main" checked>
      <span>GeoJSON Layer</span>
      <button id="zoom-main">🔍</button>
    `;

    div.appendChild(row);

    setTimeout(() => {

      const chk = document.getElementById("chk-main");
      const zoomBtn = document.getElementById("zoom-main");

      // toggle layer
      chk.addEventListener("change", () => {

        const layer = layerGroups["main"];

        if (!layer) return;

        if (chk.checked) {
          map.addLayer(layer);
        } else {
          map.removeLayer(layer);
        }
      });

      // zoom
      zoomBtn.addEventListener("click", () => {

        const layer = layerGroups["main"];

        if (!layer) return;

        map.fitBounds(layer.getBounds());

      });

    }, 0);

    return div;
  };

  panel.addTo(map);
}