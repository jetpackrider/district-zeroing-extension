"""Build or independently audit local state bundles."""
import argparse
import gzip
import json
from pathlib import Path
import re
import resource
import sys
import time
import traceback

import numpy as np
import shapely

from adjacency import corner_audit, nearest, project, rook, rook_partitioned
from format import atomic_write, attrs_file, check_county, file_matches, geometry_files, packed_file, publish
from inputs import (ROOT, STATES, BLOCK_GROUP_STATES, fixture_text, get_inputs, tiger_land,
                    populations, precinct_membership, reference_graph, tiger_blocks)

from towns import town_file, towns_for_bundle, validate_towns

EXTERIOR = "OUT_OF_STATE"


def compare(label, expected, actual):
    missing = sorted(expected.keys() - actual.keys())
    extra = sorted(actual.keys() - expected.keys())
    unequal = sorted((key, value, actual[key]) for key, value in expected.items()
                     if key in actual and value != actual[key])
    result = dict(missing=len(missing), extra=len(extra), unequal=len(unequal),
                  missingExamples=missing[:8], extraExamples=extra[:8], unequalExamples=unequal[:8])
    print(f"{label}: {json.dumps(result)}")
    return result


def compare_sets(label, expected, actual):
    return compare(label, dict.fromkeys(expected), dict.fromkeys(actual))


def exact(result):
    return not any(result[key] for key in ("missing", "extra", "unequal"))


def block_populations(paths, ids, census, audit):
    block, block_has_adjusted = populations(paths["blocks"])
    audit["counts"]["blockAdjustedColumn"] = block_has_adjusted
    audit["blockCsv"] = compare("DRA block CSV vs TIGER POP20", {key: values[0] for key, values in block.items()},
                                dict(zip(ids, census.tolist(), strict=True)))
    if audit["blockCsv"]["extra"]:
        raise ValueError("TIGER has blocks without DRA population rows (see blockCsv.extra)")
    return np.array([block[key] for key in ids], dtype=np.int64)


def precinct_edges(edges, membership):
    return {tuple(sorted((membership[a], membership[b]))) for a, b in edges if membership[a] != membership[b]}


def graph_audit(reference, ids, membership, edges, projected, isolated):
    expected = {edge for edge in reference if EXTERIOR not in edge}
    rook_precinct = precinct_edges(edges, membership)
    rook_audit = compare_sets("Precinct graph, rook only", expected, rook_precinct)

    groups = {}
    for i, key in enumerate(membership):
        groups.setdefault(key, []).append(i)
    manual = []
    # The public reference describes precinct edges only. Infer endpoints for its
    # non-rook links deterministically, using the closest polygons in each pair.
    for p, q in sorted(expected - rook_precinct):
        if p not in groups or q not in groups:
            continue
        a = np.asarray(groups[p])
        b = np.asarray(groups[q])
        tree = shapely.STRtree(projected[b])
        (src, dst), distances = tree.query_nearest(projected[a], return_distance=True)
        distance, i, j = min(zip(distances, a[src].tolist(), b[dst].tolist(), strict=True))
        edges[tuple(sorted((i, j)))] = 0
        manual.append(dict(precincts=[p, q], blocks=[ids[i], ids[j]], distanceM=round(float(distance), 3)))
    print(f"Reference non-rook precinct links lifted to blocks: {len(manual)} {json.dumps(manual[:8])}")

    bridges = []
    links = nearest(shapely.STRtree(projected), projected, isolated) if len(isolated) else {}
    for a, b in sorted(links.items()):
        edge = tuple(sorted((a, b)))
        if edge not in edges:
            edges[edge] = 0
            bridges.append([ids[a], ids[b]])
    print(f"Nearest-block bridges added: {len(bridges)} {bridges[:8]}")
    actual = precinct_edges(edges, membership)
    return dict(rook=rook_audit, manualLinks=manual, bridges=bridges,
                inState=compare_sets("Final in-state precinct graph", expected, actual),
                full=compare_sets("Full published DRA graph (includes OUT_OF_STATE)", reference, actual))


def state_version(state):
    return "v06" if state == "DC" else "v08"


def same_sources(built, current):
    # Older builds record the local filename of the same ZIP instead of its URL.
    if built == current:
        return True
    built = dict(built)
    current = dict(current)
    before, after = built.pop("blocks", {}), current.pop("blocks", {})
    if "url" in before and "file" in after:
        before, after = after, before
    return (built == current and "file" in before and "url" in after
            and before["file"] == Path(after["url"]).name and before["sha256"] == after["sha256"])


def water_file(land):
    """One byte per block, 1 where the block has no land (ALAND20 == 0). A sidecar to the attributes
    file, so the engine can tell contiguity over open water from contiguity over land."""
    return packed_file("water.{hash}.bin.gz", (np.asarray(land) == 0).astype(np.uint8).tobytes())


def add_water(state):
    """Write the water sidecar for an already-built state and reference it from the manifest."""
    out = ROOT.parent / "data" / state
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    paths, _ = get_inputs(state, manifest["draDataVersion"], None)
    ids, land = tiger_land(paths["tiger"])
    blocks = sum(ref["features"] for ref in manifest["counties"])
    if len(ids) != blocks or any(not key.startswith(STATES[state]) for key in (ids[0], ids[-1])):
        raise ValueError(f"{state}: TIGER has {len(ids)} blocks, the bundle has {blocks}")
    ref, packed = water_file(land)
    publish(out, ref, packed)
    if manifest.get("water") != ref:
        manifest["water"] = ref
        atomic_write(manifest_path, (json.dumps(manifest, indent=2) + "\n").encode())
    print(f"{state}: {int(np.count_nonzero(land == 0))} water-only of {len(ids)} blocks -> {ref['file']} ({ref['bytes']} bytes)")


def run_state(command, state, version, local_blocks, out, audit):
    paths, provenance = get_inputs(state, version, local_blocks)
    ids, census, land, shapes, crs = tiger_blocks(paths["tiger"], STATES[state])
    counties, county_of = np.unique([key[:5] for key in ids], return_inverse=True)
    measured = audit["counts"]
    measured.update(blocks=len(ids), counties=len(counties),
                    zeroPopulation=int(np.count_nonzero(census == 0)), waterOnly=int(np.count_nonzero(land == 0)))
    print(f"TIGER: {json.dumps(measured)}")
    fixture, districts, unassigned = fixture_text(paths["fixture"], state, provenance["fixture"]["sha256"], ids)
    audit["cd119Districts"] = districts
    if unassigned:
        audit["cd119Unassigned"] = dict(blocks=len(unassigned), censusPopulation=int(census[unassigned].sum()),
                                       examples=[ids[i] for i in unassigned[:8]])
        print(f"CD119 unassigned (Census ZZ): {json.dumps(audit['cd119Unassigned'])}")
    if fixture is not None:
        fixture_file = out / "fixtures" / "cd119.csv"
        data = fixture.encode()
        if command == "build":
            fixture_file.parent.mkdir(exist_ok=True)
            if not fixture_file.is_file() or fixture_file.read_bytes() != data:
                atomic_write(fixture_file, data)
        elif not fixture_file.is_file() or fixture_file.read_bytes() != data:
            raise ValueError("Existing CD119 fixture differs from the official BEF")
        print(f"CD119 fixture: {len(ids) - len(unassigned)} assigned blocks in {districts} districts")
    pop = block_populations(paths, ids, census, audit)
    totals, has_adjusted = populations(paths["precincts"])
    measured["precinctAdjustedColumn"] = has_adjusted
    reference_ids, reference = reference_graph(paths["graph"])
    membership, audit["membership"] = precinct_membership(state, paths, ids)
    if state == "FL":
        from florida import overlay_precincts
        audit["florida"] = overlay_precincts(paths["precinctShapes"], ids, membership, shapes, crs)
    start = time.monotonic()
    projected = project(shapes, crs)
    edges, outer = rook(projected) if state == "NY" else rook_partitioned(projected, county_of)
    degree = np.bincount(np.asarray(list(edges), dtype=np.uint32).ravel(), minlength=len(ids))
    isolated = np.flatnonzero(degree == 0)
    measured.update(rookPairs=len(edges), isolatedRookBlocks=len(isolated), isolatedGeoids=[ids[i] for i in isolated])
    print(f"Rook hashing and projection: {time.monotonic() - start:.2f}s, {len(edges)} pairs, "
          f"{len(isolated)} isolated blocks {[ids[i] for i in isolated[:20]]}")
    precincts, precinct_of = np.unique(membership, return_inverse=True)
    measured["precincts"] = len(precincts)
    audit["precinctIds"] = compare_sets("Census assignment vs DRA precinct IDs",
                                        reference_ids - {EXTERIOR}, set(precincts) - {EXTERIOR})
    water_pop = np.flatnonzero((land == 0) & np.any(pop != 0, axis=1))
    negative_adjusted = np.flatnonzero(pop[:, 1] < 0)
    measured.update(waterWithNonzeroPopulation=len(water_pop), negativeAdjustedBlocks=len(negative_adjusted))
    for label, indices in [("Water-only blocks with recorded nonzero population", water_pop),
                           ("Blocks with negative adjusted population", negative_adjusted)]:
        print(f"{label}: {len(indices)} {[(ids[i], pop[i].tolist()) for i in indices[:8]]}")
    sums = np.zeros((len(precincts), 2), dtype=np.int64)
    np.add.at(sums, precinct_of, pop)
    audit["precinctPopulations"] = compare("DRA precinct population (D20F, D20FA)", totals,
                                           dict(zip(precincts, map(tuple, sums.tolist()), strict=True)))
    measured.update(d20f=int(pop[:, 0].sum()), d20fa=int(pop[:, 1].sum()),
                    adjustedBlocks=int(np.count_nonzero(pop[:, 0] != pop[:, 1])))
    print(f"Population totals: D20F={measured['d20f']}, D20FA={measured['d20fa']}, "
          f"adjusted blocks={measured['adjustedBlocks']}")
    if command == "validate":
        corners, missed, examples = corner_audit(shapes, edges, ids)
        measured.update(cornerOnlyPairs=corners, unhashedRookTouches=missed, unhashedRookExamples=examples)
        print(f"Corner-only pairs={corners}, unhashed line touches={missed}")
    audit["graph"] = graph_audit(reference, ids, membership, edges, projected, isolated)
    attr_ref, packed = attrs_file(ids, pop, counties.tolist(), county_of, precincts.tolist(), precinct_of,
                                 edges, outer, shapely.area(projected))
    del projected, edges

    manifest_path = out / "manifest.json"
    water_ref, water_packed = water_file(land)
    town_ref, town_packed, town_sources, town_assigned = town_file(state, ids)
    provenance.update(town_sources)
    measured.update(towns=town_ref["count"], townBlocks=town_assigned)
    if command == "build":
        publish(out, attr_ref, packed)
        publish(out, water_ref, water_packed)
        publish(out, town_ref, town_packed)
        print(f"Attributes available: {attr_ref['bytes']} bytes ({attr_ref['file']})")
        manifest = dict(format=1, state=state, stateFips=STATES[state],
                        censusVintage="2020 (January 2023 TABBLOCK20 re-release)",
                        draDataVersion=version, precinctKind="bg" if state in BLOCK_GROUP_STATES else "vtd",
                        attribution="Contains adapted Dave's Redistricting data (https://github.com/dra2020/vtd_data), "
                                    "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Do not sell. "
                                    "U.S. Census Bureau data are public domain. "
                                    "Block data credit: https://github.com/dra2020/block_data.",
                        sources=provenance, attrs=attr_ref, water=water_ref, towns=town_ref, counties=[])
        manifest["counties"] = list(geometry_files(out, counties, county_of, ids, shapes, crs))
        atomic_write(manifest_path, (json.dumps(manifest, indent=2) + "\n").encode())
    else:
        manifest = json.loads(manifest_path.read_bytes())
        if manifest["attrs"] != attr_ref or not file_matches(out / attr_ref["file"], attr_ref):
            raise ValueError("Built attributes differ from recomputed attributes or their hash")
        if manifest.get("water") != water_ref or not file_matches(out / water_ref["file"], water_ref):
            raise ValueError("Water sidecar is missing or differs (run: build.py water STATE)")
        validate_towns(out, manifest, town_ref, town_sources)
        if not same_sources(manifest["sources"], provenance) or manifest["draDataVersion"] != version:
            raise ValueError("Built manifest uses different inputs or a different DRA version")
        if [ref["fips"] for ref in manifest["counties"]] != counties.tolist():
            raise ValueError("Built manifest lists a different set of counties")
        for i, ref in enumerate(manifest["counties"]):
            file = out / ref["file"]
            selected_ids = [ids[index] for index in np.flatnonzero(county_of == i)]
            if ref["features"] != len(selected_ids) or not file_matches(file, ref):
                raise ValueError(f"County {ref['fips']} feature count or hash differs")
            check_county(gzip.decompress(file.read_bytes()), selected_ids)

    audit["bundle"] = dict(attrsBytes=attr_ref["bytes"],
                           countyBytes=sum(ref["bytes"] for ref in manifest["counties"]),
                           countyFeatures=sum(ref["features"] for ref in manifest["counties"]))
    print(f"Bundle files: {json.dumps(audit['bundle'])}")
    if command == "validate":
        return int(not exact(audit["blockCsv"]) or not exact(audit["precinctIds"])
                   or not exact(audit["precinctPopulations"])
                   or has_adjusted != measured["blockAdjustedColumn"]
                   # "full" also lists DRA's OUT_OF_STATE edges, which have no block in a one-state bundle.
                   or not exact(audit["graph"]["inState"])
                   or measured["unhashedRookTouches"] != 0)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "validate", "all", "water", "towns", "validate-towns"])
    parser.add_argument("states", type=str.upper, nargs="*", metavar="STATE")
    parser.add_argument("--version")
    parser.add_argument("--dra-blocks", type=Path, help="Local DRA demographic CSV or ZIP")
    parser.add_argument("--revalidate", action="store_true", help="Run strict checks again on previously passed bundles")
    args = parser.parse_intermixed_args()
    if any(state not in STATES for state in args.states):
        parser.error("Use two-letter state or DC codes")
    if args.version and re.fullmatch(r"v[0-9]+", args.version) is None:
        parser.error("--version must be a value such as v08")
    if args.command == "water":
        for state in args.states or STATES:
            add_water(state)
        return 0
    if args.command in {"towns", "validate-towns"}:
        if args.version or args.dra_blocks or args.revalidate:
            parser.error("Town commands use the existing bundle and 2020 Census inputs")
        for state in dict.fromkeys(args.states or STATES):
            towns_for_bundle(state, validate=args.command == "validate-towns")
        return 0
    if args.command == "all":
        if args.dra_blocks or args.version:
            parser.error("Input overrides apply to single-state commands")
        from batch import run_batch
        return run_batch(args.states or STATES, args.revalidate)
    if len(args.states) != 1 or args.revalidate:
        parser.error("Specify one state for build or validate")
    state, = args.states
    version = args.version or state_version(state)
    out = ROOT.parent / "data" / state
    out.mkdir(parents=True, exist_ok=True)
    report = out / ("validation.json" if args.command == "validate" else "build-audit.json")
    audit = dict(state=state, draDataVersion=version,
                 precinctKind="bg" if state in BLOCK_GROUP_STATES else "vtd", counts={})
    start = time.monotonic()
    code = 2
    try:
        code = run_state(args.command, state, version, args.dra_blocks, out, audit)
        return code
    except Exception as error:
        audit["error"] = f"{type(error).__name__}: {error}"
        traceback.print_exc()
        return code
    finally:
        factor = 1 if sys.platform == "darwin" else 1024
        audit.update(seconds=round(time.monotonic() - start, 3), exitCode=code,
                     peakPythonRSSBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * factor,
                     peakChildRSSBytes=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * factor)
        atomic_write(report, (json.dumps(audit, indent=2) + "\n").encode())


if __name__ == "__main__":
    raise SystemExit(main())
