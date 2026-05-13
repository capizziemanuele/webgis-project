import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, Float, BigInteger
from sqlalchemy.dialects.postgresql import JSONB
from geoalchemy2 import Geometry
from app.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String(100), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class Layer(Base):
    __tablename__ = "layers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text, default="")
    layer_type = Column(String(20), nullable=False)  # 'vector', 'raster', 'osm'
    geom_type = Column(String(20))  # 'Point', 'LineString', 'Polygon', 'Mixed'
    table_name = Column(String(100))  # PostGIS table for vector/osm layers
    file_path = Column(String(500))  # file path for raster layers
    style = Column(JSONB, default={})
    bbox = Column(JSONB)  # [minx, miny, maxx, maxy] in WGS84
    feature_count = Column(Integer, default=0)
    created_by = Column(Integer)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    is_public = Column(Boolean, default=True)
    source_info = Column(JSONB, default={})  # OSM query params or original filename
