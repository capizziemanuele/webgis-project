from pydantic import BaseModel, EmailStr
from typing import Optional, List, Any, Dict
from datetime import datetime


class UserCreate(BaseModel):
    username: str
    email: str
    password: str
    is_admin: bool = False


class UserUpdate(BaseModel):
    is_active: Optional[bool] = None
    is_admin: Optional[bool] = None
    password: Optional[str] = None


class UserOut(BaseModel):
    id: int
    username: str
    email: str
    is_active: bool
    is_admin: bool
    created_at: datetime

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserOut


class LoginRequest(BaseModel):
    username: str
    password: str


class LayerStyle(BaseModel):
    color: Optional[str] = "#3388ff"
    opacity: Optional[float] = 0.8
    weight: Optional[float] = 2
    fillColor: Optional[str] = "#3388ff"
    fillOpacity: Optional[float] = 0.5
    radius: Optional[float] = 8
    iconUrl: Optional[str] = None
    iconSize: Optional[List[float]] = None
    zoomScaling: Optional[bool] = True
    minZoomRadius: Optional[float] = 4
    maxZoomRadius: Optional[float] = 16
    colorRamp: Optional[str] = None


class LayerCreate(BaseModel):
    name: str
    description: Optional[str] = ""
    style: Optional[Dict[str, Any]] = {}


class LayerUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    style: Optional[Dict[str, Any]] = None
    is_public: Optional[bool] = None


class LayerOut(BaseModel):
    id: int
    name: str
    description: str
    layer_type: str
    geom_type: Optional[str]
    style: Dict[str, Any]
    bbox: Optional[List[float]]
    feature_count: int
    created_at: datetime
    is_public: bool
    source_info: Dict[str, Any]

    class Config:
        from_attributes = True


class OSMQueryRequest(BaseModel):
    city: str
    feature_type: str  # 'hospital', 'school', etc.
    layer_name: Optional[str] = None
    style: Optional[Dict[str, Any]] = {}
    country: Optional[str] = None
