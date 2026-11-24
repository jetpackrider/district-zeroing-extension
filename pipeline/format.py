"""Encode the wire format defined in docs/BUNDLE_FORMAT.md."""
import gzip
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile

import numpy as np
from pyproj import Transformer
import shapely

from inputs import CACHE, ROOT, sha256


def packed_file(name, raw):
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    digest = hashlib.sha256(packed).hexdigest()
    return {"file": name.replace("{hash}", digest), "sha256": digest, "bytes": len(packed)}, packed


def publish(out, ref, packed):
    path = out / ref["file"]
    if path.exists() and file_matches(path, ref):
        return
    atomic_write(path, packed)


def atomic_write(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(data)
            stream.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def file_matches(path, ref):
    return path.is_file() and path.stat().st_size == ref["bytes"] and sha256(path) == ref["sha256"]


def attrs_file(ids, pop, counties, county_of, precincts, precinct_of, edges, outer, area):
    a, b = np.asarray(list(edges), dtype=np.uint32).reshape(-1, 2).T
    lengths = np.fromiter(edges.values(), dtype=np.float64)
    src, dst = np.r_[a, b], np.r_[b, a]
    order = np.lexsort((dst, src))
    degrees = np.bincount(src, minlength=len(ids))
    header = json.dumps(dict(n=len(ids), m=len(dst), countyFips=counties, precinctIds=precincts),
                        separators=(",", ":")).encode("utf-8")
    raw = bytearray(struct.pack("<4sI", b"ZDB1", len(header)) + header + bytes(-len(header) % 8))
    geoids = np.asarray(ids, dtype=np.uint64)
    # Predictors are reversible. Nearby rows typically have small GEOID and block-index deltas.
    geoid_deltas = np.diff(geoids, prepend=np.uint64(0))
    targets = dst[order].astype(np.int64) - src[order]
    adjusted_deltas = pop[:, 1] - pop[:, 0]
    if (len(ids) > 2**31 or len(dst) >= 2**32 or np.any(pop[:, 0] < 0)
            or np.any(pop >= 2**31) or np.any(pop < -2**31) or np.any(adjusted_deltas < -2**31)
            or np.any(outer >= 2**32 - 0.5) or not np.all(np.isfinite(area) & (area >= 0))):
        raise ValueError("Attributes exceed wire-format bounds")
    # Preserve the positive/zero distinction even for shared borders under half a meter.
    meters = np.where(lengths > 0, np.rint(lengths).clip(1, 65535), 0)
    sections = [
        (geoid_deltas, "<u8"), (pop[:, 0], "<i4"), (adjusted_deltas, "<i4"),
        (county_of, "<u2"), (precinct_of, "<u4"), (degrees, "<u4"), (targets, "<i4"),
        (np.r_[meters, meters][order], "<u2"), (np.rint(outer), "<u4"), (area, "<f4"),
    ]
    for values, dtype in sections:
        raw.extend(bytes(-len(raw) % np.dtype(dtype).itemsize))
        raw.extend(np.asarray(values, dtype=dtype).tobytes())
    return packed_file("attrs.{hash}.bin.gz", raw)


def check_county(raw, county_ids):
    topology = json.loads(raw)
    blocks, = topology["objects"].values()
    if topology["type"] != "Topology" or blocks["type"] != "GeometryCollection":
        raise ValueError("Expected county TopoJSON topology and block geometry collection")
    actual = sorted(g["id"] for g in blocks["geometries"]
                    if g["type"] in ("Polygon", "MultiPolygon") and g.get("arcs")
                    and g.get("properties", {}).get("GEOID20") == g["id"])
    if actual != county_ids or len(blocks["geometries"]) != len(county_ids):
        raise ValueError(f"County {county_ids[0][:5]} geometry mismatch: "
                         f"expected {len(county_ids)}, found {len(actual)} matching block polygons")


def geometry_files(out, counties, county_of, ids, shapes, crs):
    mapshaper = ROOT / "node_modules/mapshaper"
    if not mapshaper.exists():
        raise RuntimeError("Install mapshaper first: npm ci --prefix pipeline")
    transformer = Transformer.from_crs(crs, 4326, always_xy=True)
    with (tempfile.TemporaryDirectory(dir=CACHE) as directory,
          subprocess.Popen(["node", "--max-old-space-size=2000", str(ROOT / "mapshaper-worker.cjs")],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as worker):
        source = Path(directory) / "blocks.geojson"
        target = Path(directory) / "blocks.topojson"
        for index, fips in enumerate(counties):
            selected = np.flatnonzero(county_of == index)
            county_ids = [ids[i] for i in selected]
            county_shapes = shapely.transform(shapes[selected], transformer.transform, interleaved=False)
            with source.open("w", encoding="utf-8") as stream:
                stream.write('{"type":"FeatureCollection","features":[')
                for i, (geoid, shape) in enumerate(zip(county_ids, shapely.to_geojson(county_shapes), strict=True)):
                    if i:
                        stream.write(",")
                    stream.write(f'{{"type":"Feature","properties":{{"GEOID20":"{geoid}"}},"geometry":{shape}}}')
                stream.write("]}")
            worker.stdin.write(json.dumps([str(source), str(target)]) + "\n")
            worker.stdin.flush()
            if worker.stdout.readline().strip() != "ok":
                raise RuntimeError(f"Mapshaper failed in county {fips}; see subprocess output")
            raw = target.read_bytes()
            check_county(raw, county_ids)
            ref, packed = packed_file(f"{fips}.{{hash}}.topo.json.gz", raw)
            publish(out, ref, packed)
            yield dict(fips=fips, features=len(county_ids), **ref)
        worker.stdin.close()
        if worker.wait():
            raise RuntimeError("Mapshaper did not exit cleanly")
