from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, text

app = FastAPI()

# -------------------------
# CORS (IMPORTANTE per frontend su VPS)
# -------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------
# DATABASE CONNECTION
# -------------------------
DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/gisdb"

engine = create_engine(DATABASE_URL)

# -------------------------
# ROOT TEST
# -------------------------
@app.get("/")
def root():
    return {"status": "WebGIS API running 🚀"}

# -------------------------
# LAYERS ENDPOINT (GeoJSON)
# -------------------------
@app.get("/layers")
def get_layers():
    with engine.connect() as conn:

        query = text("""
            SELECT jsonb_build_object(
                'type', 'FeatureCollection',
                'features', jsonb_agg(
                    jsonb_build_object(
                        'type', 'Feature',
                        'geometry', ST_AsGeoJSON(geom)::jsonb,
                        'properties', jsonb_build_object(
                            'id', id,
                            'name', name
                        )
                    )
                )
            )
            FROM places;
        """)

        result = conn.execute(query).fetchone()

        if result is None or result[0] is None:
            return {"type": "FeatureCollection", "features": []}

        return result[0]

# -------------------------
# OPTIONAL SIMPLE TEST ENDPOINT
# -------------------------
@app.get("/health")
def health():
    return {"status": "ok"}