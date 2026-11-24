"""Match the Hillsborough and Lee County blocks to DRA's published precincts."""
from collections import Counter
import json

import numpy as np
from pyproj import Transformer
import shapely

from inputs import member


COUNTIES = {"12057", "12071"}


def overlay_precincts(path, ids, membership, shapes, crs):
    # v07 is the last public FL archive with precinct polygons. Its precinct
    # graph and keys match v08, which independently checks every aggregate.
    with member(path, ".geojson") as stream:
        features = json.load(stream)["features"]
    keys = []
    polygons = []
    for feature in features:
        key = feature["properties"]["id"]
        if key[:5] in COUNTIES:
            keys.append(key)
            polygons.append(shapely.from_geojson(json.dumps(feature["geometry"])))
    if len(keys) != len(set(keys)) or not polygons:
        raise ValueError("Duplicate or missing Florida precinct polygons")
    tree = shapely.STRtree(shapely.make_valid(polygons))
    indices = np.array([i for i, key in enumerate(ids) if key[:5] in COUNTIES])
    transformer = Transformer.from_crs(crs, 4326, always_xy=True)
    blocks = shapely.make_valid(shapely.transform(shapes[indices], transformer.transform, interleaved=False))

    # Point-in-polygon misclassifies narrow border blocks against rounded DRA
    # coordinates. Use the largest polygon overlap and audit the result.
    a, b = tree.query(blocks)
    coverage = shapely.area(shapely.intersection(blocks[a], tree.geometries[b]))
    best = {}
    for block, precinct, area in zip(a.tolist(), b.tolist(), coverage.tolist(), strict=True):
        if area > 0:
            best[block] = max(best.get(block, (0, "")), (area, keys[precinct]))
    missing = sorted(set(range(len(indices))) - best.keys())
    if missing:
        raise ValueError(f"Florida precinct overlay has {len(missing)} uncovered blocks: "
                         f"{[ids[indices[i]] for i in missing[:8]]}")
    changed = Counter()
    changed_parent = Counter()
    for i, index in enumerate(indices):
        _, key = best[i]
        original = membership[index]
        if key != original:
            changed[ids[index][:5]] += 1
            if key[:11] != original:
                changed_parent[ids[index][:5]] += 1
            membership[index] = key
    result = {
        "overlaidBlocks": len(indices),
        "changedBlocksByCounty": dict(changed),
        "changedParentVtdBlocksByCounty": dict(changed_parent),
        "suffixedPrecinctsByCounty": dict(Counter(key[:5] for key in keys if len(key) == 12)),
    }
    print(f"Florida precinct overlay: {json.dumps(result)}")
    return result
