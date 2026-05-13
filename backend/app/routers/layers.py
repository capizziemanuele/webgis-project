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


COLORMAPS = {
    "gray":    lambda v: np.stack([v, v, v], axis=-1),
    "viridis": lambda v: _apply_lut(v, _VIRIDIS_LUT),
    "plasma":  lambda v: _apply_lut(v, _PLASMA_LUT),
    "hot":     lambda v: np.stack([np.clip(v * 3, 0, 1), np.clip(v * 3 - 1, 0, 1), np.clip(v * 3 - 2, 0, 1)], axis=-1),
    "terrain": lambda v: _apply_lut(v, _TERRAIN_LUT),
    "rdylgn":  lambda v: _apply_lut(v, _RDYLGN_LUT),
}

def _apply_lut(v, lut):
    idx = (np.clip(v, 0, 1) * (len(lut) - 1)).astype(int)
    return np.array(lut, dtype=np.float32)[idx]

# Compact 16-stop LUTs (RGB 0-1)
_VIRIDIS_LUT = [(0.267,0.005,0.329),(0.283,0.141,0.458),(0.254,0.265,0.530),(0.207,0.372,0.553),(0.164,0.471,0.558),(0.128,0.566,0.551),(0.135,0.659,0.518),(0.208,0.748,0.473),(0.330,0.831,0.408),(0.477,0.900,0.322),(0.626,0.952,0.223),(0.773,0.984,0.121),(0.902,0.991,0.143),(0.988,0.962,0.373),(0.993,0.906,0.144),(0.993,0.906,0.144)]
_PLASMA_LUT = [(0.050,0.030,0.527),(0.212,0.019,0.583),(0.354,0.013,0.611),(0.482,0.022,0.615),(0.594,0.065,0.584),(0.690,0.126,0.527),(0.771,0.192,0.455),(0.840,0.261,0.378),(0.897,0.334,0.303),(0.941,0.413,0.228),(0.972,0.499,0.152),(0.990,0.591,0.079),(0.994,0.688,0.041),(0.983,0.791,0.102),(0.957,0.897,0.225),(0.940,0.975,0.131)]
_TERRAIN_LUT = [(0.200,0.200,0.600),(0.200,0.400,0.800),(0.200,0.600,0.900),(0.400,0.700,0.400),(0.600,0.800,0.400),(0.800,0.850,0.500),(0.700,0.600,0.300),(0.600,0.500,0.300),(0.800,0.700,0.500),(0.900,0.850,0.750),(1.000,1.000,1.000),(1.000,1.000,1.000),(1.000,1.000,1.000),(1.000,1.000,1.000),(1.000,1.000,1.000),(1.000,1.000,1.000)]
_RDYLGN_LUT = [(0.647,0.000,0.149),(0.843,0.188,0.152),(0.957,0.427,0.263),(0.992,0.682,0.380),(0.996,0.878,0.565),(1.000,1.000,0.749),(0.851,0.937,0.545),(0.651,0.851,0.416),(0.400,0.741,0.388),(0.102,0.596,0.314),(0.000,0.408,0.216),(0.000,0.408,0.216),(0.000,0.408,0.216),(0.000,0.408,0.216),(0.000,0.408,0.216),(0.000,0.408,0.216)]


@router.get("/{layer_id}/tiles/{z}/{x}/{y}.png")
def get_raster_tile(
    layer_id: int, z: int, x: int, y: int,
    cm: str = "gray",
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    layer = db.query(models.Layer).filter(models.Layer.id == layer_id).first()
    if not layer or layer.layer_type != "raster":
        raise HTTPException(status_code=404, detail="Raster layer not found")
    if not layer.file_path or not os.path.exists(layer.file_path):
        raise HTTPException(status_code=404, detail="Raster file not found")

    TILE_SIZE = 256

    def _empty_tile():
        buf = io.BytesIO()
        from PIL import Image
        Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0)).save(buf, "PNG")
        buf.seek(0)
        return buf

    try:
        import mercantile
        import rasterio
        from rasterio.warp import reproject, Resampling
        from rasterio.crs import CRS
        from rasterio.transform import from_bounds as rio_from_bounds
        from PIL import Image

        tile = mercantile.Tile(x, y, z)
        bounds = mercantile.bounds(tile)
        dst_crs = CRS.from_epsg(4326)
        dst_transform = rio_from_bounds(bounds.west, bounds.south, bounds.east, bounds.north, TILE_SIZE, TILE_SIZE)

        with rasterio.open(layer.file_path) as src:
            band_count = min(src.count, 4)
            nodata_val = src.nodata
            tile_data = np.zeros((band_count, TILE_SIZE, TILE_SIZE), dtype=np.float64)

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

        # Build nodata mask (pixels that should be transparent)
        if nodata_val is not None:
            nodata_mask = np.all(np.abs(tile_data - nodata_val) < 1e-6, axis=0)
        else:
            # No declared nodata: treat all-zero pixels as transparent
            nodata_mask = np.all(tile_data == 0, axis=0)

        # If tile is entirely nodata, return empty transparent tile
        if nodata_mask.all():
            return StreamingResponse(_empty_tile(), media_type="image/png",
                                     headers={"Cache-Control": "no-cache"})

        colormap_name = (layer.style or {}).get("colormap", cm) if cm == "gray" else cm
        cmap_fn = COLORMAPS.get(colormap_name, COLORMAPS["gray"])

        def percentile_stretch(band):
            valid = band[~nodata_mask]
            if len(valid) == 0:
                return np.zeros_like(band)
            p2, p98 = np.percentile(valid, 2), np.percentile(valid, 98)
            if p98 <= p2:
                return np.zeros_like(band)
            return np.clip((band - p2) / (p98 - p2), 0.0, 1.0)

        if band_count <= 2:
            # Single band → apply colormap
            norm = percentile_stretch(tile_data[0])
            rgb_f = cmap_fn(norm)  # H x W x 3, values 0-1
            rgb = (rgb_f * 255).astype(np.uint8)
            alpha = np.where(nodata_mask, 0, 255).astype(np.uint8)
            rgba = np.dstack([rgb, alpha])
        else:
            # Multi-band RGB(A)
            r = (percentile_stretch(tile_data[0]) * 255).astype(np.uint8)
            g = (percentile_stretch(tile_data[1]) * 255).astype(np.uint8)
            b = (percentile_stretch(tile_data[2]) * 255).astype(np.uint8)
            alpha = np.where(nodata_mask, 0, 255).astype(np.uint8)
            if band_count == 4:
                # Use original alpha channel where it's non-zero
                src_alpha = tile_data[3].astype(np.uint8)
                alpha = np.where(nodata_mask, 0, src_alpha)
            rgba = np.dstack([r, g, b, alpha])

        img = Image.fromarray(rgba.astype(np.uint8), "RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)

        return StreamingResponse(buf, media_type="image/png", headers={"Cache-Control": "no-cache"})

    except Exception as e:
        return StreamingResponse(_empty_tile(), media_type="image/png",
                                 headers={"Cache-Control": "no-cache", "X-Error": str(e)[:200]})


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
                    if src.crs:
                        try:
                            src_crs = pyproj.CRS.from_user_input(src.crs)
                            dst_crs = pyproj.CRS.from_epsg(4326)
                            if not src_crs.equals(dst_crs):
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
