import json
import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.database import get_db
from app.deps import get_current_user
from app import models, schemas
from app.routers.layers import sanitize_table_name, store_geojson_in_postgis, get_geojson_bbox

router = APIRouter(prefix="/api/osm", tags=["osm"])

OSM_FEATURE_TYPES = {
    "hospital": {"key": "amenity", "value": "hospital", "label": "Hospitals"},
    "school": {"key": "amenity", "value": "school", "label": "Schools"},
    "university": {"key": "amenity", "value": "university", "label": "Universities"},
    "pharmacy": {"key": "amenity", "value": "pharmacy", "label": "Pharmacies"},
    "restaurant": {"key": "amenity", "value": "restaurant", "label": "Restaurants"},
    "cafe": {"key": "amenity", "value": "cafe", "label": "Cafes"},
    "bar": {"key": "amenity", "value": "bar", "label": "Bars"},
    "hotel": {"key": "tourism", "value": "hotel", "label": "Hotels"},
    "bank": {"key": "amenity", "value": "bank", "label": "Banks"},
    "museum": {"key": "tourism", "value": "museum", "label": "Museums"},
    "library": {"key": "amenity", "value": "library", "label": "Libraries"},
    "supermarket": {"key": "shop", "value": "supermarket", "label": "Supermarkets"},
    "park": {"key": "leisure", "value": "park", "label": "Parks"},
    "parking": {"key": "amenity", "value": "parking", "label": "Parking"},
    "bus_stop": {"key": "highway", "value": "bus_stop", "label": "Bus Stops"},
    "train_station": {"key": "railway", "value": "station", "label": "Train Stations"},
    "airport": {"key": "aeroway", "value": "aerodrome", "label": "Airports"},
    "police": {"key": "amenity", "value": "police", "label": "Police Stations"},
    "fire_station": {"key": "amenity", "value": "fire_station", "label": "Fire Stations"},
    "atm": {"key": "amenity", "value": "atm", "label": "ATMs"},
    "fuel": {"key": "amenity", "value": "fuel", "label": "Gas Stations"},
    "cinema": {"key": "amenity", "value": "cinema", "label": "Cinemas"},
    "theatre": {"key": "amenity", "value": "theatre", "label": "Theatres"},
    "place_of_worship": {"key": "amenity", "value": "place_of_worship", "label": "Places of Worship"},
    "post_office": {"key": "amenity", "value": "post_office", "label": "Post Offices"},
    "bicycle_rental": {"key": "amenity", "value": "bicycle_rental", "label": "Bike Rentals"},
    "car_rental": {"key": "amenity", "value": "car_rental", "label": "Car Rentals"},
    "marketplace": {"key": "amenity", "value": "marketplace", "label": "Marketplaces"},
    "swimming_pool": {"key": "leisure", "value": "swimming_pool", "label": "Swimming Pools"},
    "stadium": {"key": "leisure", "value": "stadium", "label": "Stadiums"},
}


@router.get("/types")
def get_osm_types():
    return [{"id": k, "osm_key": v["key"], "value": v["value"], "label": v["label"]} for k, v in OSM_FEATURE_TYPES.items()]


@router.post("/query")
def query_osm(
    request: schemas.OSMQueryRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if request.feature_type not in OSM_FEATURE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown feature type: {request.feature_type}")

    feat = OSM_FEATURE_TYPES[request.feature_type]
    key = feat["key"]
    value = feat["value"]
    label = feat["label"]

    city_query = f"{request.city}, {request.country}" if request.country else request.city

    NOMINATIM_UA = "WebGIS/1.0 (educational project; contact@webgis.local)"

    # Step 1: geocode city with Nominatim to get a precise area/bbox
    overpass_query = None
    try:
        with httpx.Client(timeout=15, headers={"User-Agent": NOMINATIM_UA}, follow_redirects=True) as nclient:
            resp = nclient.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": city_query, "format": "json", "limit": 1, "featuretype": "city,settlement,municipality"},
            )
            if resp.status_code == 200:
                places = resp.json()
                if places:
                    place = places[0]
                    osm_type = place.get("osm_type")
                    osm_id = place.get("osm_id")
                    bb = place.get("boundingbox")  # [south, north, west, east]

                    if osm_type == "relation" and osm_id:
                        area_id = int(osm_id) + 3600000000
                        overpass_query = f"""
[out:json][timeout:60];
area({area_id})->.searchArea;
(
  node["{key}"="{value}"](area.searchArea);
  way["{key}"="{value}"](area.searchArea);
  relation["{key}"="{value}"](area.searchArea);
);
out center tags;
"""
                    elif bb:
                        s, n, w, e = bb[0], bb[1], bb[2], bb[3]
                        overpass_query = f"""
[out:json][timeout:60];
(
  node["{key}"="{value}"]({s},{w},{n},{e});
  way["{key}"="{value}"]({s},{w},{n},{e});
  relation["{key}"="{value}"]({s},{w},{n},{e});
);
out center tags;
"""
    except Exception:
        pass

    # Fallback: area by name
    if not overpass_query:
        overpass_query = f"""
[out:json][timeout:60];
area["name"="{request.city}"]->.searchArea;
(
  node["{key}"="{value}"](area.searchArea);
  way["{key}"="{value}"](area.searchArea);
  relation["{key}"="{value}"](area.searchArea);
);
out center tags;
"""

    OVERPASS_ENDPOINTS = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ]

    HEADERS = {
        "User-Agent": "WebGIS/1.0 (educational project; contact@webgis.local)",
        "Accept": "application/json, text/json, */*",
        "Content-Type": "application/x-www-form-urlencoded",
    }

    data = None
    last_error = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            with httpx.Client(timeout=90, headers=HEADERS, follow_redirects=True) as client:
                response = client.post(endpoint, data={"data": overpass_query})
                if response.status_code == 200:
                    data = response.json()
                    break
                last_error = f"HTTP {response.status_code} from {endpoint}"
        except httpx.TimeoutException:
            last_error = f"Timeout on {endpoint}"
            continue
        except Exception as e:
            last_error = str(e)
            continue

    if data is None:
        raise HTTPException(
            status_code=502,
            detail=f"All Overpass API endpoints failed. Last error: {last_error}. Try again in a moment.",
        )

    elements = data.get("elements", [])
    features = []
    for el in elements:
        tags = el.get("tags", {})
        el_type = el.get("type")

        if el_type == "node":
            lon = el.get("lon")
            lat = el.get("lat")
        elif el_type in ("way", "relation"):
            center = el.get("center", {})
            lon = center.get("lon")
            lat = center.get("lat")
        else:
            continue

        if lon is None or lat is None:
            continue

        props = {
            "osm_id": el.get("id"),
            "osm_type": el_type,
            "name": tags.get("name", ""),
            "feature_type": request.feature_type,
        }
        props.update(tags)

        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": props,
        })

    if not features:
        raise HTTPException(status_code=404, detail=f"No {label} found in {request.city}. Try a different city name (use English name).")

    layer_name = request.layer_name or f"{label} - {request.city}"
    table_name = sanitize_table_name(layer_name)
    store_geojson_in_postgis(db, table_name, features)
    bbox = get_geojson_bbox(features)

    default_style = {
        "color": "#e74c3c",
        "fillColor": "#e74c3c",
        "opacity": 1.0,
        "fillOpacity": 0.8,
        "radius": 8,
        "zoomScaling": True,
        "minZoomRadius": 4,
        "maxZoomRadius": 20,
    }
    if request.style:
        default_style.update(request.style)

    layer = models.Layer(
        name=layer_name,
        description=f"{label} fetched from OpenStreetMap for {request.city}",
        layer_type="osm",
        geom_type="Point",
        table_name=table_name,
        bbox=bbox,
        feature_count=len(features),
        created_by=current_user.id,
        style=default_style,
        source_info={
            "city": request.city,
            "feature_type": request.feature_type,
            "osm_label": label,
        },
    )
    db.add(layer)
    db.commit()
    db.refresh(layer)

    return {
        "layer": schemas.LayerOut.model_validate(layer),
        "feature_count": len(features),
        "message": f"Successfully fetched {len(features)} {label} in {request.city}",
    }
