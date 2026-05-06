console.log("JS loaded");

var map = L.map('map').setView([45.46, 9.19], 12);

// BASE MAP
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: 'OSM'
}).addTo(map);

// store layers
let layerGroups = {};

// -------------------------
// API BASE
// -------------------------
const API = "http://217.160.247.18:8000";

// -------------------------
// LOAD LAYERS
// -------------------------
fetch(`${API}/layers`)
  .then(res => res.json())
  .then(layers => {

    console.log("LAYERS:", layers);

    createLayerPanel([{ id: "main", name: "GeoJSON Layer" }]);

    // ✅ FIX: use GeoJSON directly
    let geoLayer = L.geoJSON(layers, {

      pointToLayer: function (feature, latlng) {

        // PARCO
        if (feature.properties?.type === "parks") {
          return L.circleMarker(latlng, {
            radius: 7,
            color: "green",
            fillColor: "green",
            fillOpacity: 0.7
          });
        }

        // CITTA'
        if (feature.properties?.type === "cities") {
          return L.circleMarker(latlng, {
            radius: 7,
            color: "red",
            fillColor: "red",
            fillOpacity: 0.7
          });
        }

        // default
        return L.circleMarker(latlng, {
          radius: 6,
          color: "blue"
        });
      },

      onEachFeature: function (feature, layer) {
        if (feature.properties?.name) {
          layer.bindPopup(feature.properties.name);
        }
      }

    }).addTo(map);

    // store layer
    layerGroups["main"] = {
      layer: geoLayer,
      visible: true
    };

  });


// -------------------------
// UI PANEL (SIMPLIFIED)
// -------------------------
function createLayerPanel(layers) {

  const panel = L.control({ position: "topright" });

  panel.onAdd = function () {

    const div = L.DomUtil.create("div", "layer-panel");

    div.style.background = "white";
    div.style.padding = "10px";
    div.style.borderRadius = "8px";
    div.style.boxShadow = "0 0 5px rgba(0,0,0,0.3)";

    div.innerHTML = "<b>Layers</b><br><br>";

    const row = document.createElement("div");

    row.innerHTML = `
      <input type="checkbox" id="chk-main" checked>
      <span>GeoJSON Layer</span>
      <button id="zoom-main">🔍</button>
    `;

    div.appendChild(row);

    setTimeout(() => {

      const chk = document.getElementById("chk-main");
      const zoomBtn = document.getElementById("zoom-main");

      chk.addEventListener("change", () => {
        const g = layerGroups["main"];
        if (!g) return;

        if (chk.checked) {
          map.addLayer(g.layer);
        } else {
          map.removeLayer(g.layer);
        }
      });

      zoomBtn.addEventListener("click", () => {
        map.fitBounds(g.layer.getBounds());
      });

    }, 0);

    return div;
  };

  panel.addTo(map);
}