"""Build the optional municipal membership sidecar from 2020 Census block assignments."""
import gzip
import json
import struct
from functools import lru_cache

import numpy as np

from format import atomic_write, file_matches, packed_file, publish
from inputs import CENSUS, ROOT, STATES, download, records, sha256, unique_rows

# Census identifies these MCDs as general-purpose local governments.
SUBDIVISION_STATES = frozenset("CT MA ME MI MN NH NJ NY PA RI VT WI".split())
GAZETTEER = f"{CENSUS}/geo/docs/maps-data/data/gazetteer/2020_Gazetteer"
BAF = f"{CENSUS}/geo/docs/maps-data/data/baf2020"


@lru_cache(maxsize=3)
def gazetteer(geography):
    name = f"2020_Gaz_{geography}_national"
    url = f"{GAZETTEER}/{name}.zip"
    path = download(url, f"{name}.txt")
    with records(path, f"{name}.txt", "\t") as rows:
        units = unique_rows((row["GEOID"], (None if geography == "counties" else row["FUNCSTAT"],
                                          row["NAME"].strip())) for row in rows)
    return units, dict(url=url, sha256=sha256(path))


def town_file(state, ids):
    fips = STATES[state]
    is_subdivision = state in SUBDIVISION_STATES
    url = f"{BAF}/BlockAssign_ST{fips}_{state}.zip"
    suffix = "_MCD.txt" if is_subdivision else "_INCPLACE_CDP.txt"
    baf = download(url, suffix)
    sources = {"townBaf": dict(url=url, sha256=sha256(baf))}
    places, sources["townPlaces"] = gazetteer("place")
    if is_subdivision:
        subdivisions, sources["townSubdivisions"] = gazetteer("cousubs")
        with records(baf, suffix, "|") as rows:
            membership = unique_rows((r["BLOCKID"], fips + r["COUNTYFP"] + r["COUSUBFP"]) for r in rows)
        kind = "county-subdivision"
        def town(code):
            status = subdivisions[code][0]
            if status in {"A", "B", "C", "G"}:
                return code
            # Independent incorporated places appear as statistical MCD equivalents.
            # Use their state-wide place key so a city spanning counties has one ID.
            place = fips + code[-5:]
            if status == "F" and code[-5:] != "00000" and place in places and places[place][0] != "S":
                return place
            return ""
    else:
        with records(baf, suffix, "|") as rows:
            membership = unique_rows((r["BLOCKID"], fips + r["PLACEFP"] if r["PLACEFP"] else "") for r in rows)
        kind = "incorporated-place"
        def town(code):
            return code if code and places[code][0] != "S" else ""
    if membership.keys() != set(ids):
        missing = sorted(set(ids) - membership.keys())
        extra = sorted(membership.keys() - set(ids))
        raise ValueError(f"{state} town BAF block mismatch: missing={missing[:8]}, extra={extra[:8]}")
    keys = [town(membership[block]) for block in ids]
    town_index = {key: i for i, key in enumerate(sorted(set(keys) - {""}), 1)}
    names = [""] + [
        (places if len(key) == 7 else subdivisions)[key][1] for key in town_index
    ]
    raw = np.fromiter((town_index.get(key, 0) for key in keys), dtype="<u4", count=len(ids)).tobytes()
    ref, packed = packed_file("towns.{hash}.bin.gz", raw)
    return dict(ref, count=len(town_index), kind=kind), packed, sources, len(ids) - keys.count(""), names


def bundle_block_order(directory, manifest):
    """Read only the header and GEOID deltas of the existing attributes."""
    ref = manifest["attrs"]
    path = directory / ref["file"]
    if not file_matches(path, ref):
        raise ValueError("Attributes failed integrity check")
    with gzip.open(path) as stream:
        magic, size = struct.unpack("<4sI", stream.read(8))
        if magic != b"ZDB1":
            raise ValueError("Invalid bundle attributes magic")
        header = json.loads(stream.read(size))
        n = header["n"]
        if n != sum(county["features"] for county in manifest["counties"]):
            raise ValueError("Attributes and county counts disagree")
        stream.read(-size % 8)
        deltas = np.frombuffer(stream.read(8 * n), dtype="<u8")
    if len(deltas) != n or np.any(deltas == 0):
        raise ValueError("Invalid bundle GEOID deltas")
    return [f"{geoid:015d}" for geoid in np.cumsum(deltas)], header["countyFips"]


def bundle_ids(directory, manifest):
    ids, _ = bundle_block_order(directory, manifest)
    return ids


def validate_towns(directory, manifest, ref, sources):
    path = directory / ref["file"]
    if (manifest.get("towns") != ref or not file_matches(path, ref)
            or any(manifest["sources"].get(key) != value for key, value in sources.items())):
        raise ValueError("Town sidecar or sources differ (run: build.py towns STATE)")


def towns_for_bundle(state, validate):
    directory = ROOT.parent / "data" / state
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    if manifest["state"] != state or manifest["stateFips"] != STATES[state] or manifest["format"] != 1:
        raise ValueError(f"Invalid {state} manifest")
    ids = bundle_ids(directory, manifest)
    ref, packed, sources, assigned, _ = town_file(state, ids)
    if validate:
        validate_towns(directory, manifest, ref, sources)
    else:
        publish(directory, ref, packed)
        manifest["towns"] = ref
        manifest["sources"].update(sources)
        data = (json.dumps(manifest, indent=2) + "\n").encode()
        if manifest_path.read_bytes() != data:
            atomic_write(manifest_path, data)
    verb = "validated" if validate else "wrote"
    print(f"{state}: {verb} {ref['count']} {ref['kind']} units covering {assigned}/{len(ids)} blocks "
          f"({ref['bytes']} compressed bytes)", flush=True)
