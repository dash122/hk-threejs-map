#!/bin/bash
# tools/hk/fetch-hk-data.sh — downloads the Hong Kong sources and rewrites the pilot extracts in tools/hk/data/.
# usage: tools/hk/fetch-hk-data.sh [raw dir]   (raw downloads, about 850 MB unpacked; default tools/hk/raw, git-ignored)
# then:  node tools/hk/build-hk-geodata.mjs
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RAW=${1:-$HERE/raw}
DATA=$HERE/data
mkdir -p "$RAW" "$DATA"
get() { # get <url> <file>: download once, atomically
  [ -s "$2" ] && return 0
  curl -sS -f -L --retry 4 --retry-delay 5 -m 3600 -o "$2.part" "$1"
  mv -- "$2.part" "$2"
  echo "ok $(basename "$2") $(wc -c < "$2")"
}

# Transport Department: Road Network (2nd Generation), road centreline (CityGML, HK1980 Grid)
get https://static.data.gov.hk/td/road-network-v2/CENTERLINE.gml "$RAW/CENTERLINE.gml"

# Lands Department: 5 m Digital Terrain Model (ESRI ASCII grid, HK1980 Grid)
get https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip "$RAW/Whole_HK_DTM_5m.zip"
[ -s "$RAW/Whole_HK_DTM_5m.asc" ] || unzip -o -q "$RAW/Whole_HK_DTM_5m.zip" -d "$RAW"

# Lands Department: Building polygons with base and top levels, from the CSDI Portal's WFS (WGS 84 GeoJSON).
# The box is the pilot (tools/hk/hk-frame.mjs) plus the 0.003° margin extract-gov.mjs keeps; WFS 2.0 takes lat,lon order.
WFS=https://portal.csdi.gov.hk/server/services/common/landsd_rcd_1637211194312_35158/MapServer/WFSServer
get "$WFS?service=wfs&version=2.0.0&request=GetFeature&typeNames=csdi:Building&outputFormat=geojson&count=200000&bbox=22.273,114.181,22.300,114.227,urn:ogc:def:crs:EPSG::4326" "$RAW/landsd_building.geojson"

# OpenStreetMap: the coastline through Overpass (a light query), the pilot's streets, parks and piers from the OSM API
OVERPASS_ENDPOINTS=${OVERPASS_ENDPOINTS:-"https://overpass-api.de/api/interpreter https://maps.mail.ru/osm/tools/overpass/api/interpreter"} \
  bash "$HERE/../overpass.sh" "$DATA/osm_hk_coast.json" "$HERE/queries/q_hk_coast.overpassql"
node "$HERE/osm-tiles.mjs" "$RAW" "$DATA"

node "$HERE/extract-gov.mjs" "$RAW" "$DATA"
