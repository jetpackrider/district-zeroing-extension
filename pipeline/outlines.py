"""Build and check the optional county outlines sidecar: one simplified outline per county.

Each county's land blocks (ALAND20 > 0) are dissolved into one shape, then the whole state is
simplified at once in mapshaper so that two neighboring counties keep one shared, identical edge.
The panel draws county clusters from this file without loading every county's block geometry.
See docs/BUNDLE_FORMAT.md, "Outlines sidecar".
"""
import gzip
import json
from pathlib import Path
import struct
import subprocess
import tempfile

import numpy as np
from pyproj import Transformer
import shapely

from format import atomic_write, file_matches, packed_file, publish
from inputs import CACHE, CENSUS, ROOT, STATES, download, tiger_blocks

# Simplification tolerances in meters, tried in order: mapshaper's Douglas-Peucker on the sphere
# (lon/lat input), so no simplified edge strays more than this from the dissolved block edges. A
# coarser one is used only when the file would exceed MAX_BYTES gzipped (Alaska's coast).
SIMPLIFY = (50, 100, 200)
MAX_BYTES = 1_000_000
# Coordinate decimals (1e-5 degree is about 1.1 m of latitude).
DECIMALS = 5
# Each outline's area must lie between the sum of its land blocks' areaM2 and that plus its
# water-only blocks' (lakes are filled in), widened by this share, or by ABSOLUTE_M2 for very small
# counties, where 50 m of simplification is a larger share of the area.
RELATIVE = 0.03
ABSOLUTE_M2 = 2e6
# Overlap between neighboring outlines (sum of areas minus the area of their union), as a share of
# the state's area. Shared edges are identical, so only rounding slivers may remain.
OVERLAP = 1e-4


def dissolve(shapes):
    """Union of a clean polygon coverage (TIGER blocks share exact edges). Falls back to a full
    union when the fast coverage union does not preserve the area."""
    merged = shapely.coverage_union_all(shapes)
    expected = float(shapely.area(shapes).sum())
    if not shapely.is_valid(merged) or abs(shapely.area(merged) - expected) > 1e-9 * max(expected, 1e-12):
        merged = shapely.union_all(shapes)
    return merged


def fill_lakes(merged):
    """Fill the holes in each county's land that no other county's land reaches into: lakes and
    ponds (water-only blocks), which would otherwise be most of the vertices. Holes that are another
    county (an independent city inside a Virginia county, say) stay open."""
    tree = shapely.STRtree(merged)
    filled = []
    for index, shape in enumerate(merged):
        parts = []
        for polygon in shapely.get_parts(shape):
            holes = [ring for ring in polygon.interiors if any(
                other != index and shapely.area(shapely.intersection(merged[other], shapely.Polygon(ring))) > 0
                for other in tree.query(shapely.Polygon(ring), predicate="intersects"))]
            parts.append(shapely.Polygon(polygon.exterior, holes))
        filled.append(shapely.union_all(parts) if len(parts) > 1 else parts[0])
    return np.asarray(filled)


def outlines_file(county_fips, county_of, land, shapes, crs):
    """The gzipped GeoJSON FeatureCollection, feature id = county index, properties.fips."""
    mapshaper = ROOT / "node_modules/mapshaper/bin/mapshaper"
    if not mapshaper.exists():
        raise RuntimeError("Install mapshaper first: npm ci --prefix pipeline")
    transformer = Transformer.from_crs(crs, 4326, always_xy=True)
    land = np.asarray(land) > 0
    with tempfile.TemporaryDirectory(dir=CACHE) as directory:
        source = Path(directory) / "counties.geojson"
        target = Path(directory) / "outlines.geojson"
        merged = []
        for index, fips in enumerate(county_fips):
            selected = np.flatnonzero((county_of == index) & land)
            if not len(selected):
                raise ValueError(f"County {fips} has no land blocks")
            merged.append(dissolve(shapes[selected]))
        merged = shapely.transform(fill_lakes(np.asarray(merged)), transformer.transform, interleaved=False)
        with source.open("w", encoding="utf-8") as stream:
            stream.write('{"type":"FeatureCollection","features":[')
            for index, fips in enumerate(county_fips):
                if index:
                    stream.write(",")
                stream.write(f'{{"type":"Feature","properties":{{"i":{index},"fips":"{fips}"}},'
                             f'"geometry":{shapely.to_geojson(merged[index])}}}')
            stream.write("]}")
        for meters in SIMPLIFY:
            # One dataset for the whole state: mapshaper finds the shared county edges as shared arcs
            # and simplifies (and rounds) each arc once, so neighbors stay consistent.
            subprocess.run(["node", "--max-old-space-size=4000", str(mapshaper), "-quiet", "-i", str(source),
                            "-simplify", "dp", f"interval={meters}m", "keep-shapes", "-o", "force",
                            "format=geojson", f"precision={10 ** -DECIMALS:.{DECIMALS}f}", str(target)],
                           check=True)
            ref, packed = feature_collection(json.loads(target.read_bytes()), county_fips)
            if ref["bytes"] <= MAX_BYTES:
                break
    return ref, packed


def feature_collection(output, county_fips):
    """Mapshaper's output as the sidecar: features in county order, valid, 5-decimal coordinates."""
    by_index = {feature["properties"]["i"]: feature["geometry"] for feature in output["features"]}
    if sorted(by_index) != list(range(len(county_fips))) or len(output["features"]) != len(county_fips):
        raise ValueError("Mapshaper lost or duplicated a county outline")
    features = []
    for index, fips in enumerate(county_fips):
        geometry = dict(type=by_index[index]["type"], coordinates=rounded(by_index[index]["coordinates"]))
        shape = shapely.from_geojson(json.dumps(geometry))
        if not shapely.is_valid(shape):
            # Rounding or simplification can make a ring touch or cross itself. Rebuilding the rings
            # and snapping to the same 5-decimal grid repairs it with local changes only.
            shape = shapely.make_valid(shape, method="structure", keep_collapsed=False)
            shape = shapely.set_precision(shape, 10 ** -DECIMALS)
            geometry = json.loads(shapely.to_geojson(shape))
            geometry["coordinates"] = rounded(geometry["coordinates"])
            if geometry["type"] not in ("Polygon", "MultiPolygon") or not shapely.is_valid(
                    shapely.from_geojson(json.dumps(geometry))):
                raise ValueError(f"County {fips}: could not repair its simplified outline")
        features.append(dict(type="Feature", id=index, properties=dict(fips=fips), geometry=geometry))
    raw = json.dumps(dict(type="FeatureCollection", features=features), separators=(",", ":")).encode()
    return packed_file("outlines.{hash}.json.gz", raw)


def rounded(coordinates):
    if isinstance(coordinates[0], (int, float)):
        return [round(value, DECIMALS) for value in coordinates]
    return [rounded(part) for part in coordinates]


def attrs_areas(directory, manifest):
    """County index and areaM2 per block, read from the bundle's attributes (docs/BUNDLE_FORMAT.md)."""
    ref = manifest["attrs"]
    path = directory / ref["file"]
    if not file_matches(path, ref):
        raise ValueError("Attributes failed integrity check")
    raw = gzip.decompress(path.read_bytes())
    magic, size = struct.unpack_from("<4sI", raw)
    if magic != b"ZDB1":
        raise ValueError("Invalid bundle attributes magic")
    header = json.loads(raw[8:8 + size])
    n, m = header["n"], header["m"]
    offset = 8 + size
    sections = {}
    for name, dtype, count in [("geoid", "<u8", n), ("pop", "<i4", n), ("adjusted", "<i4", n),
                               ("county", "<u2", n), ("precinct", "<u4", n), ("degree", "<u4", n),
                               ("targets", "<i4", m), ("length", "<u2", m), ("outer", "<u4", n),
                               ("area", "<f4", n)]:
        itemsize = np.dtype(dtype).itemsize
        offset += -offset % itemsize
        sections[name] = np.frombuffer(raw, dtype=dtype, count=count, offset=offset)
        offset += itemsize * count
    if offset != len(raw):
        raise ValueError("Attributes length differs from the documented layout")
    return header["countyFips"], sections["county"], sections["area"].astype(np.float64)


def water_only(directory, manifest, n):
    ref = manifest.get("water")
    if not ref or not file_matches(directory / ref["file"], ref):
        raise ValueError("Water sidecar is missing or differs (run: build.py water STATE)")
    water = np.frombuffer(gzip.decompress((directory / ref["file"]).read_bytes()), dtype=np.uint8)
    if len(water) != n:
        raise ValueError("Water sidecar length differs from the block count")
    return water == 1


def check_outlines(directory, manifest, ref=None):
    """Raise unless the manifest's outlines entry is a valid outline file for this bundle.

    Checks: manifest entry (and, given `ref`, that it is this exact recomputed file), size and hash,
    one feature per county with id = county index and properties.fips = its FIPS, valid non-empty
    polygons with 5-decimal WGS84 coordinates, each outline's area between the sum of its land
    blocks' areaM2 and that plus its water-only blocks' (lakes are filled), both in EPSG:5070 as the
    attributes are, and no overlap between neighbors
    beyond rounding. Returns a small report."""
    entry = manifest.get("outlines")
    if not entry or (ref is not None and entry != ref) or not file_matches(directory / entry["file"], entry):
        raise ValueError("Outlines sidecar is missing or differs (run: build.py outlines STATE)")
    county_fips, county_of, area = attrs_areas(directory, manifest)
    if county_fips != [county["fips"] for county in manifest["counties"]]:
        raise ValueError("Attributes and manifest counties disagree")
    water = water_only(directory, manifest, len(area))
    land_area = np.bincount(county_of, weights=np.where(water, 0, area), minlength=len(county_fips))
    water_area = np.bincount(county_of, weights=np.where(water, area, 0), minlength=len(county_fips))
    data = json.loads(gzip.decompress((directory / entry["file"]).read_bytes()))
    features = data.get("features")
    if data.get("type") != "FeatureCollection" or not isinstance(features, list) or len(features) != len(county_fips):
        raise ValueError(f"Expected {len(county_fips)} county features")
    geometries = []
    for index, (feature, fips) in enumerate(zip(features, county_fips, strict=True)):
        geometry = feature.get("geometry") or {}
        if (feature.get("type") != "Feature" or feature.get("id") != index or feature.get("properties") != {"fips": fips}
                or geometry.get("type") not in ("Polygon", "MultiPolygon")):
            raise ValueError(f"Feature {index} is not county {fips}'s polygon")
        flat = np.asarray(list(values(geometry["coordinates"])), dtype=np.float64).reshape(-1, 2)
        if (np.any(np.abs(flat[:, 0]) > 180) or np.any(np.abs(flat[:, 1]) > 90)
                or np.any(np.abs(np.round(flat, DECIMALS) - flat) > 1e-9)):
            raise ValueError(f"County {fips}: coordinates out of range or not rounded to {DECIMALS} decimals")
        geometries.append(shapely.from_geojson(json.dumps(geometry)))
    geometries = np.asarray(geometries)
    invalid = np.flatnonzero(~shapely.is_valid(geometries) | shapely.is_empty(geometries))
    if len(invalid):
        raise ValueError(f"{len(invalid)} invalid outlines, e.g. {[(county_fips[i], shapely.is_valid_reason(geometries[i])) for i in invalid[:5]]}")
    project = Transformer.from_crs(4326, 5070, always_xy=True).transform
    projected = shapely.transform(geometries, project, interleaved=False)
    outline_area = shapely.area(projected)
    error = np.maximum.reduce([land_area - outline_area, outline_area - land_area - water_area,
                               np.zeros(len(county_fips))])
    bad = np.flatnonzero(error > np.maximum(RELATIVE * land_area, ABSOLUTE_M2))
    if len(bad):
        raise ValueError(f"{len(bad)} outlines differ in area from their blocks, e.g. (fips, outline, land, water) "
                         f"{[(county_fips[i], *(round(float(a[i])) for a in (outline_area, land_area, water_area))) for i in bad[:5]]}")
    total = float(outline_area.sum())
    overlap = (total - float(shapely.area(shapely.union_all(projected)))) / total
    if overlap > OVERLAP:
        raise ValueError(f"Neighboring outlines overlap by {overlap:.2e} of the state's area")
    share = error / np.maximum(land_area, 1)
    worst = int(np.argmax(share))
    return dict(counties=len(county_fips), bytes=entry["bytes"],
                rawBytes=len(json.dumps(data, separators=(",", ":"))),
                vertices=int(shapely.get_num_coordinates(geometries).sum()),
                worstAreaShare=round(float(share[worst]), 5), worstAreaCounty=county_fips[worst],
                filledLakeShare=round(float((total - land_area.sum()) / land_area.sum()), 6),
                overlapShare=float(f"{overlap:.3g}"))


def values(coordinates):
    if isinstance(coordinates[0], (int, float)):
        yield from coordinates
    else:
        for part in coordinates:
            yield from values(part)


def outlines_for_bundle(state, validate):
    """Add the outlines sidecar to an already-built state (or, with validate, check it)."""
    from towns import bundle_ids
    directory = ROOT.parent / "data" / state
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    if manifest["state"] != state or manifest["stateFips"] != STATES[state] or manifest["format"] != 1:
        raise ValueError(f"Invalid {state} manifest")
    if validate:
        report = check_outlines(directory, manifest)
    else:
        fips = STATES[state]
        path = download(f"{CENSUS}/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_{fips}_tabblock20.zip",
                        f"tl_2020_{fips}_tabblock20.shp")
        ids, _, land, shapes, crs = tiger_blocks(path, fips)
        if ids != bundle_ids(directory, manifest):
            raise ValueError(f"{state}: TIGER blocks differ from the bundle's block order")
        if not np.array_equal(np.asarray(land) == 0, water_only(directory, manifest, len(ids))):
            raise ValueError(f"{state}: TIGER land areas disagree with the water sidecar")
        county_fips = [county["fips"] for county in manifest["counties"]]
        county_of = np.searchsorted(county_fips, [key[:5] for key in ids])
        ref, packed = outlines_file(county_fips, county_of, land, shapes, crs)
        # Content-addressed, so writing it first is harmless; the manifest names it once checks pass.
        publish(directory, ref, packed)
        report = check_outlines(directory, dict(manifest, outlines=ref), ref)
        # Re-read just before writing so sidecars another command added meanwhile are kept.
        current = json.loads(manifest_path.read_bytes())
        if any(current.get(key) != manifest.get(key) for key in ("attrs", "water", "counties")):
            raise ValueError("Bundle changed while generating outlines (run: build.py outlines STATE)")
        if current.get("outlines") != ref:
            current["outlines"] = ref
            atomic_write(manifest_path, (json.dumps(current, indent=2) + "\n").encode())
    verb = "validated" if validate else "wrote"
    print(f"{state}: {verb} outlines {json.dumps(report)}", flush=True)
    return report
