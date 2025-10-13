"""
Generate an H3 hex grid covering all CONUS states (h3-py >= 4.0)
and export as GeoJSON, Parquet, and zipped ESRI Shapefile for GEE upload.
"""

import os
import shutil
from google.cloud import bigquery
import geopandas as gpd
from shapely import wkt
from shapely.geometry import Polygon
from shapely.ops import unary_union
import h3

# --- CONFIG ---
PROJECT_ID = "agmap-474117"
REGION_GEOJSON = "conus_states.geojson"
OUT_GEOJSON = "h3_res4_conus.geojson"
OUT_PARQUET = "h3_res4_conus.parquet"
OUT_SHP_DIR = "h3_res4_conus_shp"
OUT_ZIP = "h3_res4_conus_shp.zip"
RESOLUTION = 4
BUFFER_KM = 0.5

# --- 1. Load or fetch region geometry ---
if not os.path.exists(REGION_GEOJSON):
    print("Querying BigQuery for state boundaries…")
    client = bigquery.Client(project=PROJECT_ID)
    sql = """
    SELECT ST_ASTEXT(ST_UNION_AGG(state_geom)) AS wkt_geom
    FROM `bigquery-public-data.geo_us_boundaries.states`
    WHERE state_name NOT IN (
      'Alaska','Hawaii','Puerto Rico',
      'Guam','Virgin Islands','American Samoa','Northern Mariana Islands'
    )
    """
    row = list(client.query(sql))[0]
    region_geom = wkt.loads(row["wkt_geom"])
    gpd.GeoDataFrame(geometry=[region_geom], crs="EPSG:4326").to_file(REGION_GEOJSON, driver="GeoJSON")
    print(f"Saved region geometry to {REGION_GEOJSON}")
else:
    print(f"Loading cached region geometry from {REGION_GEOJSON}")
    region_gdf = gpd.read_file(REGION_GEOJSON)
    region_geom = unary_union(region_gdf.geometry)

# --- 2. Add small outward buffer to capture border cells ---
region_gdf = gpd.GeoSeries([region_geom], crs="EPSG:4326").to_crs("EPSG:5070")
region_gdf = region_gdf.buffer(BUFFER_KM * 1000)   # buffer in meters
region_geom = region_gdf.to_crs("EPSG:4326").iloc[0]
print(f"Applied {BUFFER_KM} km outward buffer to region boundary.")

# --- 3. Generate H3 grid ---
print(f"Generating H3 cells at resolution {RESOLUTION}…")

def shapely_to_rings(geom):
    if geom.geom_type == "Polygon":
        outer = [(lat, lon) for lon, lat in geom.exterior.coords]
        holes = [[(lat, lon) for lon, lat in ring.coords] for ring in geom.interiors]
        return [(outer, holes)]
    elif geom.geom_type == "MultiPolygon":
        rings = []
        for part in geom.geoms:
            outer = [(lat, lon) for lon, lat in part.exterior.coords]
            holes = [[(lat, lon) for lon, lat in ring.coords] for ring in part.interiors]
            rings.append((outer, holes))
        return rings
    else:
        raise ValueError(f"Unexpected geometry type: {geom.geom_type}")

rings = shapely_to_rings(region_geom)

h3_indices = set()
for outer, holes in rings:
    poly = h3.LatLngPoly(outer, *holes)
    cells = h3.polygon_to_cells(poly, RESOLUTION)
    h3_indices.update(cells)

print(f"✅ Generated {len(h3_indices):,} H3 cells.")

# --- 4. Convert to GeoDataFrame ---
def h3_to_polygon(h):
    boundary = h3.cell_to_boundary(h)
    return Polygon([(lon, lat) for lat, lon in boundary])

records = [{"h3": h, "geometry": h3_to_polygon(h)} for h in h3_indices]
gdf = gpd.GeoDataFrame(records, crs="EPSG:4326")

# --- 5. Save outputs ---
print("Writing outputs…")
gdf.to_file(OUT_GEOJSON, driver="GeoJSON")
try:
    gdf.to_parquet(OUT_PARQUET)
except Exception as e:
    print("(Skipping Parquet write – optional):", e)

print(f"  Cached region boundary: {REGION_GEOJSON}")
print(f"  Grid GeoJSON: {OUT_GEOJSON}")
print(f"  Grid Parquet: {OUT_PARQUET}")

# --- 6. Export as zipped Shapefile for GEE ---
print("Converting to ESRI Shapefile and zipping for Earth Engine…")

# Reproject to WGS84 (safeguard)
gdf = gdf.to_crs("EPSG:4326")

# Remove old files if they exist
if os.path.exists(OUT_SHP_DIR):
    shutil.rmtree(OUT_SHP_DIR)
if os.path.exists(OUT_ZIP):
    os.remove(OUT_ZIP)

# Write Shapefile
gdf.to_file(OUT_SHP_DIR, driver="ESRI Shapefile")

# Zip folder
shutil.make_archive(OUT_SHP_DIR, "zip", OUT_SHP_DIR)
print(f"✅ Shapefile written and zipped for GEE upload: {OUT_ZIP}")

print("\nAll outputs ready for use:")
print(f"  • GeoJSON:   {OUT_GEOJSON}")
print(f"  • Parquet:   {OUT_PARQUET}")
print(f"  • Shapefile: {OUT_ZIP} (upload to GEE)")
