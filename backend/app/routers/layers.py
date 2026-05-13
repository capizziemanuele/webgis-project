import os
import json
import uuid
import zipfile
import tempfile
import shutil
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import Response, JSONResponse, StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import text
import io

from app.database import get_db
from app.deps import get_current_user
from app import models, schemas
from app.config import settings

router = APIRouter(prefix="/api/layers", tags=["layers"])


def sanitize_table_name(name: str) -> str:
    import re
    name = re.sub(r'[^a-z0-9_]', '_', name.lower())
    if name[0].isdigit():
        name = 'layer_' + name
    return f"lyr_{name}_{uuid.uuid4().hex[:8]}"


def get_geojson_bbox(features):
    if not features:
        return None
    lons, lats = [], []
    for f in features:
        geom = f.get("geometry", {})
        if not geom:
            continue
        coords = geom.get("coordinates", [])
        def extract_coords(c):
            if not c:
                return
            if isinstance(c[0], (int, float)):
                lons.append(c[0])
                lats.append(c[1])
            else:
                for sub in c:
                    extract_coords(sub)
        extract_coords(coords)
    if not lons:
        return None
    return [min(lons), min(lats), max(lons), max(lats)]


def infer_geom_type(features):
    types = set()
    for f in features:
        geom = f.get("geometry", {})
        if geom:
            t = geom.get("type", "")
            if "Point" in t:
                types.add("Point")
            elif "LineString" in t:
                types.add("LineString")
            elif "Polygon" in t:
                types.add("Polygon")
    if len(types) == 1:
        return list(types)[0]
    return "Mixed"


def store_geojson_in_postgis(db: Session, table_name: str, geojson_features: list):
    db.execute(text(f'DROP TABLE IF EXISTS "{table_name}"'))
    db.execute(text(f"""
        CREATE TABLE "{table_name}" (
            id SERIAL PRIMARY KEY,
            properties JSONB,
            geom GEOMETRY(Geometry, 4326)
        )
    """))
    db.execute(text(f'CREATE INDEX "{table_name}_geom_idx" ON "{table_name}" USING GIST(geom)'))

    for feat in geojson_features:
        geom = feat.get("geometry")
        props = feat.get("properties") or {}
        if not geom:
            continue
        geom_json = json.dumps(geom)
        db.execute(
            text(f'INSERT INTO "{table_name}" (properties, geom) VALUES (:props, ST_SetSRID(ST_GeomFromGeoJSON(:geom), 4326))'),
            {"props": json.dumps(props), "geom": geom_json}
        )
    db.commit()


@router.get("/", response_model=List[schemas.LayerOut])
def list_layers(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.Layer).order_by(models.Layer.created_at.desc()).all()


@router.get("/{layer_id}", response_model=schemas.LayerOut)
def get_layer(layer_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    layer = db.query(models.Layer).filter(models.Layer.id == layer_id).first()
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    return layer


@router.get("/{layer_id}/geojson")
def get_layer_geojson(layer_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    layer = db.query(models.Layer).filter(models.Layer.id == layer_id).first()
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    if layer.layer_type not in ("vector", "osm"):
        raise HTTPException(status_code=400, detail="Layer is not a vector layer")
    if not layer.table_name:
        raise HTTPException(status_code=400, detail="Layer has no data table")

    rows = db.execute(
        text(f'SELECT id, properties, ST_AsGeoJSON(geom) as geom FROM "{layer.table_name}"')
    ).fetchall()

    features = []
    for row in rows:
        features.append({
            "type": "Feature",
            "id": row[0],
            "properties": row[1] if row[1] else {},
            "geometry": json.loads(row[2]) if row[2] else None,
        })

    return JSONResponse(content={
        "type": "FeatureCollection",
        "features": features,
    })


@router.get("/{layer_id}/tiles/{z}/{x}/{y}.png")
def get_raster_tile(layer_id: int, z: int, x: int, y: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    layer = db.query(models.Layer).filter(models.Layer.id == layer_id).first()
    if not layer or layer.layer_type != "raster":
        raise HTTPException(status_code=404, detail="Raster layer not found")
    if not layer.file_path or not os.path.exists(layer.file_path):
        raise HTTPException(status_code=404, detail="Raster file not found")

    try:
        import mercantile
        import rasterio
        from rasterio.warp import reproject, Resampling, calculate_default_transform
        from rasterio.crs import CRS
        from PIL import Image

        tile = mercantile.Tile(x, y, z)
        bounds = mercantile.bounds(tile)
        TILE_SIZE = 256

        with rasterio.open(layer.file_path) as src:
            dst_crs = CRS.from_epsg(4326)
            transform, width, height = calculate_default_transform(
                src.crs, dst_crs, src.width, src.height, *src.bounds
            )

            from rasterio.transform import from_bounds as rio_from_bounds
            dst_transform = rio_from_bounds(bounds.west, bounds.south, bounds.east, bounds.north, TILE_SIZE, TILE_SIZE)

            band_count = min(src.count, 4)
            tile_data = np.zeros((band_count, TILE_SIZE, TILE_SIZE), dtype=np.uint8)

            for i in range(1, band_count + 1):
                reproject(
                    source=rasterio.band(src, i),
                    destination=tile_data[i - 1],
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=dst_transform,
                    dst_crs=dst_crs,
                    resampling=Resampling.bilinear,
                )

            if band_count >= 3:
                rgb = np.stack([tile_data[0], tile_data[1], tile_data[2]], axis=-1)
                if band_count == 4:
                    alpha = tile_data[3]
                    rgba = np.dstack([rgb, alpha])
                    img = Image.fromarray(rgba.astype(np.uint8), 'RGBA')
                else:
                    img = Image.fromarray(rgb.astype(np.uint8), 'RGB')
            else:
                img = Image.fromarray(tile_data[0].astype(np.uint8), 'L')

            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)

        return StreamingResponse(buf, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Tile generation failed: {str(e)}")


@router.post("/upload")
async def upload_layer(
    file: UploadFile = File(...),
    name: str = Form(...),
    description: str = Form(""),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    filename = file.filename or "upload"
    ext = Path(filename).suffix.lower()
    content = await file.read()

    table_name = None
    file_path = None
    layer_type = None
    geom_type = None
    bbox = None
    feature_count = 0
    source_info = {"original_filename": filename}

    try:
        if ext in (".geojson", ".json"):
            layer_type = "vector"
            geojson_data = json.loads(content)
            if geojson_data.get("type") == "FeatureCollection":
                features = geojson_data.get("features", [])
            elif geojson_data.get("type") == "Feature":
                features = [geojson_data]
            else:
                raise HTTPException(status_code=400, detail="Invalid GeoJSON")

            table_name = sanitize_table_name(name)
            store_geojson_in_postgis(db, table_name, features)
            geom_type = infer_geom_type(features)
            bbox = get_geojson_bbox(features)
            feature_count = len(features)

        elif ext == ".zip":
            # Shapefile in zip
            layer_type = "vector"
            with tempfile.TemporaryDirectory() as tmpdir:
                zip_path = os.path.join(tmpdir, "upload.zip")
                with open(zip_path, "wb") as f:
                    f.write(content)
                with zipfile.ZipFile(zip_path, "r") as zf:
                    zf.extractall(tmpdir)

                import fiona
                shp_files = list(Path(tmpdir).rglob("*.shp"))
                if not shp_files:
                    raise HTTPException(status_code=400, detail="No .shp file found in zip")

                features = []
                with fiona.open(str(shp_files[0])) as src:
                    import pyproj
                    from shapely.geometry import shape, mapping
                    transformer = None
                    if src.crs and src.crs.get("init", "").upper() != "EPSG:4326":
                        try:
                            src_crs = pyproj.CRS.from_dict(src.crs)
                            dst_crs = pyproj.CRS.from_epsg(4326)
                            transformer = pyproj.Transformer.from_crs(src_crs, dst_crs, always_xy=True)
                        except Exception:
                            pass

                    for feat in src:
                        props = dict(feat["properties"] or {})
                        geom = feat["geometry"]
                        if transformer and geom:
                            from shapely.ops import transform as shp_transform
                            shp_geom = shape(geom)
                            transformed = shp_transform(transformer.transform, shp_geom)
                            geom = mapping(transformed)
                        features.append({"type": "Feature", "geometry": geom, "properties": props})

                table_name = sanitize_table_name(name)
                store_geojson_in_postgis(db, table_name, features)
                geom_type = infer_geom_type(features)
                bbox = get_geojson_bbox(features)
                feature_count = len(features)

        elif ext == ".kml":
            layer_type = "vector"
            import xml.etree.ElementTree as ET
            features = []
            root = ET.fromstring(content)
            ns = {"kml": "http://www.opengis.net/kml/2.2"}
            for pm in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
                name_el = pm.find("{http://www.opengis.net/kml/2.2}name")
                feat_name = name_el.text if name_el is not None else ""
                for point in pm.iter("{http://www.opengis.net/kml/2.2}Point"):
                    coords_el = point.find("{http://www.opengis.net/kml/2.2}coordinates")
                    if coords_el is not None:
                        parts = coords_el.text.strip().split(",")
                        lon, lat = float(parts[0]), float(parts[1])
                        features.append({
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": [lon, lat]},
                            "properties": {"name": feat_name},
                        })

            table_name = sanitize_table_name(name)
            store_geojson_in_postgis(db, table_name, features)
            geom_type = "Point"
            bbox = get_geojson_bbox(features)
            feature_count = len(features)

        elif ext in (".tif", ".tiff", ".geotiff"):
            layer_type = "raster"
            os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
            safe_name = f"{uuid.uuid4().hex}{ext}"
            file_path = os.path.join(settings.UPLOAD_DIR, safe_name)
            with open(file_path, "wb") as f:
                f.write(content)

            import rasterio
            with rasterio.open(file_path) as src:
                from rasterio.warp import transform_bounds
                bounds_4326 = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
                bbox = [bounds_4326[0], bounds_4326[1], bounds_4326[2], bounds_4326[3]]
                source_info["width"] = src.width
                source_info["height"] = src.height
                source_info["bands"] = src.count

        else:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process file: {str(e)}")

    layer = models.Layer(
        name=name,
        description=description,
        layer_type=layer_type,
        geom_type=geom_type,
        table_name=table_name,
        file_path=file_path,
        bbox=bbox,
        feature_count=feature_count,
        created_by=current_user.id,
        source_info=source_info,
        style={
            "color": "#3388ff",
            "opacity": 0.8,
            "fillColor": "#3388ff",
            "fillOpacity": 0.5,
        },
    )
    db.add(layer)
    db.commit()
    db.refresh(layer)
    return schemas.LayerOut.model_validate(layer)


@router.put("/{layer_id}/style")
def update_layer_style(
    layer_id: int,
    update: schemas.LayerUpdate,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    layer = db.query(models.Layer).filter(models.Layer.id == layer_id).first()
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    if update.style is not None:
        layer.style = update.style
    if update.name is not None:
        layer.name = update.name
    if update.description is not None:
        layer.description = update.description
    if update.is_public is not None:
        layer.is_public = update.is_public
    db.commit()
    db.refresh(layer)
    return schemas.LayerOut.model_validate(layer)


@router.delete("/{layer_id}")
def delete_layer(layer_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    layer = db.query(models.Layer).filter(models.Layer.id == layer_id).first()
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")

    if layer.table_name:
        db.execute(text(f'DROP TABLE IF EXISTS "{layer.table_name}"'))

    if layer.file_path and os.path.exists(layer.file_path):
        os.remove(layer.file_path)

    db.delete(layer)
    db.commit()
    return {"message": "Layer deleted"}
