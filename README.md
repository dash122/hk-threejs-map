# Hong Kong 3D Simulator (hk-threejs-map)

A Hong Kong version of [Slop New York](https://github.com/mrdoob/slop-newyork) by Mr.doob: a 1:1 city simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. The goal is an interactive 3D Hong Kong you can explore on foot, by car, by bicycle, or by helicopter, starting with a pilot area in Eastern District (Tin Hau, North Point, Quarry Bay, Tai Koo).

**Status:** `index.html` now opens Hong Kong's Eastern District (North Point to Tai Koo) with real terrain, roads, flyovers and buildings at their surveyed heights; you can walk, drive, cycle or fly. Traffic, pedestrians, sound and the full map are not ported yet. The original New York simulator is still at `nyc.html`.

## Run it locally

No build step is needed. Serve the folder with any static file server and open it in a browser with WebGPU (current Chrome, Edge or Safari):

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Run the tests with Node 20 or newer:

```sh
node --test tests/*.cjs tests/*.mjs
```

## Hong Kong geodata

`tools/hk/` builds `js/hk-geodata.js`, the Eastern District pilot (Victoria Park to Taikoo Shing) in the simulator's world frame: 1 unit = 1 m, x = east, z = south, y = metres above Principal Datum, origin on King's Road by Java Road, North Point. It holds the land and coastline, the road centreline with levels, one-way directions, lanes and widths, a road graph, 3,400 building footprints with real base and top levels, parks, piers, tram and MTR lines, footpaths, stations and stops, and a terrain height field.

The pilot extracts it reads are committed in `tools/hk/data/`, so rebuilding needs no network:

```sh
node tools/hk/build-hk-geodata.mjs
```

To refresh the extracts from the sources (about 850 MB of downloads, kept in the git-ignored `tools/hk/raw/`):

```sh
tools/hk/fetch-hk-data.sh
node tools/hk/build-hk-geodata.mjs
```

The pilot and backdrop boxes and the HK1980 Grid conversion are in `tools/hk/hk-frame.mjs`.

## Keeping up with upstream

```sh
git remote add upstream https://github.com/mrdoob/slop-newyork
git fetch upstream
git merge upstream/main
```

## License and data

The project code is available under the [MIT License](LICENSE), copyright Mr.doob, for the original Slop New York code.

Geographic data: NYC Open Data; Hong Kong road centreline from the Transport Department's [Road Network (2nd Generation)](https://data.gov.hk/en-data/dataset/hk-td-tis_15-road-network-v2), buildings and the 5 m Digital Terrain Model from the Lands Department via [DATA.GOV.HK](https://data.gov.hk/) and the [CSDI Portal](https://portal.csdi.gov.hk/); and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and dependencies retain their respective licenses.
