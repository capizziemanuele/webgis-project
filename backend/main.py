from fastapi import FastAPI, Depends
from sqlalchemy.orm import Session
from sqlalchemy import text
import json
import re
from db import get_db

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # in dev va bene così
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],)

# -------------------------
# LAYERS LIST
# -------------------------

@app.get("/layers")
def get_layers(db: Session = Depends(get_db)):

    result = db.execute(text("""
        SELECT id, name
        FROM layers
        ORDER BY id
    """))

    return [
        {"id": r.id, "name": r.name}
        for r in result
    ]


# -------------------------
# SINGLE LAYER + FEATURES + BBOX
# -------------------------

@app.get("/layers/{layer_id}")
def get_layer(layer_id: int, db: Session = Depends(get_db)):

    # FEATURES
    features = db.execute(text("""
        SELECT
            id,
            name,
            ST_AsGeoJSON(geom) as geom
        FROM features
        WHERE layer_id = :id
    """), {"id": layer_id})

    # BBOX (PostGIS)
    bbox_result = db.execute(text("""
        SELECT ST_Extent(geom)
        FROM features
        WHERE layer_id = :id
    """), {"id": layer_id}).fetchone()

    bbox_raw = bbox_result[0]

    # parse "BOX(minx miny, maxx maxy)"
    coords = re.findall(r"[-\d.]+", bbox_raw)
    minx, miny, maxx, maxy = map(float, coords)

    # build GeoJSON
    geojson = {
        "type": "FeatureCollection",
        "features": []
    }

    for r in features:
        geojson["features"].append({
            "type": "Feature",
            "geometry": json.loads(r.geom),
            "properties": {
                "id": r.id,
                "name": r.name
            }
        })

    return {
        "data": geojson,
        "bbox": [[miny, minx], [maxy, maxx]]
    }