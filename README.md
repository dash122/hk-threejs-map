# Hong Kong 3D Simulator (hk-threejs-map)

A Hong Kong version of [Slop New York](https://github.com/mrdoob/slop-newyork) by Mr.doob: a 1:1 city simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. The goal is an interactive 3D Hong Kong you can explore on foot, by car, by bicycle, or by helicopter, starting with a pilot area in Eastern District (Tin Hau, North Point, Quarry Bay, Tai Koo).

**Status:** this repository currently contains the unmodified Slop New York code, imported with its full history, plus a pinned three.js version. The Hong Kong geography replaces the New York data in the next steps.

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

## Keeping up with upstream

```sh
git remote add upstream https://github.com/mrdoob/slop-newyork
git fetch upstream
git merge upstream/main
```

## License and data

The project code is available under the [MIT License](LICENSE), copyright Mr.doob, for the original Slop New York code.

Geographic data so far: NYC Open Data and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Hong Kong data from [DATA.GOV.HK](https://data.gov.hk/) (Transport Department, Lands Department) and OpenStreetMap will be credited here as it is added. Third-party data and dependencies retain their respective licenses.
