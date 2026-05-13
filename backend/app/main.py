import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from app.database import init_db
from app.routers import auth, users, layers, osm
from app.config import settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def create_first_admin():
    from app.database import SessionLocal
    from app import models
    from app.auth import get_password_hash

    db = SessionLocal()
    try:
        existing = db.query(models.User).filter(models.User.is_admin == True).first()
        if not existing:
            admin = models.User(
                username=settings.FIRST_ADMIN_USERNAME,
                email=settings.FIRST_ADMIN_EMAIL,
                password_hash=get_password_hash(settings.FIRST_ADMIN_PASSWORD),
                is_admin=True,
                is_active=True,
            )
            db.add(admin)
            db.commit()
            logger.info(f"Created first admin user: {settings.FIRST_ADMIN_USERNAME}")
    except Exception as e:
        logger.error(f"Failed to create admin: {e}")
        db.rollback()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting WebGIS backend...")
    init_db()
    create_first_admin()
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    yield
    logger.info("Shutting down WebGIS backend...")


app = FastAPI(
    title="WebGIS API",
    description="A full-featured WebGIS backend with PostGIS, OSM integration, and user management",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(layers.router)
app.include_router(osm.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "WebGIS API"}
