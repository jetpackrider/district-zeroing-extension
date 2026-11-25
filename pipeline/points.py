"""Build and check the optional block points sidecar: one point inside each block.

The point is the Census internal point of the TABBLOCK20 polygon (INTPTLON20 / INTPTLAT20). The
extension tests these points against an area the user marks on the map, so it can tell which
blocks are inside without loading block shapes. See docs/BUNDLE_FORMAT.md, "Points sidecar".
"""
from fractions import Fraction
import gzip
import json

import numpy as np
from pyogrio.raw import read
import shapely

from format import atomic_write, file_matches, packed_file, publish
from inputs import CENSUS, ROOT, STATES, download

# Millionths of a degree per degree. Census publishes the points with 7 decimals (about 1 cm), so
# rounding to 6 (about 11 cm) is far finer than any area a user draws.
MICRO = 10**6
# Every point must lie in the bounding box of its county's outline in the county geometry file,
# widened by this many microdegrees (0.02 degree, about 2 km): the files are simplified, so their
# outline can cut slightly inside the true county.
BOX_MARGIN = 20_000
# Blocks per state (a fixed pseudo-random sample) whose point is tested against the block's polygon.
SAMPLE = 2000
# Against the unsimplified TIGER polygon the Census guarantees the point is inside; allow only the
# rounding to microdegrees (half a microdegree on each axis).
ROUNDING_DEGREES = 1e-6
# Against the simplified polygon in the county geometry file (what the extension draws), 7% mapshaper
# simplification shaves thin and coastal blocks, so across all 51 states up to 5.5% of sampled points
# fell just outside, at most 1.2 km away (Alaska). Those numbers bound gross errors only: a wrong block
# order, swapped axes or wrong units would put nearly every point far outside.
SIMPLIFIED_INSIDE_SHARE = 0.9
SIMPLIFIED_NEAR_METERS = 2000


def microdegrees(text):
    """'+38.8850159' -> 38885016: exact decimal arithmetic, rounded half to even."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError(f"Missing internal point coordinate {text!r}")
    return round(Fraction(text.strip()) * MICRO)


def tiger_points(path, fips):
    """Sorted block GEOIDs, their Census internal points as an (n, 2) int64 array of lon, lat
    microdegrees, and each sorted block's feature id (row) in the shapefile."""
    meta, _, _, values = read(f"zip://{path}", columns=["GEOID20", "INTPTLON20", "INTPTLAT20"],
                              read_geometry=False)
    # pyogrio returns columns in file order, not request order.
    columns = dict(zip(meta["fields"], values, strict=True))
    order = np.argsort(columns["GEOID20"])
    ids = columns["GEOID20"][order].tolist()
    if any(not key.startswith(fips) for key in (ids[0], ids[-1])) or len(set(ids)) != len(ids):
        raise ValueError("Invalid or duplicate TIGER block GEOID")
    lon = [microdegrees(text) for text in columns["INTPTLON20"][order]]
    lat = [microdegrees(text) for text in columns["INTPTLAT20"][order]]
    return ids, np.column_stack([np.asarray(lon, dtype=np.int64), np.asarray(lat, dtype=np.int64)]), order


def points_file(points):
    """2n little-endian Int32 in block order: lon, lat, lon, lat, ... in microdegrees."""
    points = np.asarray(points, dtype=np.int64)
    if (points.ndim != 2 or points.shape[1] != 2 or np.any(np.abs(points[:, 0]) > 180 * MICRO)
            or np.any(np.abs(points[:, 1]) > 90 * MICRO)):
        raise ValueError("Block points exceed longitude/latitude bounds")
    return packed_file("points.{hash}.bin.gz", points.astype("<i4").tobytes())


def decode_arcs(topology):
    """All arcs of a quantized TopoJSON topology as float lon/lat arrays."""
    scale = np.asarray(topology["transform"]["scale"], dtype=np.float64)
    translate = np.asarray(topology["transform"]["translate"], dtype=np.float64)
    lengths = np.fromiter((len(arc) for arc in topology["arcs"]), dtype=np.int64, count=len(topology["arcs"]))
    deltas = np.fromiter((v for arc in topology["arcs"] for point in arc for v in point[:2]),
                         dtype=np.int64, count=2 * int(lengths.sum())).reshape(-1, 2)
    # Prefix-sum each arc's deltas from zero: a global cumulative sum minus the sum before the arc.
    total = np.cumsum(deltas, axis=0)
    starts = np.r_[0, np.cumsum(lengths)[:-1]]
    before = np.zeros_like(total)
    before[1:] = total[:-1]
    offsets = np.repeat(before[starts], lengths, axis=0)
    coords = (total - offsets) * scale + translate
    return np.split(coords, np.cumsum(lengths)[:-1])


def ring(arcs, refs):
    """Join a ring's arcs (negative reference r = arc ~r reversed) without repeating shared endpoints."""
    parts = []
    for i, ref in enumerate(refs):
        arc = arcs[ref] if ref >= 0 else arcs[~ref][::-1]
        parts.append(arc if i == 0 else arc[1:])
    return np.concatenate(parts)


def shape(arcs, geometry):
    polygons = geometry["arcs"] if geometry["type"] == "MultiPolygon" else [geometry["arcs"]]
    return shapely.MultiPolygon([shapely.Polygon(ring(arcs, rings[0]), [ring(arcs, r) for r in rings[1:]])
                                 for rings in polygons])


def check_points(directory, manifest, ref, ids, points, state, tiger):
    """Raise unless the manifest's points entry is this exact file and its points are plausible.

    `points` are the internal points recomputed from TIGER, and `tiger` is (shapefile ZIP, feature id
    of each block) from bundle_points. Checks: manifest entry, size and hash, exact length, equality
    with TIGER, coordinate ranges, every point inside its county's box from the county geometry
    file, and a sample of points inside their block polygon (unsimplified TIGER and simplified
    county file). Returns a small report for logs and audits."""
    path = directory / ref["file"]
    if manifest.get("points") != ref or not file_matches(path, ref):
        raise ValueError("Points sidecar is missing or differs (run: build.py points STATE)")
    raw = gzip.decompress(path.read_bytes())
    n = sum(county["features"] for county in manifest["counties"])
    if len(raw) != 8 * n or len(ids) != n:
        raise ValueError(f"Points sidecar has {len(raw)} bytes, expected {8 * n} for {n} blocks")
    stored = np.frombuffer(raw, dtype="<i4").reshape(n, 2).astype(np.int64)
    if not np.array_equal(stored, points):
        raise ValueError("Points sidecar differs from the TIGER internal points")
    if np.any(np.abs(stored[:, 0]) > 180 * MICRO) or np.any(np.abs(stored[:, 1]) > 90 * MICRO):
        raise ValueError("Points sidecar has a coordinate outside longitude/latitude range")

    # Each county geometry file gives an independent outline: its points must fall in that county's
    # box (plus a margin), so a point in the wrong place, swapped axes or a shifted order shows up.
    county_of = np.searchsorted([county["fips"] for county in manifest["counties"]], [key[:5] for key in ids])
    rng = np.random.default_rng(int(STATES[state]))
    sample = np.sort(rng.choice(n, size=min(SAMPLE, n), replace=False))
    state_box = [np.inf, np.inf, -np.inf, -np.inf]
    shapes, sampled = [], []
    for index, county in enumerate(manifest["counties"]):
        topology = json.loads(gzip.decompress((directory / county["file"]).read_bytes()))
        arcs = decode_arcs(topology)
        coords = np.concatenate(arcs)
        low = np.rint(coords.min(axis=0) * MICRO) - BOX_MARGIN
        high = np.rint(coords.max(axis=0) * MICRO) + BOX_MARGIN
        state_box = [min(state_box[0], low[0]), min(state_box[1], low[1]),
                     max(state_box[2], high[0]), max(state_box[3], high[1])]
        mine = np.flatnonzero(county_of == index)
        inside = np.all((stored[mine] >= low) & (stored[mine] <= high), axis=1)
        if not inside.all():
            bad = mine[~inside][:5]
            raise ValueError(f"County {county['fips']}: {int((~inside).sum())} points outside its box, "
                             f"e.g. {[(ids[i], stored[i].tolist()) for i in bad]}")
        picked = sample[county_of[sample] == index]
        if len(picked):
            (geometries,) = topology["objects"].values()
            by_id = {g["id"]: g for g in geometries["geometries"]}
            shapes.extend(shape(arcs, by_id[ids[i]]) for i in picked)
            sampled.extend(picked.tolist())
    sampled = np.asarray(sampled)
    xy = stored[sampled] / MICRO
    probes = shapely.points(xy[:, 0], xy[:, 1])

    # The same blocks' unsimplified polygons, read by feature id (NAD83 lon/lat, the datum of the points).
    path, fids = tiger
    _, _, wkb, (geoids,) = read(f"zip://{path}", fids=np.asarray(fids)[sampled], columns=["GEOID20"])
    exact = dict(zip(geoids.tolist(), shapely.from_wkb(wkb), strict=True))
    true_shapes = np.asarray([exact[ids[i]] for i in sampled])
    off = np.flatnonzero(shapely.distance(true_shapes, probes) > ROUNDING_DEGREES)
    if len(off):
        raise ValueError(f"{len(off)} of {len(sampled)} sampled points lie outside their TIGER block polygon, "
                         f"e.g. {[ids[sampled[i]] for i in off[:5]]}")

    polygons = np.asarray(shapes)
    outside = np.flatnonzero(~shapely.covers(polygons, probes))
    farthest = 0.0
    if len(outside):
        from pyproj import Transformer
        project = Transformer.from_crs(4326, 5070, always_xy=True).transform
        meters = shapely.distance(shapely.transform(polygons[outside], project, interleaved=False),
                                  shapely.transform(probes[outside], project, interleaved=False))
        farthest = float(meters.max())
        if farthest > SIMPLIFIED_NEAR_METERS or len(outside) > (1 - SIMPLIFIED_INSIDE_SHARE) * len(sampled):
            examples = [(ids[sampled[i]], round(float(d), 1)) for i, d in zip(outside, meters)][:5]
            raise ValueError(f"{len(outside)} of {len(sampled)} sampled points lie outside their simplified "
                             f"block polygon (farthest {farthest:.1f} m), e.g. {examples}")
    return dict(blocks=n, sampled=len(sampled), sampledOutsideSimplified=len(outside),
                farthestOutsideSimplifiedM=round(farthest, 1), box=[int(v) for v in state_box])


def bundle_points(state, ids):
    """The state's TIGER internal points, checked against the bundle's block order, and the
    (shapefile ZIP, feature ids) check_points needs."""
    fips = STATES[state]
    path = download(f"{CENSUS}/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_{fips}_tabblock20.zip",
                    f"tl_2020_{fips}_tabblock20.shp")
    tiger_ids, points, fids = tiger_points(path, fips)
    if tiger_ids != ids:
        raise ValueError(f"{state}: TIGER has {len(tiger_ids)} blocks in a different order from the bundle's {len(ids)}")
    return points, (path, fids)


def points_for_bundle(state, validate):
    """Add the points sidecar to an already-built state (or, with validate, check it)."""
    from towns import bundle_ids
    directory = ROOT.parent / "data" / state
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    if manifest["state"] != state or manifest["stateFips"] != STATES[state] or manifest["format"] != 1:
        raise ValueError(f"Invalid {state} manifest")
    ids = bundle_ids(directory, manifest)
    points, tiger = bundle_points(state, ids)
    ref, packed = points_file(points)
    if validate:
        report = check_points(directory, manifest, ref, ids, points, state, tiger)
    else:
        # The file is content-addressed, so writing it first is harmless; the manifest names it only
        # once the checks pass.
        publish(directory, ref, packed)
        manifest["points"] = ref
        report = check_points(directory, manifest, ref, ids, points, state, tiger)
        data = (json.dumps(manifest, indent=2) + "\n").encode()
        if manifest_path.read_bytes() != data:
            atomic_write(manifest_path, data)
    verb = "validated" if validate else "wrote"
    print(f"{state}: {verb} {len(ids)} block points -> {ref['file']} ({ref['bytes']} bytes); "
          f"all {report['sampled']} sampled points inside their TIGER polygon, "
          f"{report['sampledOutsideSimplified']} outside the simplified one "
          f"(farthest {report['farthestOutsideSimplifiedM']} m)", flush=True)
    return dict(report, bytes=ref["bytes"])
