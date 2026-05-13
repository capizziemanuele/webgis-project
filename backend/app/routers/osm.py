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

    city_query = request.city
    if request.country:
        city_query = f"{request.city}, {request.country}"

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

    try:
        with httpx.Client(timeout=90) as client:
            response = client.post(
                "https://overpass-api.de/api/interpreter",
                data={"data": overpass_query},
            )
            response.raise_for_status()
            data = response.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Overpass API timeout. Try a smaller city or different feature type.")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Overpass API error: {str(e)}")

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
