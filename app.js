console.log("JS loaded");

var map = L.map('map').setView([45.46, 9.19], 12);

// BASE MAP
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: 'OSM'
}).addTo(map);

// store layers
let layerGroups = {};

// -------------------------
// LOAD LAYERS
// -------------------------

const API = "http://217.160.247.18:8000";

fetch(`${API}/layers`)
  .then(res => res.json())
  .then(layers => {

    console.log("LAYERS:", layers);

    createLayerPanel(layers);

    layers.forEach(layer => {

      fetch("http://217.160.247.18:8000/layers")
        .then(res => res.json())
        .then(res => {

          console.log("DATA:", res);

          let geoLayer = L.geoJSON(res.data, {

            pointToLayer: function (feature, latlng) {

              // PARCO
              if (layer.name === "parks") {
                return L.circleMarker(latlng, {
                  radius: 7,
                  color: "green",
                  fillColor: "green",
                  fillOpacity: 0.7
                });
              }

              // CITTA'
              if (layer.name === "cities") {
                return L.circleMarker(latlng, {
                  radius: 7,
                  color: "red",
                  fillColor: "red",
                  fillOpacity: 0.7
                });
              }

              // default fallback
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

          });

          layerGroups[layer.id] = {
            layer: geoLayer,
            bbox: res.bbox,
            visible: true
          };

          geoLayer.addTo(map);

        });

    });

  });


// -------------------------
// UI PANEL (LEGEND + CONTROLS)
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

    layers.forEach(layer => {

      // SVG ICON
      let icon = "";

      if (layer.name === "cities") {
        icon = `<svg width="12" height="12"><rect width="12" height="12" fill="red"/></svg>`;
      } else {
        icon = `<svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="green"/></svg>`;
      }

      // ROW
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.marginBottom = "6px";

      row.innerHTML = `
        <input type="checkbox" id="chk-${layer.id}" checked style="margin-right:5px;">
        ${icon}
        <span style="margin-left:5px; flex:1;">${layer.name}</span>
        <button id="zoom-${layer.id}" style="margin-left:5px; cursor:pointer">🔍</button>
      `;

      div.appendChild(row);

      // TOGGLE VISIBILITY
      setTimeout(() => {
        const chk = document.getElementById(`chk-${layer.id}`);

        chk.addEventListener("change", () => {

          const g = layerGroups[layer.id];

          if (!g) return;

          if (chk.checked) {
            map.addLayer(g.layer);
          } else {
            map.removeLayer(g.layer);
          }

        });

        // ZOOM BUTTON
        const zoomBtn = document.getElementById(`zoom-${layer.id}`);

        zoomBtn.addEventListener("click", () => {

          const g = layerGroups[layer.id];

          if (g && g.bbox) {
            map.fitBounds(g.bbox);
          }

        });

      }, 0);

    });

    return div;
  };

  panel.addTo(map);
}