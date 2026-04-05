from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import numpy as np
from scipy.spatial import KDTree
import math

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load dataset
try:
    df = pd.read_excel("accidents.xlsx", engine="openpyxl")
except:
    df = pd.read_csv("accidents.xlsx", encoding="latin1")

# Clean column names
df.columns = df.columns.str.strip().str.lower().str.replace(" ", "_")

print("Columns found:", df.columns.tolist())
print("Total rows:", len(df))

# Build KDTree
coords = df[["latitude", "longitude"]].values
tree = KDTree(coords)

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

@app.get("/")
def root():
    return {"message": "Accident Alert API Running!", "total_records": len(df)}

@app.get("/accidents")
def get_accidents():
    try:
        data = df[["latitude", "longitude", "ward_name", "alarm_type"]].dropna()
        return {"accidents": data.to_dict(orient="records"), "count": len(data)}
    except Exception as e:
        return {"error": str(e)}

@app.post("/check-nearby")
async def check_nearby(data: dict):
    try:
        lat = data["lat"]
        lon = data["lon"]
        radius = data.get("radius", 500)

        indices = tree.query_ball_point([lat, lon], r=radius/111000)
        nearby = df.iloc[indices]

        results = []
        for _, row in nearby.iterrows():
            dist = haversine(lat, lon, row["latitude"], row["longitude"])
            if dist <= radius:
                results.append({
                    "latitude": float(row["latitude"]),
                    "longitude": float(row["longitude"]),
                    "ward_name": str(row.get("ward_name", "")),
                    "alarm_type": str(row.get("alarm_type", "")),
                    "speed": float(row.get("speed", 0)),
                    "distance": round(dist)
                })

        return {"hotspots": results, "count": len(results)}
    except Exception as e:
        return {"error": str(e)}